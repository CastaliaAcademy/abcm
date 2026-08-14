import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteWorkspaceMapStore } from "../src/derived-store/sqlite-workspace-map-store.js";
import { DirectoryDocumentationSyncService } from "../src/documentation/directory-documentation-sync-service.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "abcm-cutover-workspace-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "abcm-cutover-source-"));
  roots.push(workspaceRoot, sourceRoot);
  await mkdir(join(workspaceRoot, "domain-language"));
  await writeFile(join(workspaceRoot, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await writeFile(join(workspaceRoot, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const registry = new WorkspaceRegistry([{ id: "test", root: workspaceRoot }]);
  const store = new SqliteWorkspaceMapStore(registry, { ownerId: "cutover-test" });
  const scopeMap = new ScopeMapService(registry, store, store);
  let documentation: DirectoryDocumentationSyncService | undefined;
  const files = new WorkspaceFileService(registry, {
    authorizeMutation: async (workspaceId, paths) => documentation?.authorizeMutation(workspaceId, paths),
  });
  documentation = new DirectoryDocumentationSyncService({
    registry,
    files,
    scopeMap,
    state: store,
    sources: [{ id: "docs", workspaceId: "test", root: sourceRoot, targetBasePath: "artifacts/docs" }],
  });
  return { workspaceRoot, sourceRoot, store, scopeMap, files, documentation };
}

const note = "---\nid: CUTOVER-1\nkind: note\ntitle: Cutover\n---\ncanonical\n";

describe("documentation cutover and recovery", () => {
  test("requires approval, validates the selected snapshot, and disables deletion propagation", async () => {
    const { workspaceRoot, sourceRoot, store, files, documentation } = await fixture();
    await writeFile(join(sourceRoot, "note.md"), note);
    const preview = await documentation.preview("test", "docs");
    await expect(documentation.cutover("docs", {
      operatorApproved: false,
      expectedSnapshotDigest: preview.snapshotDigest,
    } as unknown as { operatorApproved: true; expectedSnapshotDigest: string })).rejects.toMatchObject({ code: "CUTOVER_APPROVAL_REQUIRED" });
    await expect(documentation.cutover("docs", {
      operatorApproved: true,
      expectedSnapshotDigest: `sha256:${"0".repeat(64)}`,
    })).rejects.toMatchObject({ code: "CUTOVER_CHECKSUM_MISMATCH" });

    const result = await documentation.cutover("docs", {
      operatorApproved: true,
      expectedSnapshotDigest: preview.snapshotDigest,
    });
    expect(result).toEqual(expect.objectContaining({ status: "completed", storageMode: "managed", documentCount: 1 }));
    expect(store.getDocumentationSource("test", "docs")).toEqual(expect.objectContaining({ storageMode: "managed", status: "cutover" }));
    expect(store.listDocumentProvenance("test", "docs")).toEqual([
      expect.objectContaining({ sourcePath: "note.md", active: false }),
    ]);
    expect(store.getActive("test")?.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: "CUTOVER-1", storageMode: "managed" }),
    ]));

    await files.write("test", "artifacts/docs/note.md", new TextEncoder().encode("managed edit"));
    await rm(sourceRoot, { recursive: true });
    await expect(documentation.sync("docs")).rejects.toMatchObject({ code: "DOCUMENTATION_SOURCE_ALREADY_MANAGED" });
    expect(await readFile(join(workspaceRoot, "artifacts/docs/note.md"), "utf8")).toBe("managed edit");
    expect(await documentation.cutover("docs", {
      operatorApproved: true,
      expectedSnapshotDigest: preview.snapshotDigest,
    })).toEqual(result);
    store.close();
  });

  test("recovers a filesystem-complete sync after metadata commit failure", async () => {
    const { workspaceRoot, sourceRoot, store, documentation } = await fixture();
    await writeFile(join(sourceRoot, "note.md"), note);
    const preview = await documentation.preview("test", "docs");
    const original = store.commitDocumentationSync.bind(store);
    let fail = true;
    store.commitDocumentationSync = commit => {
      if (fail) { fail = false; throw new Error("injected metadata failure"); }
      original(commit);
    };
    await expect(documentation.apply(preview.importId)).rejects.toThrow("injected metadata failure");
    expect(await readFile(join(workspaceRoot, "artifacts/docs/note.md"), "utf8")).toBe(note);
    expect(store.getPendingDocumentationSync("test", "docs")).toBeDefined();
    expect(Buffer.from(await readFile(join(workspaceRoot, ".abcm", "abcm.sqlite"))).includes(Buffer.from("canonical"))).toBe(false);

    const recoveredPreview = await documentation.preview("test", "docs");
    expect(recoveredPreview.operations).toEqual([expect.objectContaining({ operation: "unchanged" })]);
    expect(store.getPendingDocumentationSync("test", "docs")).toBeUndefined();
    expect(store.listSyncRuns("test", "docs")).toHaveLength(1);
    expect(store.getActive("test")?.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: "CUTOVER-1", storageMode: "mirror" }),
    ]));
    store.close();
  });

  test("fails closed when source diverges from a pending sync journal", async () => {
    const { workspaceRoot, sourceRoot, store, documentation } = await fixture();
    await writeFile(join(sourceRoot, "note.md"), note);
    const preview = await documentation.preview("test", "docs");
    const original = store.commitDocumentationSync.bind(store);
    let fail = true;
    store.commitDocumentationSync = commit => {
      if (fail) { fail = false; throw new Error("injected metadata failure"); }
      original(commit);
    };
    await expect(documentation.apply(preview.importId)).rejects.toThrow("injected metadata failure");
    await writeFile(join(sourceRoot, "note.md"), `${note}changed\n`);

    await expect(documentation.preview("test", "docs")).rejects.toMatchObject({ code: "DOCUMENTATION_RECOVERY_REQUIRED" });
    expect(await readFile(join(workspaceRoot, "artifacts/docs/note.md"), "utf8")).toBe(note);
    expect(store.getPendingDocumentationSync("test", "docs")).toBeDefined();
    store.close();
  });

  test("finishes map publication after an atomic cutover commit fault", async () => {
    const { sourceRoot, store, scopeMap, documentation } = await fixture();
    await writeFile(join(sourceRoot, "note.md"), note);
    const preview = await documentation.preview("test", "docs");
    const originalScan = scopeMap.scan.bind(scopeMap);
    let injected = false;
    scopeMap.scan = async (workspaceId, signal) => {
      const state = store.getDocumentationSource("test", "docs");
      if (!injected && state?.storageMode === "managed") {
        injected = true;
        throw new Error("injected map publication failure");
      }
      return originalScan(workspaceId, signal);
    };
    await expect(documentation.cutover("docs", {
      operatorApproved: true,
      expectedSnapshotDigest: preview.snapshotDigest,
    })).rejects.toThrow("injected map publication failure");
    expect(store.getDocumentationCutover("test", "docs")).toEqual(expect.objectContaining({ status: "committed" }));
    expect(store.resolveDocumentStorage("test", "artifacts/docs/note.md")).toEqual({ storageMode: "managed" });

    const recovered = await documentation.cutover("docs", {
      operatorApproved: true,
      expectedSnapshotDigest: preview.snapshotDigest,
    });
    expect(recovered).toEqual(expect.objectContaining({ status: "completed", storageMode: "managed" }));
    expect(store.getActive("test")?.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: "CUTOVER-1", storageMode: "managed" }),
    ]));
    store.close();
  });
});
