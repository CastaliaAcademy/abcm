import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { DomainLanguageService } from "../src/domain-language/domain-language-service.js";
import { parseContextPrincipalEnvironment } from "../src/domain-language/context-principal-config.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function addScope(root: string, path: string, kind: string, id: string) {
  const directory = join(root, path);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  if (kind === "project") {
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  }
  await writeFile(
    join(directory, "domain-language/DomainLanguageConvention.md"),
    "---\napiVersion: abcm/v1\nkind: DomainLanguageConvention\nmode: extend\n---\n",
  );
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-domain-language-"));
  roots.push(root);
  await addScope(root, "", "workflow", "workflow");
  await addScope(root, "project", "project", "commerce");
  await addScope(root, "project/catalog", "service", "catalog");
  await writeFile(
    join(root, "domain-language/domains.yaml"),
    "apiVersion: abcm/v1\nkind: DomainLanguageDomains\ndomains:\n  - id: commerce\n    name: Commerce\n    locked: true\n",
  );
  await writeFile(
    join(root, "domain-language/glossary.yaml"),
    "apiVersion: abcm/v1\nkind: DomainLanguageGlossary\nconcepts:\n  - id: commerce.order\n    domainId: commerce\n    term: Order\n    definition: A purchase intent.\n    locked: true\n",
  );
  await writeFile(
    join(root, "project/domain-language/aliases.yaml"),
    "apiVersion: abcm/v1\nkind: DomainLanguageAliases\naliases:\n  - term: purchase\n    canonicalTerm: commerce.order\n  - term: old-order\n    canonicalTerm: commerce.order\n    deprecated: true\nhomonyms:\n  - term: order\n    canonicalTerms: [commerce.order]\n",
  );
  await writeFile(
    join(root, "project/domain-language/naming.yaml"),
    "apiVersion: abcm/v1\nkind: DomainLanguageNaming\nrules:\n  service: kebab-case\n",
  );
  await writeFile(
    join(root, "project/catalog/domain-language/domains.yaml"),
    "apiVersion: abcm/v1\nkind: DomainLanguageDomains\ndomains:\n  - id: catalog\n    name: Catalog\n",
  );
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const scopeMap = new ScopeMapService(registry);
  await scopeMap.scan("test");
  return { root, registry, scopeMap, domainLanguage: new DomainLanguageService(registry, scopeMap) };
}

const principal: ContextPrincipal = {
  principalId: "agent:executor",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build"] },
};

