import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ObsidianSyncService } from "../src/sync/obsidian-sync-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("Synchronization mode exclusivity", () => {
  test("rejects bidirectional pairing that overlaps a configured read-only mirror", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "abcm-mode-workspace-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "abcm-mode-state-"));
    roots.push(workspaceRoot, stateRoot);
    const registry = new WorkspaceRegistry([{ id: "public", root: workspaceRoot }]);
    const service = new ObsidianSyncService(registry, new WorkspaceFileService(registry), {
      stateRoot,
      reservedReadOnlyMappings: [{ workspaceId: "public", targetBasePath: "abcm/artifacts/notes/obsidian" }],
    });

    expect(() => service.createPairing({
      workspaceId: "public",
      projectId: "abcm",
      projectPrefix: "abcm",
      capabilities: ["read", "write"],
    })).toThrow(expect.objectContaining({ code: "MIRROR_DOCUMENT_READ_ONLY" }));
    service.close();
  });
});
