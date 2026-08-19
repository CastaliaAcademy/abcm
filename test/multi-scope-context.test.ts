import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextBuilder } from "../src/context/context-builder.js";
import { DirectoryContextFingerprintStore } from "../src/context/directory-context-fingerprint-store.js";
import { buildTaskContextSchema, normalizeBuildTaskContextInput } from "../src/context/schema.js";
import { DomainLanguageService } from "../src/domain-language/domain-language-service.js";
import { ScopePathResolver } from "../src/domain-language/scope-path-resolver.js";
import type { ContextPrincipal, ResolveTaskPathRequest } from "../src/domain-language/types.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { SkillConnectionResolver } from "../src/skills/skill-connection-resolver.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function addScope(root: string, path: string, kind: "workflow" | "project" | "service" | "feature", id: string): Promise<void> {
  const directory = join(root, path);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  if (kind === "project") {
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  }
  await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), "---\napiVersion: abcm/v1\nkind: DomainLanguageConvention\nmode: inherit-only\n---\n");
}

async function addRelations(root: string, path: string, relations: readonly { id: string; target: string; type: string }[]): Promise<void> {
  const directory = join(root, path, "config");
  await mkdir(directory, { recursive: true });
  const body = relations.map(relation => `  - id: ${relation.id}\n    target: abcm://scope/${relation.target}\n    type: ${relation.type}\n`).join("");
  await writeFile(join(directory, "relations.yaml"), `apiVersion: abcm/v1\nkind: ScopeRelations\nrelations:\n${body}`);
}

async function addDocument(root: string, scopePath: string, id: string, body: string, required = false): Promise<string> {
  const directory = join(root, scopePath, "artifacts");
  await mkdir(directory, { recursive: true });
  const content = `---\nid: ${id}\nkind: guide\ntitle: ${id}\n${required ? "required: true\n" : ""}---\n\n${body}\n`;
  await writeFile(join(directory, `${id}.md`), content);
  return content;
}

async function addScopeSkill(root: string, scopePath: string, id: string): Promise<string> {
  const directory = join(root, scopePath, "agents/skills", id);
  await mkdir(directory, { recursive: true });
  const content = `---\nname: ${id}\ndescription: ${id}\ncompatibility: ABCM MVP\nmetadata:\n  abcm-skill-strategy: scope\n  abcm-roles: executor-agent\n---\n\n# ${id}\n\nBODY-${id}\n`;
  await writeFile(join(directory, "SKILL.md"), content);
  return content;
}

function tokenEstimate(content: string): number {
  return Math.ceil(new TextEncoder().encode(content).byteLength / 4);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-multi-scope-"));
  roots.push(root);
  await addScope(root, "", "workflow", "workflow");
  await addScope(root, "commerce", "project", "commerce");
  await addScope(root, "commerce/catalog", "service", "catalog");
  await addScope(root, "commerce/billing", "service", "billing");
  await addScope(root, "finance", "project", "finance");
  await addScope(root, "finance/ledger", "service", "ledger");
  await addScope(root, "finance/secret", "service", "secret");
  await addRelations(root, "commerce/catalog", [{ id: "catalog-billing", target: "billing", type: "depends-on" }]);
  await addRelations(root, "commerce/billing", [
    { id: "billing-ledger", target: "ledger", type: "affects" },
    { id: "billing-secret", target: "secret", type: "affects" },
  ]);
  await addRelations(root, "finance/ledger", [{ id: "ledger-catalog", target: "catalog", type: "depends-on" }]);
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const scopeMap = new ScopeMapService(registry);
  await scopeMap.scan("test");
  const domainLanguage = new DomainLanguageService(registry, scopeMap);
  return { root, registry, scopeMap, domainLanguage, resolver: new ScopePathResolver(domainLanguage, scopeMap) };
}

const fullPrincipal: ContextPrincipal = {
  principalId: "agent:multi-scope",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build"] },
};

function exactRequest(bootstrapId: string, exactScopeIds: readonly string[]): ResolveTaskPathRequest {
  return {
    domainLanguageBootstrapId: bootstrapId,
    goal: "migration with no fuzzy component match",
    exactScopeIds,
  } as ResolveTaskPathRequest;
}

