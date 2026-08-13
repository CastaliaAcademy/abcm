import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-mcp-tool-contract-"));
  const source = await mkdtemp(join(tmpdir(), "abcm-mcp-tool-source-"));
  roots.push(root, source);
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(source, "guide.md"), "guide\n");
  const access = {
    workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read"] as const,
  };
  const runtime = createAbcmRuntime(
    { id: "test", root },
    {
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: { principalId: "tool-contract", access },
      scopeMapAccess: access,
      documentationSources: [{ id: "docs", workspaceId: "test", root: source, targetBasePath: "artifacts/mirror" }],
    },
  );
  const server = runtime.createMcpServer();
  const client = new Client({ name: "tool-contract-client", version: "0.1.0" }, { supportedProtocolVersions: ["2025-11-25"] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { root, runtime, server, client };
}

describe("MCP tool contract", () => {
  test("publishes strict input and structured output schemas for every operation", async () => {
    const { runtime, server, client } = await fixture();
    try {
      const listed = await client.listTools();
      expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect(client.getServerCapabilities()?.experimental?.["abcm.dev/contract"]).toEqual({
        contractVersion: "0.1.0",
        specificationVersion: "0.5.0",
        supportedProtocolVersions: ["2025-11-25"],
        operationTimeoutMs: 30000,
        toolErrors: { encoding: "isError-json", version: "1" },
      });
      expect(listed.tools.map(tool => tool.name)).toEqual([
        "workspace.list_files",
        "workspace.read_file",
        "workspace.write_file",
        "workspace.delete_file",
        "workspace.move_file",
        "workspace.create_directory",
        "scope_map.scan",
        "context.get_domain_language",
        "context.build_task_context",
        "documentation_source.preview",
        "documentation_source.apply",
        "documentation_source.sync",
        "documentation_source.cutover",
      ]);
      for (const tool of listed.tools) {
        expect(tool.inputSchema).toEqual(expect.objectContaining({ type: "object", additionalProperties: false }));
        expect(tool.outputSchema).toEqual(expect.objectContaining({ type: "object", additionalProperties: false }));
        expect(tool.annotations?.openWorldHint).toBe(false);
      }
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  test("separates schema rejection from stable ABCM execution errors", async () => {
    const { runtime, server, client } = await fixture();
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const rejected = await client.callTool({ name: tool.name, arguments: { unexpected: true } });
        expect(rejected.isError).toBe(true);
        expect((rejected.content[0] as { text: string }).text).toContain("Input validation error");
      }

      const missing = await client.callTool({
        name: "workspace.list_files",
        arguments: { workspaceId: "missing" },
      });
      expect(missing.isError).toBe(true);
      expect(JSON.parse((missing.content[0] as { text: string }).text)).toEqual(expect.objectContaining({
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace 'missing' is not registered.",
      }));

      const errorCases = [
        ["workspace.read_file", { workspaceId: "missing", path: "a.md" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.write_file", { workspaceId: "missing", path: "a.md", content: "a" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.delete_file", { workspaceId: "missing", path: "a.md" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.move_file", { workspaceId: "missing", from: "a.md", to: "b.md" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.create_directory", { workspaceId: "missing", path: "a" }, "WORKSPACE_NOT_FOUND"],
        ["scope_map.scan", { workspaceId: "missing" }, "WORKSPACE_NOT_FOUND"],
        ["context.get_domain_language", { anchor: { workspaceId: "missing", projectId: "missing" } }, "MAP_NOT_BUILT"],
        [
          "context.build_task_context",
          { domainLanguageBootstrapId: "missing", roleId: "role", taskType: "test", goal: "test" },
          "DOMAIN_LANGUAGE_BOOTSTRAP_REQUIRED",
        ],
        ["documentation_source.preview", { workspaceId: "test", sourceId: "missing" }, "SOURCE_CONNECTOR_UNAVAILABLE"],
        ["documentation_source.apply", { importId: "missing" }, "DOCUMENTATION_IMPORT_NOT_FOUND"],
        ["documentation_source.sync", { sourceId: "missing" }, "SOURCE_CONNECTOR_UNAVAILABLE"],
      ] as const;
      for (const [name, arguments_, code] of errorCases) {
        const failed = await client.callTool({ name, arguments: arguments_ });
        expect(failed.isError).toBe(true);
        expect(JSON.parse((failed.content[0] as { text: string }).text)).toEqual(expect.objectContaining({ code }));
      }

      const happy = await client.callTool({
        name: "workspace.list_files",
        arguments: { workspaceId: "test" },
      });
      expect(happy.isError).not.toBe(true);
      expect(happy.structuredContent).toEqual(expect.objectContaining({ entries: expect.any(Array) }));
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
