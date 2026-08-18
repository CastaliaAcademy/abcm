import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const ADMIN = "admin-token-for-offline-move";
const roots: string[] = [];
const checksum = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const request = (path: string, method = "GET", body?: unknown, token?: string) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("restart-safe updated local move", () => {
  test("uses a persisted identity hint and applies new bytes as one move event", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-offline-move-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "abcm-offline-move-state-"));
    roots.push(root, stateRoot);
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: public\nname: Public\n");
    await writeFile(join(root, "project", "scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
    await writeFile(join(root, "project", "note.md"), "base");
    const runtime = createAbcmRuntime({ id: "public", root }, { bearerToken: ADMIN, mcpHttpEnabled: false, obsidianSync: { stateRoot } });
    try {
      const pairing = await runtime.restHandler(request("/v1/obsidian/pairings", "POST", {
        workspaceId: "public", projectId: "project", projectPrefix: "project", capabilities: ["read", "write"],
      }, ADMIN));
      const { pairingCode } = await pairing.json() as { pairingCode: string };
      const redeemed = await runtime.restHandler(request("/v1/obsidian/pairings/redeem", "POST", {
        pairingCode, device: { id: "device_01JOFFLINEMOVE001", name: "Offline move", platform: "windows" },
      }));
      const { credential } = await redeemed.json() as { credential: string };
      const initialResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/project/sync/preview", "POST", {
        cursor: null,
        inventory: [{ path: "note.md", checksum: checksum("base"), size: 4, contentType: "text/markdown" }],
        base: [],
      }, credential));
      const initial = await initialResponse.json() as { previewId: string; serverRevision: string; cursor: string; items: Array<{ objectId: string; path: string }> };
      const objectId = initial.items.find(item => item.path === "note.md")?.objectId;
      if (objectId === undefined) throw new Error("Initial object identity is missing.");
      const updated = "changed";
      const previewResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/project/sync/preview", "POST", {
        cursor: initial.cursor,
        inventory: [{ path: "renamed.md", checksum: checksum(updated), size: updated.length, contentType: "text/markdown" }],
        base: [{ objectId, path: "note.md", checksum: checksum("base") }],
        identityHints: [{ objectId, previousPath: "note.md", path: "renamed.md" }],
      }, credential));
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { previewId: string; serverRevision: string; cursor: string; items: Array<{ action: string; objectId: string; path: string; previousPath?: string }> };
      expect(preview.items).toContainEqual(expect.objectContaining({ action: "move-server", objectId, previousPath: "note.md", path: "renamed.md" }));
      const applied = await runtime.restHandler(request("/v1/workspaces/public/projects/project/sync/apply", "POST", {
        cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision,
        operations: [{ operationId: "op_offline_move_update_01", objectId, kind: "move", previousPath: "note.md", path: "renamed.md", baseChecksum: checksum("base"), checksum: checksum(updated), contentBase64: Buffer.from(updated).toString("base64"), contentType: "text/markdown", size: updated.length }],
      }, credential));
      expect(applied.status).toBe(200);
      expect((await applied.json() as { receipts: Array<{ status: string; objectId: string; checksum: string }> }).receipts[0]).toEqual(expect.objectContaining({ status: "applied", objectId, checksum: checksum(updated) }));
      expect(await readFile(join(root, "project", "renamed.md"), "utf8")).toBe(updated);
      expect(await Bun.file(join(root, "project", "note.md")).exists()).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});
