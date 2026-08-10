import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmMcpServer } from "../src/mcp/create-server.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("ABCM MCP adapter", () => {
  test("exposes file tools and ScopeMap resource over a real MCP connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-mcp-"));
    roots.push(root);
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await mkdir(join(root, "domain-language"));
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    const registry = new WorkspaceRegistry([{ id: "test", root }]);
    const scopeMap = new ScopeMapService(registry);
    const files = new WorkspaceFileService(registry, { onMutation: async () => void (await scopeMap.scan("test")) });
    const server = createAbcmMcpServer({ files, scopeMap, defaultWorkspaceId: "test" });
    const client = new Client({ name: "abcm-test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain("workspace.write_file");
      expect(tools.tools.map(tool => tool.name)).toContain("scope_map.scan");

      const write = await client.callTool({
        name: "workspace.write_file",
        arguments: { workspaceId: "test", path: "managed.md", content: "hello", encoding: "utf8", ifNoneMatch: "*" },
      });
      expect(write.isError).not.toBe(true);
      expect(write.structuredContent).toEqual(expect.objectContaining({ entry: expect.objectContaining({ path: "managed.md" }) }));

      const read = await client.callTool({ name: "workspace.read_file", arguments: { workspaceId: "test", path: "managed.md" } });
      expect(read.structuredContent).toEqual(expect.objectContaining({ content: "aGVsbG8=", encoding: "base64" }));

      const scan = await client.callTool({ name: "scope_map.scan", arguments: { workspaceId: "test" } });
      expect(scan.structuredContent).toEqual(expect.objectContaining({ revision: expect.objectContaining({ digest: expect.stringContaining("sha256:") }) }));

      const resource = await client.readResource({ uri: "abcm://map" });
      expect(resource.contents[0]).toEqual(expect.objectContaining({ uri: "abcm://map", mimeType: "application/json" }));
      expect(JSON.parse((resource.contents[0] as { text: string }).text)).toEqual(expect.objectContaining({ view: "agent" }));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