describe("DomainLanguageBootstrap", () => {
  test("parses a strict static reference principal profile", () => {
    expect(parseContextPrincipalEnvironment({}, "static-bearer")).toEqual(
      expect.objectContaining({
        principalId: "static-bearer",
        access: expect.objectContaining({ workspacePermissions: expect.arrayContaining(["context.build", "scope.discover"]) }),
      }),
    );
    expect(() => parseContextPrincipalEnvironment({ ABCM_CONTEXT_PERMISSIONS: "scope.discover,unknown" }, "static")).toThrow();
  });

  test("rejects bootstrap when the project language configuration is invalid", async () => {
    const { root, scopeMap, domainLanguage } = await fixture();
    await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\n");
    await scopeMap.scan("test");

    await expect(domainLanguage.createBootstrap(
      { anchor: { workspaceId: "test", projectId: "commerce" } },
      principal,
    )).rejects.toEqual(expect.objectContaining({ code: "PROJECT_LANGUAGE_CONFIGURATION_INVALID" }));
  });

  test("pins and merges workflow plus project sources without loading local service language", async () => {
    const { domainLanguage } = await fixture();

    const bootstrap = await domainLanguage.createBootstrap(
      { anchor: { workspaceId: "test", projectId: "commerce" }, roleId: "executor-agent" },
      principal,
    );
    const repeated = await domainLanguage.createBootstrap(
      { anchor: { workspaceId: "test", projectId: "commerce" }, roleId: "executor-agent" },
      principal,
    );

    expect(bootstrap).toEqual(
      expect.objectContaining({
        anchor: { workspaceId: "test", projectId: "commerce" },
        roleId: "executor-agent",
        readiness: "ready",
        mapRevision: expect.stringContaining("sha256:"),
        bootstrapDigest: repeated.bootstrapDigest,
      }),
    );
    expect([...new Set(bootstrap.sourceConventions.map(source => source.scopeId))]).toEqual(["workflow", "commerce"]);
    expect(bootstrap.effectiveLanguage.domains.map(domain => domain.id)).toEqual(["commerce"]);
    expect(bootstrap.effectiveLanguage.concepts.map(concept => concept.id)).toEqual(["commerce.order"]);
    expect(bootstrap.effectiveLanguage.aliases).toEqual([
      { term: "old-order", canonicalTerm: "commerce.order", deprecated: true },
      { term: "purchase", canonicalTerm: "commerce.order", deprecated: false },
    ]);
    expect(JSON.stringify(bootstrap)).not.toContain("catalog");
    expect(domainLanguage.validateBootstrap(bootstrap.bootstrapId, principal).bootstrapDigest).toBe(bootstrap.bootstrapDigest);
  });

  test("rejects missing access, invalid anchor, locked override and stale source", async () => {
    const { root, domainLanguage, scopeMap } = await fixture();
    await expect(
      domainLanguage.createBootstrap(
        { anchor: { workspaceId: "test", projectId: "commerce" } },
        { principalId: "denied", access: { workspacePermissions: ["scope.discover", "scope.read_metadata"] } },
      ),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(
      domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "missing" } }, principal),
    ).rejects.toMatchObject({ code: "PROJECT_ANCHOR_NOT_RESOLVED" });

    await writeFile(
      join(root, "project/domain-language/glossary.yaml"),
      "apiVersion: abcm/v1\nkind: DomainLanguageGlossary\nconcepts:\n  - id: commerce.order\n    domainId: commerce\n    term: Purchase\n    definition: Conflicting locked override.\n",
    );
    await scopeMap.scan("test");
    await expect(
      domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, principal),
    ).rejects.toMatchObject({ code: "DOMAIN_LANGUAGE_CONFIGURATION_INVALID" });

    await rm(join(root, "project/domain-language/glossary.yaml"));
    await scopeMap.scan("test");
    const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, principal);
    await writeFile(join(root, "project/domain-language/naming.yaml"), "changed without scan\n");
    expect(() => domainLanguage.validateBootstrap(bootstrap.bootstrapId, principal)).toThrow(
      expect.objectContaining({ code: "DOMAIN_LANGUAGE_BOOTSTRAP_STALE" }),
    );
    expect(() => domainLanguage.validateBootstrap(bootstrap.bootstrapId, { ...principal, principalId: "another" })).toThrow(
      expect.objectContaining({ code: "ACCESS_DENIED" }),
    );
  });

  test("expires bootstraps and invalidates them when the active map revision changes", async () => {
    const { root, registry, scopeMap } = await fixture();
    let now = Date.parse("2026-08-13T10:00:00.000Z");
    const expiring = new DomainLanguageService(registry, scopeMap, {
      bootstrapTtlMs: 1_000,
      now: () => new Date(now),
    });
    const expired = await expiring.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, principal);
    now += 1_001;
    expect(() => expiring.validateBootstrap(expired.bootstrapId, principal)).toThrow(
      expect.objectContaining({ code: "DOMAIN_LANGUAGE_BOOTSTRAP_STALE" }),
    );

    const revisionBound = new DomainLanguageService(registry, scopeMap);
    const bootstrap = await revisionBound.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, principal);
    await writeFile(join(root, "project/README.md"), "changes the pinned map digest\n");
    await scopeMap.scan("test");
    expect(() => revisionBound.validateBootstrap(bootstrap.bootstrapId, principal)).toThrow(
      expect.objectContaining({ code: "DOMAIN_LANGUAGE_BOOTSTRAP_STALE" }),
    );
  });

  test("fails closed when a required convention disappears from the pinned map", async () => {
    const { root, domainLanguage, scopeMap } = await fixture();
    await rm(join(root, "project/domain-language/DomainLanguageConvention.md"));
    await scopeMap.scan("test");

    await expect(
      domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, principal),
    ).rejects.toMatchObject({ code: "DOMAIN_LANGUAGE_CONFIGURATION_INVALID" });
  });

  test("exposes the same bootstrap contract through REST and MCP", async () => {
    const { root } = await fixture();
    const runtime = createAbcmRuntime(
      { id: "test", root },
      { contextPrincipal: principal },
    );
    await runtime.scopeMap.scan("test");
    const request = { anchor: { workspaceId: "test", projectId: "commerce" }, roleId: "executor-agent" };
    const rest = await runtime.restHandler(
      new Request("http://localhost/v1/context/domain-language", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      }),
    );
    expect(rest.status).toBe(200);
    const restBody = await rest.json() as { bootstrapDigest: string; effectiveLanguage: unknown };

    const server = runtime.createMcpServer();
    const client = new Client({ name: "domain-language-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const mcp = await client.callTool({ name: "context.get_domain_language", arguments: request });
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent).toEqual(
        expect.objectContaining({ bootstrapDigest: restBody.bootstrapDigest, effectiveLanguage: restBody.effectiveLanguage }),
      );
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
