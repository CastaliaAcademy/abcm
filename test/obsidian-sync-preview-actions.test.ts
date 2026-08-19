import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const ADMIN = "admin-token-for-preview-actions";
const roots: string[] = [];
const checksum = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const request = (path: string, method = "GET", body?: unknown, token?: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, {
  method,
  headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "abcm-sync-actions-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "abcm-sync-actions-state-"));
  roots.push(root, stateRoot);
  await mkdir(join(root, "abcm"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: public\nname: Public\n");
  await writeFile(join(root, "abcm", "scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: abcm\nname: ABCM\n");
  await writeFile(join(root, "abcm", "note.md"), "base");
  const runtime = createAbcmRuntime({ id: "public", root }, { bearerToken: ADMIN, mcpHttpEnabled: false, obsidianSync: { stateRoot } });
  const pairing = await runtime.restHandler(request("/v1/obsidian/pairings", "POST", {
    workspaceId: "public", projectId: "abcm", projectPrefix: "abcm", capabilities: ["read", "write"],
  }, ADMIN));
  const { pairingCode } = await pairing.json() as { pairingCode: string };
  const redeemed = await runtime.restHandler(request("/v1/obsidian/pairings/redeem", "POST", {
    pairingCode, device: { id: "device_01JPREVIEWACTIONS001", name: "Preview actions", platform: "linux" },
  }));
  const grant = await redeemed.json() as { credential: string };
  const initialResponse = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
    cursor: null,
    inventory: [{ path: "note.md", checksum: checksum("base"), size: 4, contentType: "text/markdown" }],
    base: [],
  }, grant.credential));
  expect(initialResponse.status).toBe(200);
  const initial = await initialResponse.json() as {
    previewId: string;
    serverRevision: string;
    cursor: string;
    items: Array<{ action: string; objectId: string; path: string }>;
  };
  const objectId = initial.items.find(item => item.path === "note.md")?.objectId;
  if (objectId === undefined) throw new Error("Initial preview object id is missing.");
  return { root, runtime, grant, initial, base: { objectId, path: "note.md", checksum: checksum("base") } };
}

afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe("identity-aware Obsidian preview actions", () => {
  test("plans and applies a local delete with a checksum precondition", async () => {
    const { root, runtime, grant, initial, base } = await setup();
    const response = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: initial.cursor, inventory: [], base: [base],
    }, grant.credential));
    expect(response.status).toBe(200);
    const preview = await response.json() as typeof initial;
    expect(preview.items).toContainEqual(expect.objectContaining({
      action: "delete-server", objectId: base.objectId, path: "note.md",
    }));
    const applied = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/apply", "POST", {
      cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision,
      operations: [{ operationId: "op_delete_preview_0001", objectId: base.objectId, kind: "delete", path: "note.md", baseChecksum: base.checksum }],
    }, grant.credential));
    expect(applied.status).toBe(200);
    expect((await applied.json() as { receipts: Array<{ status: string }> }).receipts[0]?.status).toBe("applied");
    expect(await Bun.file(join(root, "abcm", "note.md")).exists()).toBe(false);
    await runtime.close();
  });

  test("plans and applies an identity-preserving local move", async () => {
    const { root, runtime, grant, initial, base } = await setup();
    const response = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: initial.cursor,
      inventory: [{ path: "renamed.md", checksum: checksum("base"), size: 4, contentType: "text/markdown" }],
      base: [base],
    }, grant.credential));
    expect(response.status).toBe(200);
    const preview = await response.json() as typeof initial & { items: Array<{ action: string; objectId: string; path: string; previousPath?: string }> };
    expect(preview.items).toContainEqual(expect.objectContaining({
      action: "move-server", objectId: base.objectId, previousPath: "note.md", path: "renamed.md",
    }));
    const applied = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/apply", "POST", {
      cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision,
      operations: [{
        operationId: "op_move_preview_000001", objectId: base.objectId, kind: "move", previousPath: "note.md", path: "renamed.md",
        baseChecksum: base.checksum, checksum: base.checksum, contentBase64: Buffer.from("base").toString("base64"), contentType: "text/markdown", size: 4,
      }],
    }, grant.credential));
    expect(applied.status).toBe(200);
    expect((await applied.json() as { receipts: Array<{ status: string }> }).receipts[0]?.status).toBe("applied");
    expect(await readFile(join(root, "abcm", "renamed.md"), "utf8")).toBe("base");
    expect(await Bun.file(join(root, "abcm", "note.md")).exists()).toBe(false);
    await runtime.close();
  });

  test("plans a remote move against the same persisted base identity", async () => {
    const { runtime, grant, initial, base } = await setup();
    const moved = await runtime.restHandler(request("/v1/workspaces/public/files/move", "POST", {
      from: "abcm/note.md", to: "abcm/server-renamed.md", ifMatch: base.checksum,
    }, ADMIN));
    expect(moved.status).toBe(200);
    const response = await runtime.restHandler(request("/v1/workspaces/public/projects/abcm/sync/preview", "POST", {
      cursor: initial.cursor,
      inventory: [{ path: "note.md", checksum: checksum("base"), size: 4, contentType: "text/markdown" }],
      base: [base],
    }, grant.credential));
    expect(response.status).toBe(200);
    expect((await response.json() as { items: unknown[] }).items).toContainEqual(expect.objectContaining({
      action: "move-local", objectId: base.objectId, previousPath: "note.md", path: "server-renamed.md",
    }));
    await runtime.close();
  });
});
