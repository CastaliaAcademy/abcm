import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DomainLanguageService } from "../src/domain-language/domain-language-service.js";
import { ScopePathResolver } from "../src/domain-language/scope-path-resolver.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function scope(root: string, path: string, kind: string, id: string, mode = "extend") {
  const directory = join(root, path);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  if (kind === "project") {
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  }
  await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), `---\napiVersion: abcm/v1\nkind: DomainLanguageConvention\nmode: ${mode}\n---\n`);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-path-resolver-"));
  roots.push(root);
  await scope(root, "", "workflow", "workflow");
  await scope(root, "project", "project", "commerce");
  await scope(root, "project/catalog", "service", "catalog");
  await scope(root, "project/catalog/search", "feature", "search", "inherit-only");
  await scope(root, "project/billing", "service", "billing", "inherit-only");
  await writeFile(join(root, "domain-language/domains.yaml"), "apiVersion: abcm/v1\nkind: DomainLanguageDomains\ndomains:\n  - id: commerce\n    locked: true\n");
  await writeFile(join(root, "project/catalog/domain-language/glossary.yaml"), "apiVersion: abcm/v1\nkind: DomainLanguageGlossary\nconcepts:\n  - id: catalog.search\n    domainId: commerce\n    scopeId: search\n    term: Search\n");
  await writeFile(join(root, "project/catalog/domain-language/aliases.yaml"), "apiVersion: abcm/v1\nkind: DomainLanguageAliases\naliases:\n  - term: find\n    canonicalTerm: catalog.search\n  - term: old-find\n    canonicalTerm: catalog.search\n    deprecated: true\n");
  await mkdir(join(root, "project/catalog/artifacts/adr"), { recursive: true });
  await writeFile(join(root, "project/catalog/artifacts/adr/ADR-SEARCH.md"), "---\nid: ADR-SEARCH\nkind: adr\ntitle: Search decision\n---\nbody not exposed\n");
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const scopeMap = new ScopeMapService(registry);
  await scopeMap.scan("test");
  const domainLanguage = new DomainLanguageService(registry, scopeMap);
  return { root, scopeMap, domainLanguage, resolver: new ScopePathResolver(domainLanguage, scopeMap) };
}

const principal: ContextPrincipal = {
  principalId: "agent:resolver",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build"] },
};

async function bootstrap(domainLanguage: DomainLanguageService) {
  return domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, principal);
}

