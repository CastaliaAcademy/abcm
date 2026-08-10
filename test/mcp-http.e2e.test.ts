import { afterEach, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];
const token = "test-token-123456789";

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-mcp-http-"));
  roots.push(root);
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  return root;
}

describe("ABCM Streamable HTTP MCP endpoint", () => {
  test("serves authenticated MCP tools through the shared HTTP runtime", async () => {
    const root = await fixture();
    const runtime = createAbcmRuntime({ id: "test", root }, { bearerToken: token });
    await runtime.scopeMap.scan("test");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: runtime.httpHandler });
    const client = new Client({ name: "abcm-http-test-client", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      authProvider: { token: async () => token },
    });

    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toContain("workspace.read_file");
      expect(tools.tools.find(tool => tool.name === "workspace.read_file")?.annotations?.readOnlyHint).toBe(true);

      const write = await client.callTool({
        name: "workspace.write_file",
        arguments: { workspaceId: "test", path: "through-mcp.md", content: "remote", ifNoneMatch: "*" },
      });
      expect(write.isError).not.toBe(true);
      expect(await Bun.file(join(root, "through-mcp.md")).text()).toBe("remote");

      const restRead = await fetch(new URL("/v1/workspaces/test/files/content?path=through-mcp.md", server.url), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(await restRead.text()).toBe("remote");
    } finally {
      await client.close();
      server.stop(true);
      await runtime.close();
    }
  });

  test("requires authentication and validates Host and Origin before MCP dispatch", async () => {
    const root = await fixture();
    const runtime = createAbcmRuntime({ id: "test", root }, { bearerToken: token });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    try {
      const unauthenticated = await runtime.httpHandler(
        new Request("http://localhost/mcp", { method: "POST", headers: { "content-type": "application/json" }, body }),
      );
      expect(unauthenticated.status).toBe(401);

      const invalidHost = await runtime.httpHandler(
        new Request("http://evil.example/mcp", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", host: "evil.example" },
          body,
        }),
      );
      expect(invalidHost.status).toBe(403);

      const invalidOrigin = await runtime.httpHandler(
        new Request("http://localhost/mcp", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            host: "localhost",
            origin: "https://evil.example",
          },
          body,
        }),
      );
      expect(invalidOrigin.status).toBe(403);
    } finally {
      await runtime.close();
    }
  });
});
