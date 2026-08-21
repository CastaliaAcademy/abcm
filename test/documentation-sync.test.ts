import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteWorkspaceMapStore } from "../src/derived-store/sqlite-workspace-map-store.js";
import { DirectoryDocumentationSyncService } from "../src/documentation/directory-documentation-sync-service.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(reconcile = false) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "abcm-sync-workspace-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "abcm-sync-source-"));
  roots.push(workspaceRoot, sourceRoot);
  await mkdir(join(workspaceRoot, "domain-language"));
  await mkdir(join(workspaceRoot, "artifacts", "notes"), { recursive: true });
  await writeFile(join(workspaceRoot, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await writeFile(join(workspaceRoot, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const registry = new WorkspaceRegistry([{ id: "test", root: workspaceRoot }]);
  const store = new SqliteWorkspaceMapStore(registry, { ownerId: "documentation-test" });
  const scopeMap = new ScopeMapService(registry, store, store);
  let documentation: DirectoryDocumentationSyncService | undefined;
  const files = new WorkspaceFileService(registry, {
    onMutation: async workspaceId => void (await scopeMap.scan(workspaceId)),
    authorizeMutation: async (workspaceId, paths) => documentation?.authorizeMutation(workspaceId, paths),
  });
  documentation = new DirectoryDocumentationSyncService({
    registry,
    files,
    scopeMap,
    state: store,
    sources: [{
      id: "obsidian",
      workspaceId: "test",
      root: sourceRoot,
      targetBasePath: "artifacts/notes",
      ...(reconcile
        ? { reconciliation: { manifestPath: "config/documentation/obsidian.yaml", unmappedPolicy: "conflict" as const } }
        : {}),
    }],
  });
  return { workspaceRoot, sourceRoot, store, scopeMap, files, documentation };
}

const note = (body: string) => `---\nid: OBS-0001\nkind: note\ntitle: Obsidian note\n---\n${body}\n`;
const checksum = (body: string) => `sha256:${createHash("sha256").update(body).digest("hex")}`;

describe("DirectoryDocumentationSyncService", () => {
  test("previews without mutation, ignores Obsidian metadata and applies exact mirror bytes", async () => {
    const { workspaceRoot, sourceRoot, store, files, documentation } = await fixture();
    await writeFile(join(sourceRoot, "note.md"), note("version one"));
    await mkdir(join(sourceRoot, ".obsidian"));
    await writeFile(join(sourceRoot, ".obsidian", "workspace.json"), "secret settings");
    await writeFile(join(sourceRoot, "outside.md"), "plain linked target\n");
    await symlink(join(sourceRoot, "outside.md"), join(sourceRoot, "linked.md"));
    const sourceBefore = await readFile(join(sourceRoot, "note.md"));

    const preview = await documentation.preview("test", "obsidian");
    expect(preview.operations).toEqual([
      expect.objectContaining({ operation: "create", sourcePath: "note.md", targetPath: "artifacts/notes/note.md" }),
      expect.objectContaining({ operation: "create", sourcePath: "outside.md", targetPath: "artifacts/notes/outside.md" }),
    ]);
    expect(await Bun.file(join(workspaceRoot, "artifacts/notes/note.md")).exists()).toBe(false);
    expect(JSON.stringify(preview)).not.toContain("workspace.json");
    expect(JSON.stringify(preview)).not.toContain("linked.md");

    const result = await documentation.apply(preview.importId);
    expect(result).toEqual(expect.objectContaining({ created: 2, updated: 0, deleted: 0, conflicts: 0, status: "succeeded" }));
    expect(await readFile(join(workspaceRoot, "artifacts/notes/note.md"))).toEqual(sourceBefore);
    expect(await readFile(join(sourceRoot, "note.md"))).toEqual(sourceBefore);
    expect(store.listDocumentProvenance("test", "obsidian")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourcePath: "note.md", targetPath: "artifacts/notes/note.md", active: true }),
      ]),
    );
    expect(store.listSyncRuns("test", "obsidian")).toEqual([
      expect.objectContaining({ created: 2, updated: 0, deleted: 0, status: "succeeded" }),
    ]);
    expect(store.getActive("test")?.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "artifacts/notes/note.md", storageMode: "mirror", sourceId: "obsidian" }),
      ]),
    );
    expect(store.getActive("test")?.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: "OBS-0001", relativePath: "artifacts/notes/note.md", storageMode: "mirror" }),
      ]),
    );
    expect(Buffer.from(await readFile(join(workspaceRoot, ".abcm", "abcm.sqlite"))).includes(Buffer.from("version one"))).toBe(false);
    await expect(
      files.write("test", "artifacts/notes/note.md", new TextEncoder().encode("local edit")),
    ).rejects.toMatchObject({ code: "MIRROR_DOCUMENT_READ_ONLY" });
    store.close();
  });

  test("rejects stale previews and managed collisions without changing bytes", async () => {
    const { workspaceRoot, sourceRoot, store, documentation } = await fixture();
    await writeFile(join(sourceRoot, "note.md"), note("preview version"));
    const preview = await documentation.preview("test", "obsidian");
    await writeFile(join(sourceRoot, "note.md"), note("changed after preview"));
    await expect(documentation.apply(preview.importId)).rejects.toMatchObject({ code: "DOCUMENTATION_IMPORT_STALE" });
    expect(await Bun.file(join(workspaceRoot, "artifacts/notes/note.md")).exists()).toBe(false);

    await writeFile(join(workspaceRoot, "artifacts/notes/note.md"), "managed bytes");
    const collision = await documentation.preview("test", "obsidian");
    expect(collision.operations).toEqual([
      expect.objectContaining({ operation: "conflict", conflictCode: "SOURCE_TARGET_CONFLICT" }),
    ]);
    await expect(documentation.apply(collision.importId)).rejects.toMatchObject({ code: "SOURCE_TARGET_CONFLICT" });
    expect(await readFile(join(workspaceRoot, "artifacts/notes/note.md"), "utf8")).toBe("managed bytes");
    store.close();
  });

  test("updates and deletes mirrors while retaining inactive provenance and tombstone", async () => {
    const { workspaceRoot, sourceRoot, store, documentation } = await fixture();
    await writeFile(join(sourceRoot, "note.md"), note("version one"));
    await documentation.apply((await documentation.preview("test", "obsidian")).importId);

    await writeFile(join(sourceRoot, "note.md"), note("version two"));
    const updated = await documentation.sync("obsidian");
    expect(updated).toEqual(expect.objectContaining({ created: 0, updated: 1, deleted: 0 }));
    expect(await readFile(join(workspaceRoot, "artifacts/notes/note.md"), "utf8")).toContain("version two");

    await rm(join(sourceRoot, "note.md"));
    const deleted = await documentation.sync("obsidian");
    expect(deleted).toEqual(expect.objectContaining({ created: 0, updated: 0, deleted: 1 }));
    expect(await Bun.file(join(workspaceRoot, "artifacts/notes/note.md")).exists()).toBe(false);
    expect(store.listDocumentProvenance("test", "obsidian")).toEqual([
      expect.objectContaining({ sourcePath: "note.md", targetPath: "artifacts/notes/note.md", active: false }),
    ]);
    expect(store.listTombstones("test", "obsidian")).toEqual([
      expect.objectContaining({ formerPath: "artifacts/notes/note.md", reason: "canonical_source_deleted" }),
    ]);
    expect(store.getActive("test")?.documents.some(document => document.documentId === "OBS-0001")).toBe(false);
    store.close();
  });

  test("adopts an explicitly checksum-pinned canonical target without overwriting its bytes", async () => {
    const { workspaceRoot, sourceRoot, store, documentation } = await fixture(true);
    const source = note("legacy source bytes");
    const canonical = note("normalized canonical bytes");
    await writeFile(join(sourceRoot, "note.md"), source);
    await writeFile(join(workspaceRoot, "artifacts/notes/note.md"), canonical);
    await mkdir(join(workspaceRoot, "config", "documentation"), { recursive: true });
    await writeFile(join(workspaceRoot, "config/documentation/obsidian.yaml"), [
      "apiVersion: abcm/v1",
      "kind: documentation-reconciliation",
      "workspaceId: test",
      "sourceId: obsidian",
      "entries:",
      "  - sourcePath: note.md",
      "    targetPath: artifacts/notes/note.md",
      `    sourceChecksum: ${checksum(source)}`,
      `    targetChecksum: ${checksum(canonical)}`,
      "    disposition: adopt-existing",
      "",
    ].join("\n"));

    const preview = await documentation.preview("test", "obsidian");
    expect(preview.operations).toEqual([expect.objectContaining({
      operation: "unchanged",
      sourcePath: "note.md",
      targetPath: "artifacts/notes/note.md",
      sourceChecksum: checksum(source),
      targetChecksum: checksum(canonical),
      reconciliationDisposition: "adopt-existing",
    })]);
    const result = await documentation.apply(preview.importId);
    expect(result).toEqual(expect.objectContaining({ created: 0, updated: 0, moved: 0, deleted: 0 }));
    expect(await readFile(join(workspaceRoot, "artifacts/notes/note.md"), "utf8")).toBe(canonical);
    expect(store.listDocumentProvenance("test", "obsidian")).toEqual([
      expect.objectContaining({ sourceChecksum: checksum(source), targetChecksum: checksum(canonical), active: true }),
    ]);
    expect((await documentation.preview("test", "obsidian")).operations).toEqual([
      expect.objectContaining({ operation: "unchanged", targetChecksum: checksum(canonical) }),
    ]);
    expect(await documentation.cutover("obsidian", {
      operatorApproved: true,
      expectedSnapshotDigest: preview.snapshotDigest,
    })).toEqual(expect.objectContaining({ storageMode: "managed", documentCount: 1, status: "completed" }));
    store.close();
  });

  test("fails closed for unmapped and stale reconciliation entries", async () => {
    const { workspaceRoot, sourceRoot, store, documentation } = await fixture(true);
    const source = note("source bytes");
    await writeFile(join(sourceRoot, "note.md"), source);
    await mkdir(join(workspaceRoot, "config", "documentation"), { recursive: true });
    await writeFile(join(workspaceRoot, "config/documentation/obsidian.yaml"), [
      "apiVersion: abcm/v1",
      "kind: documentation-reconciliation",
      "workspaceId: test",
      "sourceId: obsidian",
      "entries:",
      "  - sourcePath: missing.md",
      "    targetPath: artifacts/notes/missing.md",
      `    sourceChecksum: ${checksum("missing")}`,
      `    targetChecksum: ${checksum("target")}`,
      "    disposition: adopt-existing",
      "",
    ].join("\n"));

    const preview = await documentation.preview("test", "obsidian");
    expect(preview.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourcePath: "note.md", conflictCode: "DOCUMENTATION_RECONCILIATION_REQUIRED" }),
      expect.objectContaining({ sourcePath: "missing.md", conflictCode: "DOCUMENTATION_RECONCILIATION_STALE" }),
    ]));
    expect(preview.operations.some(operation => operation.operation === "create")).toBe(false);
    await expect(documentation.apply(preview.importId)).rejects.toMatchObject({ code: "DOCUMENTATION_RECONCILIATION_STALE" });
    expect(await Bun.file(join(workspaceRoot, "artifacts/notes/note.md")).exists()).toBe(false);
    store.close();
  });
});
