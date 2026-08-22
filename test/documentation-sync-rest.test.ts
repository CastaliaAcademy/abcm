import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const ADMIN_TOKEN = "admin-token-for-tests-0001";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("documentation sync REST contract", () => {
  test("previews, applies, syncs, and rejects mirror file writes through one runtime", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "abcm-sync-rest-workspace-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "abcm-sync-rest-source-"));
    const syncStateRoot = await mkdtemp(join(tmpdir(), "abcm-sync-rest-state-"));
    roots.push(workspaceRoot, sourceRoot, syncStateRoot);
    await mkdir(join(workspaceRoot, "domain-language"));
    await mkdir(join(workspaceRoot, "artifacts", "notes"), { recursive: true });
    await writeFile(join(workspaceRoot, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await writeFile(join(workspaceRoot, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(sourceRoot, "note.md"), "---\nid: OBS-1\nkind: note\ntitle: Note\n---\nbody\n");
    const runtime = createAbcmRuntime(
      { id: "test", root: workspaceRoot },
      {
        bearerToken: ADMIN_TOKEN,
        sqliteDerivedStoreEnabled: true,
        documentationSources: [{ id: "obsidian", workspaceId: "test", root: sourceRoot, targetBasePath: "artifacts/notes" }],
        obsidianSync: { stateRoot: syncStateRoot },
      },
    );
    await runtime.scopeMap.scan("test");
    const call = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${ADMIN_TOKEN}`);
      return runtime.restHandler(new Request(`http://localhost${path}`, { ...init, headers }));
    };
    try {
      const previewResponse = await call("/v1/workspaces/test/documentation-sources/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: "obsidian" }),
      });
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()) as { importId: string; snapshotDigest: string; operations: unknown[] };
      expect(preview.operations).toHaveLength(1);

      const apply = await call(`/v1/documentation-imports/${preview.importId}/apply`, { method: "POST" });
      expect(apply.status).toBe(200);
      expect(await apply.json()).toEqual(expect.objectContaining({ created: 1, status: "succeeded" }));

      const write = await call("/v1/workspaces/test/files/content?path=artifacts%2Fnotes%2Fnote.md", {
        method: "PUT",
        body: "local",
      });
      expect(write.status).toBe(409);
      expect(await write.json()).toEqual(expect.objectContaining({ code: "MIRROR_DOCUMENT_READ_ONLY" }));

      const deletion = await call("/v1/workspaces/test/files?path=artifacts%2Fnotes%2Fnote.md", { method: "DELETE" });
      expect(deletion.status).toBe(409);
      expect(await deletion.json()).toEqual(expect.objectContaining({ code: "MIRROR_DOCUMENT_READ_ONLY" }));

      const move = await call("/v1/workspaces/test/files/move", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ from: "artifacts/notes/note.md", to: "artifacts/notes/moved.md" }),
      });
      expect(move.status).toBe(409);
      expect(await move.json()).toEqual(expect.objectContaining({ code: "MIRROR_DOCUMENT_READ_ONLY" }));

      const blockedPairing = await call("/v1/obsidian/pairings", {
        method: "POST",
        headers: { "authorization": `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "test",
          projectId: "notes",
          projectPrefix: "artifacts/notes",
          capabilities: ["read", "write"],
        }),
      });
      expect(blockedPairing.status).toBe(409);
      expect(await blockedPairing.json()).toEqual(expect.objectContaining({ code: "MIRROR_DOCUMENT_READ_ONLY" }));

      const sync = await call("/v1/documentation-sources/obsidian/sync", { method: "POST" });
      expect(sync.status).toBe(200);
      expect(await sync.json()).toEqual(expect.objectContaining({ status: "succeeded" }));

      const cutover = await call("/v1/documentation-sources/obsidian/cutover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorApproved: true, expectedSnapshotDigest: preview.snapshotDigest }),
      });
      expect(cutover.status).toBe(200);
      expect(await cutover.json()).toEqual(expect.objectContaining({ status: "completed", storageMode: "managed" }));

      const managedPairing = await call("/v1/obsidian/pairings", {
        method: "POST",
        headers: { "authorization": `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          workspaceId: "test",
          projectId: "notes",
          projectPrefix: "artifacts/notes",
          capabilities: ["read", "write"],
        }),
      });
      expect(managedPairing.status).toBe(201);
      expect(await managedPairing.json()).toEqual(expect.objectContaining({
        pairingCode: expect.stringMatching(/^pair_/),
      }));

      const managedWrite = await call("/v1/workspaces/test/files/content?path=artifacts%2Fnotes%2Fnote.md", {
        method: "PUT",
        body: "managed",
      });
      expect(managedWrite.status).toBe(200);

      const unknown = await call("/v1/workspaces/test/documentation-sources/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: "unknown", root: "/tmp/escape" }),
      });
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).toEqual(expect.objectContaining({ code: "REQUEST_INVALID" }));
    } finally {
      await runtime.close();
    }
  });
});
