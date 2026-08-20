import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbcmRuntime } from "../src/app/create-runtime.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));
const principal: ContextPrincipal = {
  principalId: "agent:cache-owner",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-context-cache-")); roots.push(root);
  await mkdir(join(root, "project/config"), { recursive: true });
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "project/domain-language"), { recursive: true });
  await mkdir(join(root, "project/artifacts"), { recursive: true });
  await mkdir(join(root, "project/agents/skills/cache-skill"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: project\n");
  await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/artifacts/required.md"), "---\nid: required\nkind: guide\ntitle: Required\nrequired: true\n---\nCACHE_BODY_SENTINEL_V1\n");
  await writeFile(join(root, "project/agents/skills/cache-skill/SKILL.md"), "---\nname: cache-skill\ndescription: Cache skill\nmetadata:\n  abcm-skill-strategy: scope\n---\nSKILL_BODY_SENTINEL_V1\n");
  const runtime = createAbcmRuntime({ id: "test", root }, { sqliteDerivedStoreEnabled: true, contextPrincipal: principal });
  await runtime.scopeMap.scan("test");
  return { root, runtime };
}

function buildRequest(bootstrapId: string) {
  return { domainLanguageBootstrapId: bootstrapId, roleId: "agent", taskType: "evaluation", goal: "Проверить версионированный cache", targetHints: ["project"], execution: { planId: "PLAN-0031", runId: "cache-run" } } as const;
}

describe("versioned context cache without centralized feedback", () => {
  test("отличает cold, warm и stale, не смешивая principal, access, MapRevision и policy", async () => {
    const { root, runtime } = await fixture();
    try {
      const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
      const first = await runtime.contextBuilder.build(buildRequest(bootstrap.bootstrapId), principal);
      const second = await runtime.contextBuilder.build(buildRequest(bootstrap.bootstrapId), principal);
      expect(first.cache).toEqual(expect.objectContaining({ state: "miss", policyVersion: "context-build-cache/v1" }));
      expect(second.cache).toEqual(expect.objectContaining({ state: "hit", keyDigest: first.cache.keyDigest }));
      expect(second.bundleDigest).toBe(first.bundleDigest);

      await writeFile(join(root, "project/agents/skills/cache-skill/SKILL.md"), "---\nname: cache-skill\ndescription: Cache skill\nmetadata:\n  abcm-skill-strategy: scope\n---\nSKILL_BODY_SENTINEL_V2\n");
      await runtime.scopeMap.scan("test");
      const nextBootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
      const rebuilt = await runtime.contextBuilder.build(buildRequest(nextBootstrap.bootstrapId), principal);
      expect(rebuilt.cache.state).toBe("stale");
      expect(rebuilt.cache.keyDigest).not.toBe(first.cache.keyDigest);

      const otherPrincipal: ContextPrincipal = { ...principal, principalId: "agent:other" };
      const otherBootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, otherPrincipal);
      const isolated = await runtime.contextBuilder.build(buildRequest(otherBootstrap.bootstrapId), otherPrincipal);
      expect(isolated.cache.state).toBe("miss");

      const database = new Database(join(root, ".abcm/abcm.sqlite"), { readonly: true });
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_build_cache").get()?.count).toBe(3);
      const payloads = database.query<{ entry_json: string }, []>("SELECT entry_json FROM context_build_cache").all();
      expect(JSON.stringify(payloads)).not.toContain("BODY_SENTINEL");
      expect(database.query("SELECT name FROM sqlite_master WHERE name IN ('context_outcomes','context_feedback_proposals','business_evaluation_receipts')").all()).toEqual([]);
      database.close();
    } finally { await runtime.close(); }
  });
});
