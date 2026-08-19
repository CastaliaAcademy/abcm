import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { InMemoryAbcmObservability } from "../src/core/observability.js";

const ADMIN = "admin-token-for-conflict-tests";
const roots: string[] = [];
const checksum = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const request = (path: string, method = "GET", body?: unknown, token?: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "abcm-sync-conflict-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "abcm-sync-conflict-state-"));
  roots.push(root, stateRoot);
  await mkdir(join(root, "abcm"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: public\nname: Public\n");
  await writeFile(join(root, "abcm", "scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: abcm\nname: ABCM\n");
  await writeFile(join(root, "abcm", "note.md"), "server-v1");
  const observability = new InMemoryAbcmObservability();
  const runtime = createAbcmRuntime({ id: "public", root }, { bearerToken: ADMIN, mcpHttpEnabled: false, obsidianSync: { stateRoot }, observability });
  const pairing = await runtime.restHandler(request("/v1/obsidian/pairings", "POST", {
    workspaceId: "public", projectId: "abcm", projectPrefix: "abcm", capabilities: ["read", "write"],
  }, ADMIN));
  const { pairingCode } = await pairing.json() as { pairingCode: string };
  const redeemed = await runtime.restHandler(request("/v1/obsidian/pairings/redeem", "POST", {
    pairingCode, device: { id: "device_01JCONFLICT000000001", name: "Conflict device", platform: "windows" },
  }));
  const grant = await redeemed.json() as { credential: string; deviceId: string };
  return { runtime, grant, observability };
}

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("Obsidian conflict REST lifecycle", () => {
  test("captures an external REST mutation, exposes conflict status, and resolves it explicitly", async () => {
    const { runtime, grant, observability } = await setup();
    const initial = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: null, inventory: [{ path: "note.md", checksum: checksum("server-v1"), size: 9, contentType: "text/markdown" }],
    }, grant.credential));
    const initialPreview = await initial.json() as { cursor: string };

    const external = await runtime.restHandler(request(
      "/v1/workspaces/public/files/content?path=abcm%2Fnote.md", "PUT", "server-v2", ADMIN,
      { "content-type": "text/markdown", "if-match": `"${checksum("server-v1")}"` },
    ));
    expect(external.status).toBe(200);
    const changesResponse = await runtime.restHandler(request(
      `/v1/workspaces/public/projects/abcm/sync/changes?cursor=${encodeURIComponent(initialPreview.cursor)}`, "GET", undefined, grant.credential,
    ));
    const changes = await changesResponse.json() as { changes: { objectId: string }[]; nextCursor: string };
    expect(changes.changes).toHaveLength(1);
    const objectId = changes.changes[0]!.objectId;

    const local = "local-v3";
    const previewResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: changes.nextCursor, inventory: [{ path: "note.md", checksum: checksum(local), size: local.length, contentType: "text/markdown" }],
    }, grant.credential));
    const preview = await previewResponse.json() as { previewId: string; serverRevision: string; cursor: string };
    const apply = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/apply", "POST", {
      cursor: preview.cursor,
      previewId: preview.previewId,
      serverRevision: preview.serverRevision,
      operations: [{
        operationId: "op_conflict_00000001", objectId, kind: "update", path: "note.md",
        baseChecksum: checksum("server-v1"), checksum: checksum(local), contentBase64: Buffer.from(local).toString("base64"),
        contentType: "text/markdown", size: local.length,
      }],
    }, grant.credential));
    expect(apply.status).toBe(200);
    const conflictReceipt = (await apply.json() as { receipts: { status: string; conflictId: string }[] }).receipts[0]!;
    expect(conflictReceipt.status).toBe("conflict");

    const status = await runtime.restHandler(request(
      `/v1/workspaces/public/projects/abcm/sync/conflicts/${conflictReceipt.conflictId}`, "GET", undefined, grant.credential,
    ));
    const conflict = await status.json() as { status: string; local: { checksum: string }; server: { checksum: string } };
    expect(conflict).toEqual(expect.objectContaining({ status: "open" }));

    const resolved = await runtime.restHandler(request(
      `/v1/workspaces/public/projects/abcm/sync/conflicts/${conflictReceipt.conflictId}/resolve`, "POST",
      { operationId: "op_resolve_000000001", resolution: "keep-server", localChecksum: conflict.local.checksum, serverChecksum: conflict.server.checksum },
      grant.credential,
    ));
    expect(resolved.status).toBe(200);
    const resolvedStatus = await runtime.restHandler(request(
      `/v1/workspaces/public/projects/abcm/sync/conflicts/${conflictReceipt.conflictId}`, "GET", undefined, grant.credential,
    ));
    expect((await resolvedStatus.json() as { status: string }).status).toBe("resolved");

    expect(observability.auditEvents.map(event => event.operation)).toEqual(expect.arrayContaining([
      "sync.pairing.create", "sync.pairing.redeem", "sync.preview", "sync.changes", "sync.conflict.create", "sync.conflict.resolve",
    ]));
    expect(JSON.stringify(observability.auditEvents)).not.toContain(grant.credential);
    expect(JSON.stringify(observability.auditEvents)).not.toContain(local);
    await runtime.close();
  });

  test("restores a server tombstone with the same object identity on keep-local", async () => {
    const { runtime, grant } = await setup();
    const initialResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: null, inventory: [{ path: "note.md", checksum: checksum("server-v1"), size: 9, contentType: "text/markdown" }],
    }, grant.credential));
    const initial = await initialResponse.json() as { cursor: string; items: Array<{ objectId: string; path: string; serverChecksum: string }> };
    const base = { objectId: initial.items[0]!.objectId, path: "note.md", checksum: checksum("server-v1") };
    const removed = await runtime.restHandler(request(
      "/v1/workspaces/public/files?path=abcm%2Fnote.md", "DELETE", undefined, ADMIN,
      { "if-match": '"' + checksum("server-v1") + '"' },
    ));
    expect(removed.status).toBe(204);

    const local = "local-after-delete";
    const previewResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: initial.cursor,
      inventory: [{ path: "note.md", checksum: checksum(local), size: local.length, contentType: "text/markdown" }],
      base: [base],
    }, grant.credential));
    const preview = await previewResponse.json() as { previewId: string; serverRevision: string; cursor: string; items: Array<{ action: string }> };
    expect(preview.items[0]?.action).toBe("conflict");
    const applied = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/apply", "POST", {
      cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision,
      operations: [{
        operationId: "op_delete_update_local_01", objectId: base.objectId, kind: "update", path: "note.md",
        baseChecksum: base.checksum, checksum: checksum(local), contentBase64: Buffer.from(local).toString("base64"),
        contentType: "text/markdown", size: local.length,
      }],
    }, grant.credential));
    const conflictReceipt = (await applied.json() as { receipts: Array<{ conflictId: string }> }).receipts[0]!;
    const status = await runtime.restHandler(request(
      "/v1/workspaces/public/projects/abcm/sync/conflicts/" + conflictReceipt.conflictId, "GET", undefined, grant.credential,
    ));
    const conflict = await status.json() as {
      kind: string; localPath: string | null; serverPath: string | null;
      local: { checksum: string }; server: { state: string };
    };
    expect(conflict).toEqual(expect.objectContaining({ kind: "delete-update", localPath: "note.md", serverPath: null }));
    const resolved = await runtime.restHandler(request(
      "/v1/workspaces/public/projects/abcm/sync/conflicts/" + conflictReceipt.conflictId + "/resolve", "POST",
      { operationId: "op_restore_local_0000001", resolution: "keep-local", localChecksum: conflict.local.checksum, serverChecksum: null },
      grant.credential,
    ));
    expect(resolved.status).toBe(200);
    expect((await resolved.json() as { objectId: string }).objectId).toBe(base.objectId);
    const restored = await runtime.restHandler(request(
      "/v1/workspaces/public/files/content?path=abcm%2Fnote.md", "GET", undefined, ADMIN,
    ));
    expect(await restored.text()).toBe(local);
    await runtime.close();
  });

  test("keeps a delete/update conflict as deletion plus a recovered server copy", async () => {
    const { runtime, grant } = await setup();
    const initialResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: null, inventory: [{ path: "note.md", checksum: checksum("server-v1"), size: 9, contentType: "text/markdown" }],
    }, grant.credential));
    const initial = await initialResponse.json() as { cursor: string; items: Array<{ objectId: string }> };
    const base = { objectId: initial.items[0]!.objectId, path: "note.md", checksum: checksum("server-v1") };
    const server = "server-after-local-delete";
    const external = await runtime.restHandler(request(
      "/v1/workspaces/public/files/content?path=abcm%2Fnote.md", "PUT", server, ADMIN,
      { "content-type": "text/markdown", "if-match": '"' + base.checksum + '"' },
    ));
    expect(external.status).toBe(200);
    const previewResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: initial.cursor, inventory: [], base: [base],
    }, grant.credential));
    const preview = await previewResponse.json() as { previewId: string; serverRevision: string; cursor: string; items: Array<{ action: string }> };
    expect(preview.items[0]?.action).toBe("conflict");
    const applied = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/apply", "POST", {
      cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision,
      operations: [{ operationId: "op_delete_update_server_1", objectId: base.objectId, kind: "delete", path: "note.md", baseChecksum: base.checksum }],
    }, grant.credential));
    const conflictReceipt = (await applied.json() as { receipts: Array<{ conflictId: string }> }).receipts[0]!;
    const status = await runtime.restHandler(request(
      "/v1/workspaces/public/projects/abcm/sync/conflicts/" + conflictReceipt.conflictId, "GET", undefined, grant.credential,
    ));
    const conflict = await status.json() as {
      localPath: string | null; serverPath: string | null;
      local: { state: string }; server: { checksum: string };
    };
    expect(conflict).toEqual(expect.objectContaining({ localPath: null, serverPath: "note.md" }));
    const resolved = await runtime.restHandler(request(
      "/v1/workspaces/public/projects/abcm/sync/conflicts/" + conflictReceipt.conflictId + "/resolve", "POST",
      { operationId: "op_keep_both_delete_001", resolution: "keep-both", localChecksum: null, serverChecksum: conflict.server.checksum, keepBothPath: "recovered/note.md" },
      grant.credential,
    ));
    expect(resolved.status).toBe(200);
    const original = await runtime.restHandler(request(
      "/v1/workspaces/public/files/content?path=abcm%2Fnote.md", "GET", undefined, ADMIN,
    ));
    expect(original.status).toBe(404);
    const recovered = await runtime.restHandler(request(
      "/v1/workspaces/public/files/content?path=abcm%2Frecovered%2Fnote.md", "GET", undefined, ADMIN,
    ));
    expect(await recovered.text()).toBe(server);
    await runtime.close();
  });

  test("preserves both move targets with server identity staying on serverPath", async () => {
    const { runtime, grant } = await setup();
    const initialResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: null, inventory: [{ path: "note.md", checksum: checksum("server-v1"), size: 9, contentType: "text/markdown" }],
    }, grant.credential));
    const initial = await initialResponse.json() as { cursor: string; items: Array<{ objectId: string }> };
    const base = { objectId: initial.items[0]!.objectId, path: "note.md", checksum: checksum("server-v1") };
    const moved = await runtime.restHandler(request("/v1/workspaces/public/files/move", "POST", {
      from: "abcm/note.md", to: "abcm/server-note.md", ifMatch: base.checksum,
    }, ADMIN));
    expect(moved.status).toBe(200);
    const previewResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: initial.cursor,
      inventory: [{ path: "local-note.md", checksum: base.checksum, size: 9, contentType: "text/markdown" }],
      base: [base],
    }, grant.credential));
    const preview = await previewResponse.json() as { previewId: string; serverRevision: string; cursor: string; items: Array<{ action: string }> };
    expect(preview.items[0]?.action).toBe("conflict");
    const applied = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/apply", "POST", {
      cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision,
      operations: [{
        operationId: "op_move_move_conflict_001", objectId: base.objectId, kind: "move", previousPath: "note.md", path: "local-note.md",
        baseChecksum: base.checksum, checksum: base.checksum, contentBase64: Buffer.from("server-v1").toString("base64"),
        contentType: "text/markdown", size: 9,
      }],
    }, grant.credential));
    const conflictReceipt = (await applied.json() as { receipts: Array<{ conflictId: string }> }).receipts[0]!;
    const status = await runtime.restHandler(request(
      "/v1/workspaces/public/projects/abcm/sync/conflicts/" + conflictReceipt.conflictId, "GET", undefined, grant.credential,
    ));
    const conflict = await status.json() as {
      kind: string; localPath: string; serverPath: string;
      local: { checksum: string }; server: { checksum: string };
    };
    expect(conflict).toEqual(expect.objectContaining({ kind: "move-move", localPath: "local-note.md", serverPath: "server-note.md" }));
    const resolved = await runtime.restHandler(request(
      "/v1/workspaces/public/projects/abcm/sync/conflicts/" + conflictReceipt.conflictId + "/resolve", "POST",
      { operationId: "op_keep_both_move_0001", resolution: "keep-both", localChecksum: conflict.local.checksum, serverChecksum: conflict.server.checksum, keepBothPath: "local-note.md" },
      grant.credential,
    ));
    expect(resolved.status).toBe(200);
    const serverVersion = await runtime.restHandler(request(
      "/v1/workspaces/public/files/content?path=abcm%2Fserver-note.md", "GET", undefined, ADMIN,
    ));
    const localVersion = await runtime.restHandler(request(
      "/v1/workspaces/public/files/content?path=abcm%2Flocal-note.md", "GET", undefined, ADMIN,
    ));
    expect(await serverVersion.text()).toBe("server-v1");
    expect(await localVersion.text()).toBe("server-v1");
    await runtime.close();
  });

});