describe("ScopePathResolver", () => {
  test("scores exact links, artifact ownership and repository prefixes in deterministic tiers", async () => {
    const { domainLanguage, resolver } = await fixture();
    const base = await bootstrap(domainLanguage);

    const exact = await resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "change invoices", explicitLinks: ["abcm://scope/billing"] }, principal);
    expect(exact.primaryTargetScopeId).toBe("billing");
    expect(exact.resolverTrace.passes[0]?.evidence[0]?.tier).toBe("exact");

    const artifact = await resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "apply decision", artifacts: ["abcm://artifact/ADR-SEARCH"] }, principal);
    expect(artifact.primaryTargetScopeId).toBe("catalog");
    expect(artifact.resolverTrace.passes[0]?.evidence[0]?.tier).toBe("artifact");

    const repository = await resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "edit code", repositoryPaths: ["project/catalog/search/src/index.ts"] }, principal);
    expect(repository.primaryTargetScopeId).toBe("search");
    expect(repository.scopeIds).toEqual(["workflow", "commerce", "catalog", "search"]);
  });

  test("normalizes aliases after the first target and performs one bounded re-resolution", async () => {
    const { domainLanguage, resolver } = await fixture();
    const base = await bootstrap(domainLanguage);

    const result = await resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "catalog find" }, principal);

    expect(result.primaryTargetScopeId).toBe("search");
    expect(result.normalizedIntent.canonicalTerms).toEqual(["catalog.search"]);
    expect(result.resolverTrace.passes.map(pass => [pass.pass, pass.targetScopeId])).toEqual([[1, "catalog"], [2, "search"]]);
    expect(result.domainLanguageSources.map(source => source.scopeId)).toContain("search");

    const deprecated = await resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "catalog old-find" }, principal);
    expect(deprecated.normalizedIntent.canonicalTerms).toEqual(["catalog.search"]);
    expect(deprecated.warnings).toEqual([{
      code: "DOMAIN_ALIAS_DEPRECATED",
      term: "old-find",
      canonicalTerm: "catalog.search",
    }]);
  });

  test("accepts a declared primary concept term and canonicalizes it to the concept id", async () => {
    const { root, scopeMap, domainLanguage, resolver } = await fixture();
    await writeFile(join(root, "project/domain-language/glossary.yaml"), "apiVersion: abcm/v1\nkind: DomainLanguageGlossary\nconcepts:\n  - id: abcm.scope-map\n    domainId: commerce\n    scopeId: catalog\n    term: ScopeMap\n");
    await scopeMap.scan("test");
    const base = await bootstrap(domainLanguage);

    expect(base.effectiveLanguage.concepts).toContainEqual(expect.objectContaining({
      id: "abcm.scope-map",
      term: "ScopeMap",
    }));

    const result = await resolver.resolve({
      domainLanguageBootstrapId: base.bootstrapId,
      goal: "catalog",
      canonicalTerms: ["ScopeMap"],
    }, principal);

    expect(result.primaryTargetScopeId).toBe("catalog");
    expect(result.normalizedIntent.canonicalTerms).toEqual(["abcm.scope-map"]);
  });

  test("fails closed for unknown language, ambiguous targets and inaccessible candidates", async () => {
    const { root, scopeMap, domainLanguage, resolver } = await fixture();
    const base = await bootstrap(domainLanguage);
    await expect(resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "x", canonicalDomains: ["unknown"] }, principal)).rejects.toMatchObject({ code: "UNKNOWN_DOMAIN" });
    await expect(resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "x", canonicalTerms: ["unknown.term"] }, principal)).rejects.toMatchObject({ code: "UNKNOWN_DOMAIN_TERM" });
    await expect(resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "catalog billing" }, principal)).rejects.toMatchObject({ code: "TARGET_SCOPE_AMBIGUOUS" });

    const localPrincipal: ContextPrincipal = {
      principalId: "agent:local",
      access: { workspacePermissions: [], scopeGrants: {
        workflow: ["scope.discover", "scope.read_metadata", "context.build"],
        commerce: ["scope.discover", "scope.read_metadata", "context.build"],
        catalog: ["scope.discover", "scope.read_metadata", "context.build"],
      } },
    };
    const localBootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, localPrincipal);
    await expect(resolver.resolve({ domainLanguageBootstrapId: localBootstrap.bootstrapId, goal: "billing" }, localPrincipal)).rejects.toMatchObject({ code: "TARGET_SCOPE_INVALID" });

    await writeFile(join(root, "project/domain-language/glossary.yaml"), "apiVersion: abcm/v1\nkind: DomainLanguageGlossary\nconcepts:\n  - id: commerce.order\n    domainId: commerce\n    term: Order\n  - id: commerce.sequence\n    domainId: commerce\n    term: Sequence\n");
    await writeFile(join(root, "project/domain-language/aliases.yaml"), "apiVersion: abcm/v1\nkind: DomainLanguageAliases\nhomonyms:\n  - term: order\n    canonicalTerms: [commerce.order, commerce.sequence]\n");
    await scopeMap.scan("test");
    const ambiguousLanguage = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, principal);
    await expect(resolver.resolve({ domainLanguageBootstrapId: ambiguousLanguage.bootstrapId, goal: "x", canonicalTerms: ["order"] }, principal)).rejects.toMatchObject({ code: "AMBIGUOUS_DOMAIN_TERM" });
  });

  test("rejects a third meaning after the bounded second pass", async () => {
    const { root, scopeMap, domainLanguage, resolver } = await fixture();
    await writeFile(join(root, "project/catalog/search/domain-language/DomainLanguageConvention.md"), "---\napiVersion: abcm/v1\nkind: DomainLanguageConvention\nmode: extend\n---\n");
    await writeFile(join(root, "project/catalog/search/domain-language/glossary.yaml"), "apiVersion: abcm/v1\nkind: DomainLanguageGlossary\nconcepts:\n  - id: billing.route\n    domainId: commerce\n    scopeId: billing\n    term: Billing route\n");
    await writeFile(join(root, "project/catalog/search/domain-language/aliases.yaml"), "apiVersion: abcm/v1\nkind: DomainLanguageAliases\naliases:\n  - term: catalog\n    canonicalTerm: billing.route\n");
    await scopeMap.scan("test");
    const base = await bootstrap(domainLanguage);

    await expect(resolver.resolve({ domainLanguageBootstrapId: base.bootstrapId, goal: "catalog find" }, principal)).rejects.toMatchObject({ code: "PATH_RESOLUTION_NOT_CONVERGED" });
  });
});
