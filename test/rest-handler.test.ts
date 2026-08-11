import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRestHandler } from "../src/rest/create-rest-handler.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceProvisioningService } from "../src/workspace/provisioning-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

let root: string;
let fetchHandler: (request: Request) => Promise<Response>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "abcm-rest-"));
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const scopeMap = new ScopeMapService(registry);
  const files = new WorkspaceFileService(registry, {
    onMutation: async workspaceId => void (await scopeMap.scan(workspaceId)),
  });
  fetchHandler = createAbcmRestHandler({ files, scopeMap });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function call(path: string, init?: RequestInit) {
  return fetchHandler(new Request(`http://localhost${path}`, init));
}

describe("ABCM REST handler", () => {
  test("reports managed workspace registration as disabled when no store is configured", async () => {
    const response = await call("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "castalia-public" }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: "WORKSPACE_REGISTRATION_DISABLED", status: 503 }),
    );
  });

  test("registers a managed workspace and exposes it through existing file routes", async () => {
    const registry = new WorkspaceRegistry([{ id: "test", root }]);
    const scopeMap = new ScopeMapService(registry);
    const files = new WorkspaceFileService(registry, {
      onMutation: async workspaceId => void (await scopeMap.scan(workspaceId)),
    });
    const managedHandler = createAbcmRestHandler({
      files,
      scopeMap,
      workspaces: new WorkspaceProvisioningService({
        registry,
        files,
        scopeMap,
        storeRoot: join(root, "managed-workspaces"),
      }),
    });
    const callManaged = (path: string, init?: RequestInit) => managedHandler(new Request(`http://localhost${path}`, init));

    const created = await callManaged("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "castalia-public", name: "Castalia Public" }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ id: "castalia-public" });

    const listed = await callManaged("/v1/workspaces/castalia-public/files?recursive=true");
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "scope.yaml" }),
        expect.objectContaining({ path: "domain-language/DomainLanguageConvention.md" }),
      ]),
    );

    const duplicate = await callManaged("/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "castalia-public" }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual(expect.objectContaining({ code: "WORKSPACE_ALREADY_EXISTS", status: 409 }));

    for (const body of [{ id: "../escape" }, { id: "another", root: "/tmp/escape" }]) {
      const invalid = await callManaged("/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual(expect.objectContaining({ code: "REQUEST_INVALID", status: 400 }));
    }
  });

  test("serves health and complete file lifecycle with ETags", async () => {
    expect((await call("/health")).status).toBe(200);

    expect(
      (
        await call("/v1/workspaces/test/directories", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: "managed" }),
        })
      ).status,
    ).toBe(201);

    const created = await call("/v1/workspaces/test/files/content?path=managed%2Fa.md", {
      method: "PUT",
      headers: { "if-none-match": "*" },
      body: "alpha",
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { checksum: string };

    const read = await call("/v1/workspaces/test/files/content?path=managed%2Fa.md");
    expect(await read.text()).toBe("alpha");
    expect(read.headers.get("etag")).toBe(`"${createdBody.checksum}"`);

    const moved = await call("/v1/workspaces/test/files/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "managed/a.md", to: "managed/b.md", ifMatch: createdBody.checksum }),
    });
    expect(moved.status).toBe(200);

    const listed = await call("/v1/workspaces/test/files?path=managed");
    expect((await listed.json()) as unknown).toEqual([expect.objectContaining({ path: "managed/b.md" })]);

    const deleted = await call("/v1/workspaces/test/files?path=managed%2Fb.md", {
      method: "DELETE",
      headers: { "if-match": `"${createdBody.checksum}"` },
    });
    expect(deleted.status).toBe(204);
  });

  test("maps stale and forbidden paths to stable problems", async () => {
    const created = await call("/v1/workspaces/test/files/content?path=plan.md", {
      method: "PUT",
      headers: { "if-none-match": "*" },
      body: "v1",
    });
    const checksum = ((await created.json()) as { checksum: string }).checksum;

    const stale = await call("/v1/workspaces/test/files/content?path=plan.md", {
      method: "PUT",
      headers: { "if-match": `"${checksum}-stale"` },
      body: "v2",
    });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toEqual(expect.objectContaining({ code: "FILE_CHECKSUM_MISMATCH", status: 412 }));

    const forbidden = await call("/v1/workspaces/test/files/content?path=.git%2Fconfig");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual(expect.objectContaining({ code: "FILE_PATH_FORBIDDEN" }));
  });

  test("rejects request bodies over the configured limit", async () => {
    const oversized = await call("/v1/workspaces/test/files/content?path=large.md", {
      method: "PUT",
      body: "x".repeat(1_048_577),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
  });

  test("scans and projects ScopeMap", async () => {
    const scan = await call("/v1/workspaces/test/scope-map/scan", { method: "POST" });
    expect(scan.status).toBe(200);
    const projection = await call("/v1/workspaces/test/scope-map?view=agent");
    expect(projection.status).toBe(200);
    expect(await projection.json()).toEqual(
      expect.objectContaining({ view: "agent", nodes: [expect.objectContaining({ scopeId: "test" })] }),
    );
  });
});
