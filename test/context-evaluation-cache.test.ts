import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
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
const sha = (value: string) => `sha256:${value.padEnd(64, "0")}` as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-context-cache-")); roots.push(root);
  await mkdir(join(root, "project/config"), { recursive: true });
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "project/domain-language"), { recursive: true });
  await mkdir(join(root, "project/artifacts"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: project\n");
  await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/artifacts/required.md"), "---\nid: required\nkind: guide\ntitle: Required\nrequired: true\n---\nCACHE_BODY_SENTINEL_V1\n");
  const runtime = createAbcmRuntime({ id: "test", root }, { sqliteDerivedStoreEnabled: true, contextPrincipal: principal });
  await runtime.scopeMap.scan("test");
  return { root, runtime };
}

function buildRequest(bootstrapId: string) {
  return {
    domainLanguageBootstrapId: bootstrapId,
    roleId: "agent",
    taskType: "evaluation",
    goal: "Проверить версионированный cache",
    targetHints: ["project"],
    execution: { planId: "PLAN-0031", runId: "cache-run" },
  } as const;
}

describe("versioned context cache and proposal-only feedback", () => {
  test("отличает cold, warm и stale, не смешивая principal, access, MapRevision и policy", async () => {
    const { root, runtime } = await fixture();
    try {
      const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
      const first = await runtime.contextBuilder.build(buildRequest(bootstrap.bootstrapId), principal);
      const second = await runtime.contextBuilder.build(buildRequest(bootstrap.bootstrapId), principal);

      expect(first.cache).toEqual(expect.objectContaining({ state: "miss", policyVersion: "context-build-cache/v1", projectionPolicyVersion: "document-projection/v1" }));
      expect(second.cache).toEqual(expect.objectContaining({ state: "hit", keyDigest: first.cache.keyDigest }));
      expect(second.bundleDigest).toBe(first.bundleDigest);

      await writeFile(join(root, "project/artifacts/required.md"), "---\nid: required\nkind: guide\ntitle: Required\nrequired: true\n---\nCACHE_BODY_SENTINEL_V2\n");
      await runtime.scopeMap.scan("test");
      const nextBootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
      const rebuilt = await runtime.contextBuilder.build(buildRequest(nextBootstrap.bootstrapId), principal);
      expect(rebuilt.cache.state).toBe("stale");
      expect(rebuilt.cache.keyDigest).not.toBe(first.cache.keyDigest);
      expect(rebuilt.bundleDigest).not.toBe(first.bundleDigest);

      const otherPrincipal: ContextPrincipal = { ...principal, principalId: "agent:other" };
      const otherBootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, otherPrincipal);
      const isolated = await runtime.contextBuilder.build(buildRequest(otherBootstrap.bootstrapId), otherPrincipal);
      expect(isolated.cache.state).toBe("miss");
      expect(isolated.cache.keyDigest).not.toBe(rebuilt.cache.keyDigest);

      const database = new Database(join(root, ".abcm/abcm.sqlite"), { readonly: true });
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_build_cache").get()?.count).toBe(3);
      const cachedPayloads = database.query<{ entry_json: string }, []>("SELECT entry_json FROM context_build_cache ORDER BY key_digest").all();
      expect(JSON.stringify(cachedPayloads)).not.toContain("CACHE_BODY_SENTINEL");
      database.close();
    } finally {
      await runtime.close();
    }
  });

  test("feedback создаёт body-free proposal для выбранного документа и не меняет active ranking", async () => {
    const { root, runtime } = await fixture();
    try {
      const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
      const bundle = await runtime.contextBuilder.build(buildRequest(bootstrap.bootstrapId), principal);
      const fingerprintId = bundle.contextFingerprintLocation.split("/").at(-1)!;
      const base = {
        workspaceId: "test",
        fingerprintId,
        feedbackId: "feedback-1",
        documentId: "required",
        classification: "useful" as const,
        target: "ranking-policy" as const,
        rationaleDigest: sha("a"),
      };
      const proposal = runtime.contextFeedback!.propose(base);
      expect(proposal).toEqual(expect.objectContaining({
        schemaVersion: "abcm.eval.context-feedback-proposal/v1",
        status: "proposed",
        basePolicyVersion: "context-selection/v3",
        mapRevision: bundle.mapRevision,
      }));
      expect(runtime.contextFeedback!.propose(base)).toEqual(proposal);
      expect(runtime.contextFeedback!.list("test", fingerprintId)).toEqual([proposal]);
      expect(() => runtime.contextFeedback!.propose({ ...base, classification: "noise" })).toThrow(expect.objectContaining({ code: "CONTEXT_FEEDBACK_CONFLICT" }));
      expect(() => runtime.contextFeedback!.propose({ ...base, feedbackId: "feedback-hidden", documentId: "hidden" })).toThrow(expect.objectContaining({ code: "CONTEXT_DOCUMENT_NOT_FOUND" }));

      const rest = await runtime.restHandler(new Request("http://localhost/v1/context/feedback", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, feedbackId: "feedback-2", target: "dataset", classification: "required", rationaleDigest: sha("b") }),
      }));
      expect(rest.status).toBe(201);

      const server = runtime.createMcpServer();
      const client = new Client({ name: "context-feedback-test", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      try {
        const proposed = await client.callTool({ name: "context.propose_feedback", arguments: { ...base, feedbackId: "feedback-3", rationaleDigest: sha("c") } });
        expect(proposed.isError).not.toBe(true);
        const listed = await client.callTool({ name: "context.list_feedback", arguments: { workspaceId: "test", fingerprintId } });
        expect((listed.structuredContent as { proposals: unknown[] }).proposals).toHaveLength(3);
        expect(JSON.stringify(listed.structuredContent)).not.toContain("CACHE_BODY_SENTINEL");
      } finally {
        await client.close(); await server.close();
      }

      const database = new Database(join(root, ".abcm/abcm.sqlite"), { readonly: true });
      const payloads = database.query<{ proposal_json: string }, []>("SELECT proposal_json FROM context_feedback_proposals ORDER BY proposal_id").all();
      expect(JSON.stringify(payloads)).not.toContain("CACHE_BODY_SENTINEL");
      database.close();
    } finally {
      await runtime.close();
    }
  });
});
