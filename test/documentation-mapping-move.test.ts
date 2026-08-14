import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteWorkspaceMapStore } from "../src/derived-store/sqlite-workspace-map-store.js";
import { DirectoryDocumentationSyncService } from "../src/documentation/directory-documentation-sync-service.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture(mapping = [
  { match: "docs/adr/**", target: "artifacts/adr/" },
  { match: "README.md", target: "README.md" },
]) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "abcm-doc-map-workspace-"));
  const sourceRoot = await mkdtemp(join(tmpdir(), "abcm-doc-map-source-"));
  roots.push(workspaceRoot, sourceRoot);
  await mkdir(join(workspaceRoot, "domain-language"));
  await writeFile(join(workspaceRoot, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await writeFile(join(workspaceRoot, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const registry = new WorkspaceRegistry([{ id: "test", root: workspaceRoot }]);
  const store = new SqliteWorkspaceMapStore(registry, { ownerId: "mapping-test" });
  const scopeMap = new ScopeMapService(registry, store, store);
  const files = new WorkspaceFileService(registry);
  const documentation = new DirectoryDocumentationSyncService({
    registry,
    files,
    scopeMap,
    state: store,
    sources: [{
      id: "docs",
      workspaceId: "test",
      root: sourceRoot,
      targetBasePath: "artifacts/fallback",
      include: ["docs/**", "README.md"],
      exclude: ["docs/drafts/**"],
      mapping,
    }],
  });
  return { workspaceRoot, sourceRoot, store, documentation };
}

const note = "---\nid: ADR-MOVE\nkind: adr\ntitle: Stable decision\n---\nbody\n";

describe("documentation mapping and identity-preserving moves", () => {
  test("filters, maps, and moves an unchanged document without a tombstone", async () => {
    const { workspaceRoot, sourceRoot, store, documentation } = await fixture();
    await mkdir(join(sourceRoot, "docs", "adr"), { recursive: true });
    await mkdir(join(sourceRoot, "docs", "drafts"), { recursive: true });
    await writeFile(join(sourceRoot, "docs", "adr", "old.md"), note);
    await writeFile(join(sourceRoot, "docs", "drafts", "hidden.md"), "hidden\n");
    await writeFile(join(sourceRoot, "ignored.md"), "ignored\n");
    await writeFile(join(sourceRoot, "README.md"), "readme\n");

    const initial = await documentation.preview("test", "docs");
    expect(initial.operations).toEqual([
      expect.objectContaining({ operation: "create", sourcePath: "docs/adr/old.md", targetPath: "artifacts/adr/old.md" }),
      expect.objectContaining({ operation: "create", sourcePath: "README.md", targetPath: "README.md" }),
    ]);
    await documentation.apply(initial.importId);

    await rename(join(sourceRoot, "docs", "adr", "old.md"), join(sourceRoot, "docs", "adr", "new.md"));
    const movedPlan = await documentation.preview("test", "docs");
    expect(movedPlan.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operation: "move",
        sourcePath: "docs/adr/new.md",
        previousSourcePath: "docs/adr/old.md",
        targetPath: "artifacts/adr/new.md",
        previousTargetPath: "artifacts/adr/old.md",
      }),
    ]));
    const result = await documentation.apply(movedPlan.importId);
    expect(result).toEqual(expect.objectContaining({ created: 0, updated: 0, moved: 1, deleted: 0 }));
    expect(await Bun.file(join(workspaceRoot, "artifacts/adr/old.md")).exists()).toBe(false);
    expect(await Bun.file(join(workspaceRoot, "artifacts/adr/new.md")).text()).toBe(note);
    expect(store.listTombstones("test", "docs")).toEqual([]);
    expect(store.listDocumentProvenance("test", "docs")).toEqual([
      expect.objectContaining({ sourcePath: "README.md", active: true }),
      expect.objectContaining({ sourcePath: "docs/adr/new.md", targetPath: "artifacts/adr/new.md", active: true }),
      expect.objectContaining({ sourcePath: "docs/adr/old.md", targetPath: "artifacts/adr/old.md", active: false }),
    ]);
    expect(store.getActive("test")?.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentId: "ADR-MOVE", relativePath: "artifacts/adr/new.md" }),
    ]));
    store.close();
  });

  test("reports overlapping mappings and duplicate targets as deterministic conflicts", async () => {
    const { sourceRoot, store, documentation } = await fixture([
      { match: "docs/**", target: "artifacts/all/" },
      { match: "docs/adr/**", target: "artifacts/adr/" },
    ]);
    await mkdir(join(sourceRoot, "docs", "adr"), { recursive: true });
    await writeFile(join(sourceRoot, "docs", "adr", "one.md"), note);
    const overlapping = await documentation.preview("test", "docs");
    expect(overlapping.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ conflictCode: "DOCUMENTATION_MAPPING_AMBIGUOUS" }),
    ]));
    await expect(documentation.apply(overlapping.importId)).rejects.toMatchObject({ code: "DOCUMENTATION_MAPPING_AMBIGUOUS" });
    store.close();
  });
});