describe("multi-scope context contract", () => {
  test("keeps ordered exact scope ids separate from fuzzy component hints", () => {
    const parsed = buildTaskContextSchema.parse({
      domainLanguageBootstrapId: "bootstrap-1",
      roleId: "executor-agent",
      taskType: "migration",
      goal: "move contract",
      targetHints: {
        scopeIds: ["catalog", "abcm://scope/ledger"],
        componentNames: ["orders"],
        repositoryPaths: ["commerce/catalog/src/index.ts"],
      },
    });
    const normalized = normalizeBuildTaskContextInput(parsed) as ReturnType<typeof normalizeBuildTaskContextInput> & { exactScopeIds?: readonly string[] };

    expect(normalized.exactScopeIds).toEqual(["catalog", "ledger"]);
    expect(normalized.targetHints).toEqual(["orders"]);
    expect(normalized.repositoryPaths).toEqual(["commerce/catalog/src/index.ts"]);
  });

  test("rejects duplicate canonical exact scopes and more than eight explicit scopes", () => {
    const base = {
      domainLanguageBootstrapId: "bootstrap-1",
      roleId: "executor-agent",
      taskType: "migration",
      goal: "move contract",
    };
    expect(buildTaskContextSchema.safeParse({ ...base, targetHints: { scopeIds: ["catalog", "abcm://scope/catalog"] } }).success).toBe(false);
    expect(buildTaskContextSchema.safeParse({ ...base, targetHints: { scopeIds: Array.from({ length: 9 }, (_, index) => `scope-${index}`) } }).success).toBe(false);
    expect(buildTaskContextSchema.safeParse({ ...base, targetHints: ["catalog", "billing"] }).success).toBe(true);
  });

  test("uses the first exact scope as primary and resolves bounded outgoing closure across projects", async () => {
    const { domainLanguage, resolver } = await fixture();
    const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, fullPrincipal);

    const first = await resolver.resolve(exactRequest(bootstrap.bootstrapId, ["catalog", "ledger"]), fullPrincipal);
    const second = await resolver.resolve(exactRequest(bootstrap.bootstrapId, ["catalog", "ledger"]), fullPrincipal);
    const record = first as typeof first & {
      multiScopePolicyDigest?: string;
      affectedScopeDetails?: readonly { scopeId: string; origin: string; depth: number; viaScopeId?: string; relationType?: string }[];
    };

    expect(first.primaryTargetScopeId).toBe("catalog");
    expect(first.affectedScopeIds).toEqual(["catalog", "ledger", "billing", "secret"]);
    expect(record.affectedScopeDetails).toEqual([
      { scopeId: "catalog", origin: "primary", depth: 0 },
      { scopeId: "ledger", origin: "explicit", depth: 0 },
      { scopeId: "billing", origin: "relation", depth: 1, viaScopeId: "catalog", relationType: "depends-on" },
      { scopeId: "secret", origin: "relation", depth: 2, viaScopeId: "billing", relationType: "affects" },
    ]);
    expect(record.multiScopePolicyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.affectedScopeIds).toEqual(first.affectedScopeIds);
    expect((second as typeof record).affectedScopeDetails).toEqual(record.affectedScopeDetails);
    expect((second as typeof record).multiScopePolicyDigest).toBe(record.multiScopePolicyDigest);
  });

  test("does not disclose inaccessible explicit or relation-derived scopes", async () => {
    const { domainLanguage, resolver } = await fixture();
    const grants = ["scope.discover", "scope.read_metadata", "context.build"] as const;
    const restricted: ContextPrincipal = {
      principalId: "agent:restricted-multi-scope",
      access: { workspacePermissions: [], scopeGrants: {
        workflow: grants,
        commerce: grants,
        catalog: grants,
        billing: grants,
        finance: grants,
        ledger: grants,
      } },
    };
    const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, restricted);
    const resolved = await resolver.resolve(exactRequest(bootstrap.bootstrapId, ["catalog", "ledger"]), restricted);

    expect(resolved.affectedScopeIds).toEqual(["catalog", "ledger", "billing"]);
    expect(JSON.stringify(resolved)).not.toContain("secret");

    let failure: unknown;
    try {
      await resolver.resolve(exactRequest(bootstrap.bootstrapId, ["catalog", "secret"]), restricted);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "TARGET_SCOPE_INVALID", details: undefined });
    expect(String(failure)).not.toContain("secret");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  test("rejects an exact primary outside the bootstrap anchor project", async () => {
    const { domainLanguage, resolver } = await fixture();
    const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, fullPrincipal);

    await expect(resolver.resolve(exactRequest(bootstrap.bootstrapId, ["ledger", "catalog"]), fullPrincipal)).rejects.toMatchObject({
      code: "TARGET_SCOPE_INVALID",
      details: undefined,
    });
  });

  test("applies configured closure bounds and includes the policy in deterministic identity", async () => {
    const { domainLanguage, scopeMap, resolver } = await fixture();
    const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, fullPrincipal);
    const defaultResult = await resolver.resolve(exactRequest(bootstrap.bootstrapId, ["catalog", "ledger"]), fullPrincipal);
    const bounded = new ScopePathResolver(domainLanguage, scopeMap, undefined, { multiScopePolicy: {
      version: "multi-scope-test-bounded-v1",
      maxExplicitScopes: 2,
      maxAffectedScopes: 3,
      maxRelationDepth: 1,
      relationDirection: "outgoing",
      allowedRelationTypes: ["depends-on"],
      optionalBudgetAllocation: "deterministic-round-robin",
    } });
    const first = await bounded.resolve(exactRequest(bootstrap.bootstrapId, ["catalog", "ledger"]), fullPrincipal);
    const second = await bounded.resolve(exactRequest(bootstrap.bootstrapId, ["catalog", "ledger"]), fullPrincipal);

    expect(first.affectedScopeIds).toEqual(["catalog", "ledger", "billing"]);
    expect(first.affectedScopeDetails.at(-1)).toEqual({
      scopeId: "billing", origin: "relation", depth: 1, viaScopeId: "catalog", relationType: "depends-on",
    });
    expect(first.multiScopePolicyDigest).toBe(second.multiScopePolicyDigest);
    expect(first.multiScopePolicyDigest).not.toBe(defaultResult.multiScopePolicyDigest);
  });

  test("connects context from both projects and allocates optional budget round-robin reproducibly", async () => {
    const { root, registry, scopeMap, domainLanguage } = await fixture();
    const catalogA = await addDocument(root, "commerce/catalog", "catalog-a", "A".repeat(160));
    const catalogB = await addDocument(root, "commerce/catalog", "catalog-b", "B".repeat(160));
    const ledgerA = await addDocument(root, "finance/ledger", "ledger-a", "C".repeat(160));
    const ledgerB = await addDocument(root, "finance/ledger", "ledger-b", "D".repeat(160));
    const catalogSkill = await addScopeSkill(root, "commerce/catalog", "catalog-skill");
    const ledgerSkill = await addScopeSkill(root, "finance/ledger", "ledger-skill");
    await scopeMap.scan("test");
    const principal: ContextPrincipal = {
      principalId: "agent:multi-scope-builder",
      access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
    };
    const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" }, roleId: "executor-agent" }, principal);
    const selectedBudget = tokenEstimate(catalogSkill) + tokenEstimate(ledgerSkill) + tokenEstimate(catalogA) + tokenEstimate(ledgerA) + tokenEstimate(catalogB);
    const builder = new ContextBuilder({
      files: new WorkspaceFileService(registry),
      scopeMap,
      domainLanguage,
      scopePathResolver: new ScopePathResolver(domainLanguage, scopeMap),
      skillConnectionResolver: new SkillConnectionResolver(registry, scopeMap),
      fingerprintStore: new DirectoryContextFingerprintStore(registry),
      options: { budgetProfiles: { fair: { softLimitTokens: selectedBudget, hardLimitTokens: selectedBudget + tokenEstimate(ledgerB) + 100 } } },
    });
    const request = {
      domainLanguageBootstrapId: bootstrap.bootstrapId,
      roleId: "executor-agent",
      taskType: "migration",
      goal: "Move a contract across projects",
      exactScopeIds: ["catalog", "ledger"],
      budgetProfile: "fair",
      execution: { planId: "PLAN-0030", runId: "round-robin" },
    } as const;
    const first = await builder.build(request, principal);
    const second = await builder.build(request, principal);

    expect(first.connectedSkills.map(skill => skill.skillId)).toEqual(["catalog-skill", "ledger-skill"]);
    expect(first.selectedDocuments.map(document => document.documentId)).toEqual(["catalog-a", "ledger-a", "catalog-b"]);
    expect(first.omissions).toContainEqual(expect.objectContaining({ documentId: "ledger-b", reason: "budget_exceeded" }));
    expect(first.budgetAllocation).toEqual(expect.arrayContaining([
      {
        bucketId: "catalog",
        requestedTokens: tokenEstimate(catalogA) + tokenEstimate(catalogB),
        reservedTokens: 0,
        consumedTokens: tokenEstimate(catalogA) + tokenEstimate(catalogB),
        selectedTokens: tokenEstimate(catalogA) + tokenEstimate(catalogB),
        omittedTokens: 0,
      },
      {
        bucketId: "ledger",
        requestedTokens: tokenEstimate(ledgerA) + tokenEstimate(ledgerB),
        reservedTokens: 0,
        consumedTokens: tokenEstimate(ledgerA),
        selectedTokens: tokenEstimate(ledgerA),
        omittedTokens: tokenEstimate(ledgerB),
      },
    ]));
    expect(second.bundleDigest).toBe(first.bundleDigest);
    expect(second.budgetAllocation).toEqual(first.budgetAllocation);

    const fingerprint = JSON.parse(await readFile(join(root, first.contextFingerprintLocation, "fingerprint.json"), "utf8")) as Record<string, unknown>;
    expect(fingerprint).toEqual(expect.objectContaining({
      affectedScopes: first.affectedScopes,
      affectedScopeDetails: first.affectedScopeDetails,
      multiScopePolicyDigest: first.multiScopePolicyDigest,
      budgetAllocation: first.budgetAllocation,
    }));
    expect(JSON.stringify(fingerprint)).not.toContain("BODY-catalog-skill");
    expect(JSON.stringify(fingerprint)).not.toContain("A".repeat(80));
  });

  test("excludes a hidden relation scope before document omissions and allocation", async () => {
    const { root, registry, scopeMap, domainLanguage } = await fixture();
    await addDocument(root, "finance/secret", "secret-required", "HIDDEN-SCOPE-DOCUMENT", true);
    await addDocument(root, "finance", "hidden-ancestor-required", "HIDDEN-ANCESTOR-DOCUMENT", true);
    await scopeMap.scan("test");
    const grants = ["scope.discover", "scope.read_metadata", "context.build", "document.read"] as const;
    const principal: ContextPrincipal = {
      principalId: "agent:hidden-document",
      access: { workspacePermissions: [], scopeGrants: {
        workflow: grants,
        commerce: grants,
        catalog: grants,
        billing: grants,
        ledger: grants,
      } },
    };
    const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" }, roleId: "executor-agent" }, principal);
    const builder = new ContextBuilder({
      files: new WorkspaceFileService(registry), scopeMap, domainLanguage,
      scopePathResolver: new ScopePathResolver(domainLanguage, scopeMap),
      skillConnectionResolver: new SkillConnectionResolver(registry, scopeMap),
      fingerprintStore: new DirectoryContextFingerprintStore(registry),
    });
    const result = await builder.build({
      domainLanguageBootstrapId: bootstrap.bootstrapId,
      roleId: "executor-agent",
      taskType: "migration",
      goal: "Move a contract",
      exactScopeIds: ["catalog", "ledger"],
    }, principal);

    expect(result.affectedScopes).toEqual(["catalog", "ledger", "billing"]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("hidden-ancestor");
    expect(result.omissions).not.toContainEqual(expect.objectContaining({ documentId: "secret-required" }));
    expect(result.omissions).not.toContainEqual(expect.objectContaining({ documentId: "hidden-ancestor-required" }));
    expect(result.budgetAllocation.map(record => record.bucketId)).not.toContain("secret");
  });
});
