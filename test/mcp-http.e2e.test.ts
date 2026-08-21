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

async function linkPackageWorkspace(id: string) {
  const root = await mkdtemp(join(tmpdir(), `abcm-mcp-http-${id}-`));
  roots.push(root);
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "project/config"), { recursive: true });
  await mkdir(join(root, "project/domain-language"), { recursive: true });
  await mkdir(join(root, "project/artifacts"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), `apiVersion: abcm/v1\nkind: workflow\nid: ${id}\nname: ${id}\n`);
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
  await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/artifacts/tagged.md"), "---\nid: tagged\nkind: guide\ntitle: Tagged\ntags: [transport]\n---\nTransport contract.\n");
  return root;
}

describe("ABCM Streamable HTTP MCP endpoint", () => {
  test("can be disabled without disabling REST", async () => {
    const root = await fixture();
    const runtime = createAbcmRuntime(
      { id: "test", root },
      { bearerToken: token, mcpHttpEnabled: false },
    );

    try {
      const mcp = await runtime.httpHandler(
        new Request("http://localhost/mcp", { headers: { authorization: `Bearer ${token}` } }),
      );
      expect(mcp.status).toBe(404);

      const health = await runtime.httpHandler(new Request("http://localhost/health"));
      expect(health.status).toBe(200);

      const files = await runtime.httpHandler(
        new Request("http://localhost/v1/workspaces/test/files?path=", {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(files.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });

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
      const resources = await client.listResources();
      expect(resources.resources.map(resource => resource.uri)).toContain("abcm://map");
      const map = await client.readResource({ uri: "abcm://map" });
      expect(JSON.parse((map.contents[0] as { text: string }).text)).toEqual(expect.objectContaining({ view: "agent" }));

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

  test("keeps the ABCM resource contract under SDK dual-protocol auto negotiation", async () => {
    const root = await fixture();
    const runtime = createAbcmRuntime({ id: "test", root }, { bearerToken: token });
    await runtime.scopeMap.scan("test");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: runtime.httpHandler });
    const client = new Client(
      { name: "abcm-modern-http-test-client", version: "0.1.0" },
      { versionNegotiation: { mode: "auto" } },
    );
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      authProvider: { token: async () => token },
    });

    try {
      await client.connect(transport);
      const resources = await client.listResources();
      expect(resources.resources.map(resource => resource.uri)).toContain("abcm://map");
      const map = await client.readResource({ uri: "abcm://map" });
      expect(JSON.parse((map.contents[0] as { text: string }).text)).toEqual(expect.objectContaining({ view: "agent" }));
    } finally {
      await client.close();
      server.stop(true);
      await runtime.close();
    }
  });

  test("preserves LinkPackage domain errors through Streamable HTTP", async () => {
    const firstRoot = await linkPackageWorkspace("first");
    const secondRoot = await linkPackageWorkspace("second");
    const access = { workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read"] as const };
    const principal = { principalId: "http-link-package", access };
    const runtime = createAbcmRuntime([{ id: "first", root: firstRoot }, { id: "second", root: secondRoot }], {
      bearerToken: token,
      contextPrincipal: principal,
      scopeMapAccess: access,
    });
    await runtime.scopeMap.scan("first");
    await runtime.scopeMap.scan("second");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: runtime.httpHandler });
    const client = new Client({ name: "abcm-link-package-http-client", version: "0.1.0" }, { versionNegotiation: { mode: "auto" } });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
      authProvider: { token: async () => token },
    });
    try {
      await client.connect(transport);
      const firstPackage = runtime.contextLinkPackages!.list("first").find(candidate => candidate.tag === "transport")!;
      const secondBootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "second", projectId: "project" } }, principal);
      const cases = [
        ["context.get_link_package", { workspaceId: "first", packageId: `tag-package-${"0".repeat(24)}` }, "CONTEXT_LINK_PACKAGE_NOT_FOUND"],
        ["context.build_from_link_package", {
          workspaceId: "first",
          packageId: firstPackage.packageId,
          request: { domainLanguageBootstrapId: secondBootstrap.bootstrapId, roleId: "agent", taskType: "research", goal: "Cross workspace", targetHints: { scopeIds: ["project"] } },
        }, "CONTEXT_LINK_PACKAGE_STALE"],
        ["context.build_from_link_package", {
          workspaceId: "second",
          packageId: firstPackage.packageId,
          request: { domainLanguageBootstrapId: secondBootstrap.bootstrapId, roleId: "agent", taskType: "research", goal: "Wrong package identity", targetHints: { scopeIds: ["project"] } },
        }, "CONTEXT_LINK_PACKAGE_NOT_FOUND"],
      ] as const;
      for (const [name, arguments_, code] of cases) {
        const failed = await client.callTool({ name, arguments: arguments_ });
        expect(failed.isError).toBe(true);
        expect(JSON.parse((failed.content[0] as { text: string }).text)).toEqual(expect.objectContaining({ code }));
        expect(failed.structuredContent).toEqual(expect.objectContaining({ error_code: code }));
      }
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
