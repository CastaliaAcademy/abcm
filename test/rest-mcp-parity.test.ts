import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture(documentation = false) {
  const root = await mkdtemp(join(tmpdir(), "abcm-rest-mcp-parity-"));
  roots.push(root);
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  let source: string | undefined;
  if (documentation) {
    source = await mkdtemp(join(tmpdir(), "abcm-rest-mcp-parity-source-"));
    roots.push(source);
    await writeFile(join(source, "note.md"), "---\nid: parity-note\nkind: note\ntitle: Parity\n---\nbody\n");
  }
  const runtime = createAbcmRuntime(
    { id: "test", root },
    documentation && source !== undefined
      ? {
          sqliteDerivedStoreEnabled: true,
          documentationSources: [{ id: "docs", workspaceId: "test", root: source, targetBasePath: "artifacts/docs" }],
        }
      : {},
  );
  await runtime.scopeMap.scan("test");
  const server = runtime.createMcpServer();
  const client = new Client({ name: "rest-mcp-parity-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { root, runtime, server, client };
}

function mcpErrorCode(result: { content: unknown[] }): string {
  return (JSON.parse((result.content[0] as { text: string }).text) as { code: string }).code;
}

describe("REST and MCP semantic parity", () => {
  test("observes identical file bytes, metadata, map digest, and expected errors", async () => {
    const { runtime, server, client } = await fixture();
    try {
      const written = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/files/content?path=parity.md", {
        method: "PUT",
        headers: { "if-none-match": "*" },
        body: "same canonical bytes",
      }));
      expect(written.status).toBe(200);
      const restEntry = await written.json() as { checksum: string; path: string };
      const mcpRead = await client.callTool({ name: "workspace.read_file", arguments: { workspaceId: "test", path: "parity.md" } });
      const mcpReadBody = mcpRead.structuredContent as { entry: { checksum: string; path: string }; content: string };
      expect(mcpReadBody.entry).toEqual(expect.objectContaining(restEntry));
      expect(Buffer.from(mcpReadBody.content, "base64").toString("utf8")).toBe("same canonical bytes");

      const restList = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/files?path="));
      const mcpList = await client.callTool({ name: "workspace.list_files", arguments: { workspaceId: "test" } });
      expect((mcpList.structuredContent as { entries: unknown[] }).entries).toEqual(await restList.json());

      const restScan = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/scope-map/scan", { method: "POST" }));
      const mcpScan = await client.callTool({ name: "scope_map.scan", arguments: { workspaceId: "test" } });
      const restSummary = await restScan.json() as { digest: string; resourceSummary: unknown };
      const mcpSummary = (mcpScan.structuredContent as { revision: { digest: string; resourceSummary: unknown } }).revision;
      expect(mcpSummary.digest).toBe(restSummary.digest);
      expect(mcpSummary.resourceSummary).toEqual(restSummary.resourceSummary);

      const restMissing = await runtime.restHandler(new Request("http://localhost/v1/workspaces/missing/files?path="));
      const mcpMissing = await client.callTool({ name: "workspace.list_files", arguments: { workspaceId: "missing" } });
      expect((await restMissing.json() as { code: string }).code).toBe(mcpErrorCode(mcpMissing));
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  test("maps the same mirror authorization failure through both adapters", async () => {
    const { runtime, server, client } = await fixture(true);
    try {
      const previewResponse = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/documentation-sources/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: "docs" }),
      }));
      const preview = await previewResponse.json() as { importId: string };
      await runtime.restHandler(new Request(`http://localhost/v1/documentation-imports/${preview.importId}/apply`, { method: "POST" }));

      const rest = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/files/content?path=artifacts%2Fdocs%2Fnote.md", {
        method: "PUT",
        body: "forbidden",
      }));
      const mcp = await client.callTool({
        name: "workspace.write_file",
        arguments: { workspaceId: "test", path: "artifacts/docs/note.md", content: "forbidden" },
      });
      expect(rest.status).toBe(409);
      expect((await rest.json() as { code: string }).code).toBe(mcpErrorCode(mcp));
      expect(await Bun.file(join(runtime.registry.get("test").root, "artifacts/docs/note.md")).text()).toContain("body");
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
