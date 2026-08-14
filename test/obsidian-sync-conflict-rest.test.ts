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
});
