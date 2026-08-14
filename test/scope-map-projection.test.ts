import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmMcpServer } from "../src/mcp/create-server.js";
import { createAbcmRestHandler } from "../src/rest/create-rest-handler.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import type { ScopeMapAccess } from "../src/scope-map/types.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function addScope(root: string, relativePath: string, kind: string, id: string, aliases: string[] = []) {
  const directory = join(root, relativePath);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await writeFile(
    join(directory, "scope.yaml"),
    `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\naliases: [${aliases.join(", ")}]\n`,
  );
  await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-projection-"));
  roots.push(root);
  await addScope(root, "", "workflow", "workflow");
  await addScope(root, "project", "project", "project");
  await addScope(root, "project/catalog", "service", "catalog", ["products"]);
  await addScope(root, "project/catalog/search", "feature", "search");
  await addScope(root, "project/billing", "service", "billing");
  await addScope(root, "project/repeated", "project", "invalid-branch");
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const scopeMap = new ScopeMapService(registry);
  const files = new WorkspaceFileService(registry);
  await scopeMap.scan("test");
  return { root, scopeMap, files };
}

const localCatalogAccess: ScopeMapAccess = {
  workspacePermissions: [],
  scopeGrants: {
    catalog: ["scope.discover", "scope.read_metadata"],
    search: ["scope.discover", "scope.read_metadata"],
  },
};

describe("bounded ScopeMap projection", () => {
  test("applies root/depth and returns only a minimal path-only ancestor chain", async () => {
    const { scopeMap } = await fixture();

    const projection = scopeMap.getProjection(
      "test",
      { view: "agent", rootScopeId: "products", depth: 0 },
      localCatalogAccess,
    );

    expect(projection).toEqual(
      expect.objectContaining({
        view: "agent",
        rootScopeId: "catalog",
        depth: 0,
        includeInvalid: false,
        resolverEntrypoints: ["context.get_domain_language", "context.build_task_context"],
      }),
    );
    expect(projection.nodes.map(node => [node.scopeId, node.pathOnly])).toEqual([
      ["workflow", true],
      ["project", true],
      ["catalog", false],
    ]);
    expect(projection.nodes.find(node => node.scopeId === "catalog")?.directChildScopeIds).toEqual([]);
    expect(projection.nodes.map(node => node.scopeId)).not.toContain("billing");
    expect(projection.resourceSummary.indexedFiles).toBe(2);
    expect(projection).not.toHaveProperty("admin");
    expect(JSON.stringify(projection)).not.toContain("DomainLanguageConvention.md");
    expect(JSON.stringify(projection)).not.toContain("scope.yaml");
  });

  test("enforces discover, metadata and full-map permissions independently", async () => {
    const { scopeMap } = await fixture();

    for (const workspacePermissions of [[], ["scope.discover"]] as const) {
      expect(() =>
        scopeMap.getProjection(
          "test",
          { view: "agent" },
          { workspacePermissions },
        ),
      ).toThrow(expect.objectContaining({ code: "ACCESS_DENIED" }));
    }
    expect(() =>
      scopeMap.getProjection(
        "test",
        { view: "admin", includeInvalid: true },
        { workspacePermissions: ["scope.discover", "scope.read_metadata"] },
      ),
    ).toThrow(expect.objectContaining({ code: "ACCESS_DENIED" }));
    expect(() =>
      scopeMap.getProjection(
        "test",
        { view: "agent", includeInvalid: true },
        { workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full"] },
      ),
    ).toThrow(expect.objectContaining({ code: "REQUEST_INVALID" }));

    const admin = scopeMap.getProjection(
      "test",
      { view: "admin", includeInvalid: true },
      { workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full"] },
    );
    expect(admin.nodes.map(node => node.scopeId)).toContain("invalid-branch");
    expect(admin.warnings).toContainEqual(expect.objectContaining({ code: "SCOPE_HIERARCHY_INVALID" }));
    expect(admin.admin).toEqual(
      expect.objectContaining({
        scanCreatedAt: expect.any(String),
        diagnosticsSummary: expect.objectContaining({ branchErrors: 1 }),
        fileClassificationCounts: expect.objectContaining({ scope_manifest: 5, domain_language: 5 }),
        documentationSyncSummary: { managedDocuments: 0, mirroredDocuments: 0, sourceIds: [] },
      }),
    );
  });

  test("filters REST projections and validates all bound parameters", async () => {
    const { scopeMap, files } = await fixture();
    const handler = createAbcmRestHandler({ files, scopeMap, scopeMapAccess: localCatalogAccess });
    const call = (path: string) => handler(new Request(`http://localhost${path}`));

    const response = await call("/v1/workspaces/test/scope-map?view=agent&rootScopeId=products&depth=1&includeInvalid=false");
    expect(response.status).toBe(200);
    const projection = (await response.json()) as { nodes: Array<{ scopeId: string }> };
    expect(projection.nodes.map(node => node.scopeId)).toEqual(["workflow", "project", "catalog", "search"]);

    for (const query of ["depth=-1", "depth=1.5", "includeInvalid=yes", "view=admin"]) {
      const invalid = await call(`/v1/workspaces/test/scope-map?${query}`);
      expect(invalid.status).toBe(query === "view=admin" ? 403 : 400);
    }
  });

  test("uses the same permission-filtered agent projection through MCP", async () => {
    const { scopeMap, files } = await fixture();
    const server = createAbcmMcpServer({ files, scopeMap, defaultWorkspaceId: "test", scopeMapAccess: localCatalogAccess });
    const client = new Client({ name: "projection-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const resource = await client.readResource({ uri: "abcm://map" });
      const projection = JSON.parse((resource.contents[0] as { text: string }).text) as {
        nodes: Array<{ scopeId: string }>;
      };
      expect(projection.nodes.map(node => node.scopeId)).toEqual(["workflow", "project", "catalog", "search"]);
      expect(JSON.stringify(projection)).not.toContain("billing");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects an MCP map resource without an effective discover grant", async () => {
    const { scopeMap, files } = await fixture();
    const server = createAbcmMcpServer({
      files,
      scopeMap,
      defaultWorkspaceId: "test",
      scopeMapAccess: { workspacePermissions: [] },
    });
    const client = new Client({ name: "projection-denied-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      await expect(client.readResource({ uri: "abcm://map" })).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
