import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport, ProtocolError } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmMcpServer } from "../src/mcp/create-server.js";
import { McpResourceCatalog } from "../src/mcp/resource-catalog.js";
import { indexScopeContent } from "../src/scope-map/content-indexer.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import type { ScopeMapAccess } from "../src/scope-map/types.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function addScope(root: string, relativePath: string, kind: string, id: string) {
  const directory = join(root, relativePath);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
}

async function addDocument(root: string, relativePath: string, id: string, kind: string, body: string) {
  await mkdir(join(root, relativePath, ".."), { recursive: true });
  await writeFile(join(root, relativePath), `---\nid: ${id}\nkind: ${kind}\ntitle: ${id}\nstatus: active\n---\n${body}\n`);
}

async function fixture(access?: ScopeMapAccess) {
  const root = await mkdtemp(join(tmpdir(), "abcm-mcp-resources-"));
  roots.push(root);
  await addScope(root, "", "workflow", "workflow");
  await addScope(root, "commerce", "project", "commerce");
  await addScope(root, "commerce/catalog", "service", "catalog");
  await addScope(root, "commerce/catalog/search", "feature", "search");
  await addScope(root, "commerce/billing", "service", "billing");
  await addDocument(root, "commerce/catalog/artifacts/plans/PLAN-1/plan.md", "catalog-plan", "plan", "catalog plan body");
  await addDocument(root, "commerce/catalog/architecture/catalog.md", "catalog-architecture", "architecture", "architecture body");
  await addDocument(root, "commerce/catalog/search/artifacts/search.md", "search-guide", "guide", "search guide body");
  await addDocument(root, "commerce/billing/artifacts/secret.md", "billing-secret", "guide", "must stay hidden");
  await mkdir(join(root, "commerce/catalog/agents/skills/catalog-helper"), { recursive: true });
  await writeFile(
    join(root, "commerce/catalog/agents/skills/catalog-helper/SKILL.md"),
    "---\nname: catalog-helper\ndescription: Helps with catalog work.\ncompatibility: abcm >=0.1\nmetadata:\n  abcm-skill-strategy: scope\n  abcm-lifecycle: active\n---\n# Catalog helper\n",
  );
  await writeFile(join(root, "commerce/catalog/agents/skills/catalog-helper/script.ts"), "throw new Error('not a resource body');\n");
  await writeFile(join(root, "commerce/catalog/README.md"), "ordinary source file\n");

  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const scopeMap = new ScopeMapService(registry);
  const files = new WorkspaceFileService(registry);
  await scopeMap.scan("test");
  const server = createAbcmMcpServer({
    files,
    scopeMap,
    defaultWorkspaceId: "test",
    ...(access === undefined ? {} : { scopeMapAccess: access }),
    mcpResourcePageSize: 2,
  });
  return { root, scopeMap, files, server };
}

