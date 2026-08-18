import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTaskContextSchema, normalizeBuildTaskContextInput } from "../src/context/schema.js";
import { DomainLanguageService } from "../src/domain-language/domain-language-service.js";
import { ScopePathResolver } from "../src/domain-language/scope-path-resolver.js";
import type { ContextPrincipal, ResolveTaskPathRequest } from "../src/domain-language/types.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
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
  return { root, scopeMap, domainLanguage, resolver: new ScopePathResolver(domainLanguage, scopeMap) };
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
});
