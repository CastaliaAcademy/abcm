import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const ADMIN_TOKEN = "admin-token-for-amendment-sync-tests";
const roots: string[] = [];
const checksum = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const baseBytes = `---
id: ADR-0001
kind: adr
title: Stable decision
status: accepted
lineageId: stable-decision
tags: [architecture]
---
Original decision.
`;

const changedBytes = `---
id: ADR-0001
kind: adr
title: Stable decision
status: accepted
lineageId: stable-decision
tags: [architecture, control-plane]
---
Updated decision.
`;

function request(url: string, method: string, body?: unknown, token?: string): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-obsidian-amendment-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "abcm-obsidian-amendment-state-"));
  roots.push(root, stateRoot);
  await mkdir(join(root, "abcm", "artifacts", "adr"), { recursive: true });
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "abcm", "domain-language"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: castalia-public\nname: Castalia Public\n");
  await writeFile(join(root, "domain-language", "DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "abcm", "scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: abcm\nname: ABCM\n");
  await writeFile(join(root, "abcm", "domain-language", "DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const acceptedPath = join(root, "abcm", "artifacts", "adr", "ADR-0001.md");
  await writeFile(acceptedPath, baseBytes);
  const runtime = createAbcmRuntime({ id: "castalia-public", root }, {
    bearerToken: ADMIN_TOKEN,
    mcpHttpEnabled: false,
    obsidianSync: { stateRoot },
    artifactAmendments: { stateRoot: join(stateRoot, "amendments"), operatorIdentity: "workspace-operator" },
  });
  await runtime.scopeMap.scan("castalia-public");
  return { root, runtime, acceptedPath };
}

async function pair(runtime: Awaited<ReturnType<typeof fixture>>["runtime"], capabilities: ("read" | "write")[] = ["read", "write"]) {
  const created = await runtime.restHandler(request("/v1/obsidian/pairings", "POST", {
    workspaceId: "castalia-public",
    projectId: "abcm",
    projectPrefix: "abcm",
    capabilities,
  }, ADMIN_TOKEN));
  expect(created.status).toBe(201);
  const { pairingCode } = await created.json() as { pairingCode: string };
  const redeemed = await runtime.restHandler(request("/v1/obsidian/pairings/redeem", "POST", {
    pairingCode,
    device: { id: "device_operator_0001", name: "Operator vault", platform: "linux" },
  }));
  expect(redeemed.status).toBe(200);
  return await redeemed.json() as { credential: string };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("Obsidian accepted artifact amendments", () => {
  test("turns an authorized in-place edit into an accepted immutable revision and canonicalizes the stable path", async () => {
    const { root, runtime, acceptedPath } = await fixture();
    const grant = await pair(runtime);
    try {
      const baselineResponse = await runtime.restHandler(request(
        "/v1/workspaces/castalia-public/projects/abcm/sync/preview",
        "POST",
        { cursor: null, inventory: [{ path: "artifacts/adr/ADR-0001.md", checksum: checksum(baseBytes), size: Buffer.byteLength(baseBytes), contentType: "text/markdown" }] },
        grant.credential,
      ));
      const baseline = await baselineResponse.json() as { cursor: string };
      const changedChecksum = checksum(changedBytes);
      const previewResponse = await runtime.restHandler(request(
        "/v1/workspaces/castalia-public/projects/abcm/sync/preview",
        "POST",
        { cursor: baseline.cursor, inventory: [{ path: "artifacts/adr/ADR-0001.md", checksum: changedChecksum, size: Buffer.byteLength(changedBytes), contentType: "text/markdown" }] },
        grant.credential,
      ));
      const preview = await previewResponse.json() as {
        cursor: string;
        previewId: string;
        serverRevision: string;
        items: { action: string; objectId: string; path: string }[];
      };
      const item = preview.items.find(candidate => candidate.path === "artifacts/adr/ADR-0001.md")!;
      expect(item.action).toBe("update-server");
      const operation = {
        operationId: "op_accepted_amendment_0001",
        objectId: item.objectId,
        kind: "update",
        path: item.path,
        baseChecksum: checksum(baseBytes),
        checksum: changedChecksum,
        contentBase64: Buffer.from(changedBytes).toString("base64"),
        contentType: "text/markdown",
        size: Buffer.byteLength(changedBytes),
      };
      const batch = { cursor: preview.cursor, previewId: preview.previewId, serverRevision: preview.serverRevision, operations: [operation] };
      const response = await runtime.restHandler(request(
        "/v1/workspaces/castalia-public/projects/abcm/sync/apply",
        "POST",
        batch,
        grant.credential,
      ));
      expect(response.status).toBe(200);
      const applied = await response.json() as { receipts: { status: string; checksum: string }[] };
      const appliedReceipt = applied.receipts[0];
      expect(appliedReceipt).toBeDefined();
      if (appliedReceipt === undefined) throw new Error("Expected one applied amendment receipt.");
      expect(appliedReceipt.status).toBe("applied");
      expect(appliedReceipt.checksum).not.toBe(changedChecksum);

      const current = await readFile(acceptedPath, "utf8");
      expect(checksum(current)).toBe(appliedReceipt.checksum);
      expect(current).toContain("status: accepted");
      expect(current).toContain("supersedes: ADR-0001");
      expect(current).toContain("control-plane");
      const generatedId = /^id:\s*(\S+)$/m.exec(current)?.[1];
      expect(generatedId).toMatch(/^ADR-stable-decision-[a-f0-9]{24}$/);

      const archivedPath = join(root, "abcm", "artifacts", "adr", "revisions", "ADR-0001.md");
      expect(await readFile(archivedPath, "utf8")).toBe(baseBytes);
      const lineage = runtime.artifactAmendments.getLineage("castalia-public", "stable-decision");
      expect(lineage.headArtifactId).toBe(generatedId);
      expect(lineage.artifacts).toContainEqual(expect.objectContaining({ artifactId: "ADR-0001", lifecycle: "superseded", checksum: checksum(baseBytes) }));
      expect(lineage.artifacts).toContainEqual(expect.objectContaining({ artifactId: generatedId, lifecycle: "accepted", supersedes: "ADR-0001" }));

      const duplicate = await runtime.restHandler(request(
        "/v1/workspaces/castalia-public/projects/abcm/sync/apply",
        "POST",
        batch,
        grant.credential,
      ));
      expect(duplicate.status).toBe(200);
      expect((await duplicate.json() as { receipts: { status: string; checksum: string }[] }).receipts[0]).toEqual({
        ...appliedReceipt,
        status: "duplicate",
      });
      expect(await readFile(archivedPath, "utf8")).toBe(baseBytes);
    } finally {
      await runtime.close();
    }
  });

  test("returns a conflict for a stale accepted base without creating a second lineage head", async () => {
    const { runtime } = await fixture();
    const grant = await pair(runtime);
    try {
      const baselineResponse = await runtime.restHandler(request(
        "/v1/workspaces/castalia-public/projects/abcm/sync/preview", "POST",
        { cursor: null, inventory: [{ path: "artifacts/adr/ADR-0001.md", checksum: checksum(baseBytes), size: Buffer.byteLength(baseBytes), contentType: "text/markdown" }] },
        grant.credential,
      ));
      const baseline = await baselineResponse.json() as { cursor: string };
      const firstBytes = changedBytes;
      const secondBytes = changedBytes.replace("control-plane", "data-plane");
      const makePreview = async (content: string) => {
        const response = await runtime.restHandler(request(
          "/v1/workspaces/castalia-public/projects/abcm/sync/preview", "POST",
          { cursor: baseline.cursor, inventory: [{ path: "artifacts/adr/ADR-0001.md", checksum: checksum(content), size: Buffer.byteLength(content), contentType: "text/markdown" }] },
          grant.credential,
        ));
        return await response.json() as { cursor: string; previewId: string; serverRevision: string; items: { objectId: string; path: string }[] };
      };
      const [firstPreview, secondPreview] = await Promise.all([makePreview(firstBytes), makePreview(secondBytes)]);
      const apply = async (preview: Awaited<ReturnType<typeof makePreview>>, content: string, operationId: string) => runtime.restHandler(request(
        "/v1/workspaces/castalia-public/projects/abcm/sync/apply", "POST", {
          cursor: preview.cursor,
          previewId: preview.previewId,
          serverRevision: preview.serverRevision,
          operations: [{
            operationId,
            objectId: preview.items[0]!.objectId,
            kind: "update",
            path: preview.items[0]!.path,
            baseChecksum: checksum(baseBytes),
            checksum: checksum(content),
            contentBase64: Buffer.from(content).toString("base64"),
            contentType: "text/markdown",
            size: Buffer.byteLength(content),
          }],
        }, grant.credential,
      ));

      const accepted = await apply(firstPreview, firstBytes, "op_stale_winner_0000001");
      expect(accepted.status).toBe(200);
      expect((await accepted.json() as { receipts: { status: string }[] }).receipts[0]?.status).toBe("applied");
      const stale = await apply(secondPreview, secondBytes, "op_stale_loser_00000001");
      expect(stale.status).toBe(200);
      expect((await stale.json() as { receipts: { status: string; conflictId?: string }[] }).receipts[0]).toEqual(expect.objectContaining({
        status: "conflict",
        conflictId: expect.stringMatching(/^conflict_/),
      }));
      const lineage = runtime.artifactAmendments.getLineage("castalia-public", "stable-decision");
      expect(lineage.artifacts.filter(artifact => artifact.lifecycle === "accepted")).toHaveLength(1);
      expect(lineage.artifacts).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  test("does not delegate amendment approval to a read-only Obsidian integration", async () => {
    const { runtime } = await fixture();
    const grant = await pair(runtime, ["read"]);
    try {
      const previewResponse = await runtime.restHandler(request(
        "/v1/workspaces/castalia-public/projects/abcm/sync/preview", "POST",
        { cursor: null, inventory: [{ path: "artifacts/adr/ADR-0001.md", checksum: checksum(changedBytes), size: Buffer.byteLength(changedBytes), contentType: "text/markdown" }] },
        grant.credential,
      ));
      const preview = await previewResponse.json() as { cursor: string; previewId: string; serverRevision: string; items: { objectId: string; path: string }[] };
      const denied = await runtime.restHandler(request(
        "/v1/workspaces/castalia-public/projects/abcm/sync/apply", "POST", {
          cursor: preview.cursor,
          previewId: preview.previewId,
          serverRevision: preview.serverRevision,
          operations: [{
            operationId: "op_read_only_amend_00001",
            objectId: preview.items[0]!.objectId,
            kind: "update",
            path: preview.items[0]!.path,
            baseChecksum: checksum(baseBytes),
            checksum: checksum(changedBytes),
            contentBase64: Buffer.from(changedBytes).toString("base64"),
            contentType: "text/markdown",
            size: Buffer.byteLength(changedBytes),
          }],
        }, grant.credential,
      ));
      expect(denied.status).toBe(403);
      expect(runtime.artifactAmendments.getLineage("castalia-public", "stable-decision").artifacts).toEqual([
        expect.objectContaining({ artifactId: "ADR-0001", lifecycle: "accepted" }),
      ]);
    } finally {
      await runtime.close();
    }
  });
});