async function connect(server: ReturnType<typeof createAbcmMcpServer>, versions = ["2025-11-25"]) {
  const client = new Client(
    { name: "resource-catalog-client", version: "0.1.0" },
    { supportedProtocolVersions: versions },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const catalogOnlyAccess: ScopeMapAccess = {
  workspacePermissions: [],
  scopeGrants: {
    workflow: ["scope.discover", "scope.read_metadata"],
    commerce: ["scope.discover", "scope.read_metadata"],
    catalog: ["scope.discover", "scope.read_metadata", "document.read"],
    search: ["scope.discover", "scope.read_metadata", "document.read"],
  },
};

describe("MCP resource catalog", () => {
  test("paginates and exposes only addressable, permitted maps, documents, and skills", async () => {
    const { server } = await fixture(catalogOnlyAccess);
    const client = await connect(server);
    try {
      expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect(client.getServerCapabilities()?.resources).toEqual(expect.objectContaining({ listChanged: false }));

      const listed = await client.listResources();
      expect(listed.nextCursor).toBeUndefined();
      expect(listed.resources.map(resource => resource.uri)).toEqual([
        "abcm://architecture/catalog-architecture",
        "abcm://artifact/search-guide",
        "abcm://map",
        "abcm://map/catalog",
        "abcm://map/commerce",
        "abcm://map/search",
        "abcm://map/workflow",
        "abcm://plan/catalog-plan",
        "abcm://skill/catalog-helper",
      ]);
      expect(JSON.stringify(listed.resources)).not.toContain("billing-secret");
      expect(JSON.stringify(listed.resources)).not.toContain("script.ts");
      expect(JSON.stringify(listed.resources)).not.toContain("README.md");

      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map(template => template.uriTemplate)).toEqual([
        "abcm://architecture/{documentId}",
        "abcm://artifact/{documentId}",
        "abcm://map/{scopeId}",
        "abcm://plan/{documentId}",
        "abcm://skill/{skillId}",
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("reads exact indexed content and bounded map projections", async () => {
    const { server } = await fixture(catalogOnlyAccess);
    const client = await connect(server);
    try {
      for (const [uri, body] of [
        ["abcm://plan/catalog-plan", "catalog plan body"],
        ["abcm://architecture/catalog-architecture", "architecture body"],
        ["abcm://artifact/search-guide", "search guide body"],
        ["abcm://skill/catalog-helper", "# Catalog helper"],
      ] as const) {
        const result = await client.readResource({ uri });
        const content = result.contents[0] as { text: string; uri: string };
        expect(content.uri).toBe(uri);
        expect(content.text).toContain(body);
      }

      const scoped = await client.readResource({ uri: "abcm://map/catalog" });
      const projection = JSON.parse((scoped.contents[0] as { text: string }).text) as { rootScopeId: string; nodes: Array<{ scopeId: string }> };
      expect(projection.rootScopeId).toBe("catalog");
      expect(projection.nodes.map(node => node.scopeId)).toEqual(["workflow", "commerce", "catalog", "search"]);
      expect(JSON.stringify(projection)).not.toContain("billing");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("fails closed for inaccessible, mismatched, stale, and invalid resource requests", async () => {
    const { root, scopeMap, files, server } = await fixture(catalogOnlyAccess);
    const client = await connect(server);
    try {
      for (const uri of [
        "abcm://artifact/billing-secret",
        "abcm://plan/search-guide",
        "abcm://map/billing",
        "abcm://artifact/unknown",
        "file:///etc/passwd",
      ]) {
        await expect(client.readResource({ uri })).rejects.toBeInstanceOf(ProtocolError);
      }

      await writeFile(join(root, "commerce/catalog/artifacts/plans/PLAN-1/plan.md"), "changed after scan\n");
      await expect(client.readResource({ uri: "abcm://plan/catalog-plan" })).rejects.toThrow("RESOURCE_STALE");

      await expect(client.listResources({ cursor: "not-an-opaque-cursor" })).rejects.toThrow("MCP pagination cursor");
      const catalog = new McpResourceCatalog({ files, scopeMap, workspaceId: "test", access: catalogOnlyAccess, pageSize: 2 });
      const first = await catalog.list(undefined, new AbortController().signal);
      expect(first.nextCursor).toBeString();
      await scopeMap.scan("test");
      await expect(catalog.list(first.nextCursor, new AbortController().signal)).rejects.toEqual(
        expect.objectContaining({ code: "MCP_CURSOR_INVALID" }),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("bounds resource operations by cancellation and server timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-mcp-resource-timeout-"));
    roots.push(root);
    await addScope(root, "", "workflow", "timeout-workflow");
    const registry = new WorkspaceRegistry([{ id: "timeout", root }]);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const scopeMap = new ScopeMapService(registry, undefined, undefined, {
      contentIndexer: async (workspace, scope) => {
        await gate;
        return indexScopeContent(workspace, scope);
      },
    });
    const catalog = new McpResourceCatalog({
      files: new WorkspaceFileService(registry),
      scopeMap,
      workspaceId: "timeout",
      operationTimeoutMs: 5,
    });

    await expect(catalog.list(undefined, new AbortController().signal)).rejects.toEqual(
      expect.objectContaining({ code: "MCP_OPERATION_TIMEOUT" }),
    );
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(catalog.list(undefined, cancelled.signal)).rejects.toEqual(
      expect.objectContaining({ name: "AbortError" }),
    );
    release();
    await scopeMap.scan("timeout");
  });
});
