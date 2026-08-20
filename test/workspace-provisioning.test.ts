import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceProvisioningService, discoverManagedWorkspaces } from "../src/workspace/provisioning-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

let temporaryRoot: string;
let storeRoot: string;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "abcm-workspace-provisioning-"));
  storeRoot = join(temporaryRoot, "workspaces");
});

afterEach(async () => {
  await rm(temporaryRoot, { recursive: true, force: true });
});

function createService() {
  const registry = new WorkspaceRegistry([]);
  const scopeMap = new ScopeMapService(registry);
  const files = new WorkspaceFileService(registry, {
    onMutation: async workspaceId => void (await scopeMap.scan(workspaceId)),
  });
  return {
    files,
    registry,
    scopeMap,
    service: new WorkspaceProvisioningService({ registry, files, scopeMap, storeRoot }),
  };
}

describe("WorkspaceProvisioningService", () => {
  test("creates a ready workflow below the managed store and discovers it after restart", async () => {
    const { files, registry, scopeMap, service } = createService();

    await expect(service.create({ id: "castalia-public", name: "Castalia Public", language: "ru" })).resolves.toEqual({
      id: "castalia-public",
    });
    expect(registry.get("castalia-public").root).toBe(join(storeRoot, "castalia-public"));
    expect(new TextDecoder().decode((await files.read("castalia-public", "scope.yaml")).content)).toContain(
      "kind: workflow",
    );
    expect(
      new TextDecoder().decode(
        (await files.read("castalia-public", "domain-language/DomainLanguageConvention.md")).content,
      ),
    ).toContain("mode: inherit-only");
    expect(new TextDecoder().decode((await files.read("castalia-public", "config/architecture.yaml")).content)).toContain(
      "architecture: abcm-mvp-agent-spec-v0.5",
    );
    expect(new TextDecoder().decode((await files.read("castalia-public", "config/context.yaml")).content)).toContain(
      "language: ru",
    );
    expect(scopeMap.getProjection("castalia-public").nodes).toEqual([
      expect.objectContaining({ scopeId: "castalia-public", kind: "workflow", readiness: "ready" }),
    ]);

    expect(await discoverManagedWorkspaces(storeRoot)).toEqual([
      expect.objectContaining({ id: "castalia-public", root: join(storeRoot, "castalia-public") }),
    ]);
  });

  test("rejects invalid ids and pre-existing targets without changing existing bytes", async () => {
    const { service } = createService();
    await expect(service.create({ id: "../escape", language: "ru" })).rejects.toEqual(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
    await expect(stat(join(temporaryRoot, "escape"))).rejects.toEqual(expect.objectContaining({ code: "ENOENT" }));
    await expect(service.create({ id: "invalid-language", language: "русский" })).rejects.toEqual(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
    await expect(stat(join(storeRoot, "invalid-language"))).rejects.toEqual(expect.objectContaining({ code: "ENOENT" }));

    const existing = join(storeRoot, "castalia-public");
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, "keep.txt"), "keep");

    await expect(service.create({ id: "castalia-public", language: "ru" })).rejects.toEqual(
      expect.objectContaining({ code: "WORKSPACE_ALREADY_EXISTS" }),
    );
    expect(await readFile(join(existing, "keep.txt"), "utf8")).toBe("keep");
  });

  test("does not rediscover the explicitly configured workspace under a directory alias id", async () => {
    const physicalRoot = join(storeRoot, "public");
    await mkdir(physicalRoot, { recursive: true });
    await writeFile(join(physicalRoot, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: castalia-public\n");
    expect(await discoverManagedWorkspaces(storeRoot)).toEqual([
      expect.objectContaining({ id: "public", root: physicalRoot }),
    ]);
    expect(await discoverManagedWorkspaces(storeRoot, [physicalRoot])).toEqual([]);
  });

  test("runtime registration becomes immediately available to files and survives discovery", async () => {
    const primaryRoot = join(temporaryRoot, "primary");
    await mkdir(join(primaryRoot, "domain-language"), { recursive: true });
    await writeFile(join(primaryRoot, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: primary\n");
    await writeFile(
      join(primaryRoot, "domain-language/DomainLanguageConvention.md"),
      "---\nmode: inherit-only\n---\n",
    );
    const runtime = createAbcmRuntime({ id: "primary", root: primaryRoot }, { workspaceStoreRoot: storeRoot });

    const response = await runtime.restHandler(
      new Request("http://localhost/v1/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "castalia-public", name: "Castalia Public", language: "ru" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(runtime.registry.has("castalia-public")).toBe(true);
    expect((await runtime.files.list("castalia-public", "", true)).map(entry => entry.path)).toContain("scope.yaml");
    expect(await discoverManagedWorkspaces(storeRoot)).toEqual([
      expect.objectContaining({ id: "castalia-public", root: join(storeRoot, "castalia-public") }),
    ]);
    await runtime.close();
  });

  test("creates the same managed workspace through MCP without accepting a host path", async () => {
    const primaryRoot = join(temporaryRoot, "primary-mcp");
    await mkdir(join(primaryRoot, "domain-language"), { recursive: true });
    await writeFile(join(primaryRoot, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: primary\n");
    await writeFile(
      join(primaryRoot, "domain-language/DomainLanguageConvention.md"),
      "---\nmode: inherit-only\n---\n",
    );
    const runtime = createAbcmRuntime({ id: "primary", root: primaryRoot }, { workspaceStoreRoot: storeRoot });
    const server = runtime.createMcpServer();
    const client = new Client({ name: "workspace-provisioning-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain("workspace.create");
      const rejected = await client.callTool({
        name: "workspace.create",
        arguments: { id: "unsafe", language: "ru", root: "C:/outside" },
      });
      expect(rejected.isError).toBe(true);
      expect((rejected.content[0] as { text: string }).text).toContain("Input validation error");

      const created = await client.callTool({
        name: "workspace.create",
        arguments: { id: "castalia-public", name: "Castalia Public", language: "ru" },
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toEqual({ id: "castalia-public" });
      expect(runtime.registry.get("castalia-public").root).toBe(join(storeRoot, "castalia-public"));
      expect(new TextDecoder().decode(
        (await runtime.files.read("castalia-public", "config/context.yaml")).content,
      )).toContain("language: ru");

      const duplicate = await client.callTool({
        name: "workspace.create",
        arguments: { id: "castalia-public", language: "ru" },
      });
      expect(duplicate.isError).toBe(true);
      expect(JSON.parse((duplicate.content[0] as { text: string }).text)).toEqual(
        expect.objectContaining({ code: "WORKSPACE_ALREADY_EXISTS" }),
      );
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
