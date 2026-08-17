import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const ADMIN_TOKEN = "admin-token-for-tests-0001";
const roots: string[] = [];
const checksum = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-obsidian-rest-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "abcm-obsidian-state-"));
  roots.push(root, stateRoot);
  await mkdir(join(root, "abcm"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: castalia-public\nname: Castalia Public\n");
  await writeFile(join(root, "abcm", "scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: abcm\nname: ABCM\n");
  await writeFile(join(root, "abcm", "server.md"), "server-v1");
  const runtime = createAbcmRuntime({ id: "castalia-public", root }, {
    bearerToken: ADMIN_TOKEN,
    mcpHttpEnabled: false,
    obsidianSync: { stateRoot },
  });
  return { root, runtime };
}

function jsonRequest(url: string, method: string, body?: unknown, token?: string): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function pair(runtime: Awaited<ReturnType<typeof fixture>>["runtime"], capabilities: ("read" | "write")[] = ["read", "write"]) {
  const created = await runtime.restHandler(jsonRequest("/v1/obsidian/pairings", "POST", {
    workspaceId: "castalia-public",
    projectId: "abcm",
    projectPrefix: "abcm",
    capabilities,
  }, ADMIN_TOKEN));
  expect(created.status).toBe(201);
  const { pairingCode } = await created.json() as { pairingCode: string };
  const redeemed = await runtime.restHandler(jsonRequest("/v1/obsidian/pairings/redeem", "POST", {
    pairingCode,
    device: { id: `device_${crypto.randomUUID().replaceAll("-", "")}`, name: "Test device", platform: "linux" },
  }));
  expect(redeemed.status).toBe(200);
  return await redeemed.json() as { credential: string; deviceId: string };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Obsidian synchronization REST API", () => {
  test("requires an administrative bearer whenever Obsidian sync is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-obsidian-auth-boundary-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "abcm-obsidian-auth-state-"));
    roots.push(root, stateRoot);
    expect(() => createAbcmRuntime({ id: "public", root }, { mcpHttpEnabled: false, obsidianSync: { stateRoot } })).toThrow("requires an administrative bearer token");
  });

  test("keeps pairing creation administrative but permits one-time unauthenticated redeem", async () => {
    const { runtime } = await fixture();
    const denied = await runtime.restHandler(jsonRequest("/v1/obsidian/pairings", "POST", {
      workspaceId: "castalia-public", projectId: "abcm", projectPrefix: "abcm", capabilities: ["read"],
    }));
    expect(denied.status).toBe(401);
    const grant = await pair(runtime, ["read"]);
    expect(grant.credential).toStartWith("obs_device_");
    await runtime.close();
  });

  test("previews without mutation, applies exact bytes idempotently, and returns ordered changes", async () => {
    const { root, runtime } = await fixture();
    const grant = await pair(runtime);
    const localBytes = new TextEncoder().encode("from-obsidian\n");
    const localChecksum = checksum(localBytes);
    const previewResponse = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/preview",
      "POST",
      { cursor: null, inventory: [{ path: "local.md", checksum: localChecksum, size: localBytes.byteLength, contentType: "text/markdown" }] },
      grant.credential,
    ));
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json() as { previewId: string; serverRevision: string; cursor: string; items: { action: string; path: string; objectId: string }[] };
    expect(preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "create-server", path: "local.md" }),
      expect.objectContaining({ action: "create-local", path: "server.md" }),
    ]));
    const serverItem = preview.items.find(item => item.path === "server.md")!;
    const localItem = preview.items.find(item => item.path === "local.md")!;
    const contentResponse = await runtime.restHandler(new Request("http://localhost/v1/workspaces/castalia-public/projects/abcm/sync/content?path=server.md", { headers: { authorization: "Bearer " + grant.credential } }));
    expect(contentResponse.status).toBe(200);
    expect(await contentResponse.text()).toBe("server-v1");
    expect(contentResponse.headers.get("x-abcm-object-id")).toBe(serverItem.objectId);
    expect(await readFile(join(root, "abcm", "server.md"), "utf8")).toBe("server-v1");
    expect(await Bun.file(join(root, "abcm", "local.md")).exists()).toBe(false);

    const operation = {
      operationId: "op_rest_create_0000001",
      objectId: localItem.objectId,
      kind: "create",
      path: "local.md",
      checksum: localChecksum,
      contentBase64: Buffer.from(localBytes).toString("base64"),
      contentType: "text/markdown",
      size: localBytes.byteLength,
    };
    const batch = { cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision, operations: [operation] };
    const appliedResponse = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/apply", "POST", batch, grant.credential,
    ));
    expect(appliedResponse.status).toBe(200);
    const applied = await appliedResponse.json() as { receipts: { status: string; cursor: string }[] };
    expect(applied.receipts[0]?.status).toBe("applied");
    expect(new Uint8Array(await readFile(join(root, "abcm", "local.md")))).toEqual(localBytes);

    const duplicate = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/apply", "POST", batch, grant.credential,
    ));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { receipts: { status: string }[] }).receipts[0]?.status).toBe("duplicate");

    const changes = await runtime.restHandler(new Request(
      `http://localhost/v1/workspaces/castalia-public/projects/abcm/sync/changes?cursor=${encodeURIComponent(preview.cursor)}`,
      { headers: { authorization: `Bearer ${grant.credential}` } },
    ));
    expect(changes.status).toBe(200);
    expect((await changes.json() as { changes: { kind: string; path: string }[] }).changes).toEqual([
      expect.objectContaining({ kind: "create", path: "local.md" }),
    ]);
    await runtime.close();
  });

  test("enforces write capability and rejects a revoked credential without advancing state", async () => {
    const { runtime } = await fixture();
    const grant = await pair(runtime, ["read"]);
    const preview = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/preview", "POST", { cursor: null, inventory: [] }, grant.credential,
    ));
    expect(preview.status).toBe(200);
    const snapshot = await preview.json() as { cursor: string; previewId: string; serverRevision: string };
    const forbidden = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/apply", "POST",
      { cursor: snapshot.cursor, previewId: snapshot.previewId, serverRevision: snapshot.serverRevision, operations: [{
        operationId: "op_forbidden_0000001", objectId: "obj_forbidden_000001", kind: "create", path: "x.md",
        checksum: checksum("x"), contentBase64: Buffer.from("x").toString("base64"), contentType: "text/markdown", size: 1,
      }] }, grant.credential,
    ));
    expect(forbidden.status).toBe(403);

    const revoked = await runtime.restHandler(jsonRequest(`/v1/obsidian/devices/${grant.deviceId}`, "DELETE", undefined, ADMIN_TOKEN));
    expect(revoked.status).toBe(204);
    const afterRevoke = await runtime.restHandler(new Request(
      `http://localhost/v1/workspaces/castalia-public/projects/abcm/sync/changes?cursor=${encodeURIComponent(snapshot.cursor)}`,
      { headers: { authorization: `Bearer ${grant.credential}` } },
    ));
    expect(afterRevoke.status).toBe(401);
    await runtime.close();
  });
  test("rejects a mutation that was not authorized by the pinned local inventory", async () => {
    const { root, runtime } = await fixture();
    const grant = await pair(runtime);
    const previewResponse = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/preview", "POST", { cursor: null, inventory: [] }, grant.credential,
    ));
    const preview = await previewResponse.json() as { cursor: string; previewId: string; serverRevision: string };
    const rogue = "not-previewed";
    const rejected = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/apply", "POST", {
        cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision,
        operations: [{ operationId: "op_rogue_000000001", objectId: "obj_rogue_00000001", kind: "create", path: "rogue.md", checksum: checksum(rogue), contentBase64: Buffer.from(rogue).toString("base64"), contentType: "text/markdown", size: rogue.length }],
      }, grant.credential,
    ));
    expect(rejected.status).toBe(409);
    expect(await Bun.file(join(root, "abcm", "rogue.md")).exists()).toBe(false);
    await runtime.close();
  });

  test("anchors a preview-issued server object without a synthetic change event", async () => {
    const { root, runtime } = await fixture();
    const grant = await pair(runtime);
    const baselineResponse = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/preview", "POST",
      { cursor: null, inventory: [{ path: "server.md", checksum: checksum("server-v1"), size: 9, contentType: "text/markdown" }] }, grant.credential,
    ));
    const baseline = await baselineResponse.json() as { cursor: string };
    const updated = "server-v2";
    const updatedChecksum = checksum(updated);
    const previewResponse = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/preview", "POST",
      { cursor: baseline.cursor, inventory: [{ path: "server.md", checksum: updatedChecksum, size: updated.length, contentType: "text/markdown" }] }, grant.credential,
    ));
    const preview = await previewResponse.json() as { cursor: string; previewId: string; serverRevision: string; items: { path: string; action: string; objectId: string }[] };
    const item = preview.items.find(candidate => candidate.path === "server.md")!;
    expect(item.action).toBe("update-server");
    const apply = await runtime.restHandler(jsonRequest(
      "/v1/workspaces/castalia-public/projects/abcm/sync/apply", "POST", {
        cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision,
        operations: [{ operationId: "op_initial_update_0001", objectId: item.objectId, kind: "update", path: "server.md", baseChecksum: checksum("server-v1"), checksum: updatedChecksum, contentBase64: Buffer.from(updated).toString("base64"), contentType: "text/markdown", size: updated.length }],
      }, grant.credential,
    ));
    expect(apply.status).toBe(200);
    expect((await apply.json() as { receipts: { status: string }[] }).receipts[0]?.status).toBe("applied");
    expect(await readFile(join(root, "abcm", "server.md"), "utf8")).toBe(updated);
    const changes = await runtime.restHandler(new Request(
      `http://localhost/v1/workspaces/castalia-public/projects/abcm/sync/changes?cursor=${encodeURIComponent(preview.cursor)}`,
      { headers: { authorization: "Bearer " + grant.credential } },
    ));
    const events = (await changes.json() as { changes: { kind: string; objectId: string }[] }).changes;
    expect(events.map(event => event.kind)).toEqual(["update"]);
    expect(new Set(events.map(event => event.objectId))).toEqual(new Set([item.objectId]));
    await runtime.close();
  });

});
