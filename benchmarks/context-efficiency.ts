import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { parseSafeYaml } from "../src/core/safe-yaml.js";
import { contextEfficiencyManifestSchema, retrievalRunReceiptSchema } from "../src/evaluation/context-efficiency-contracts.js";
import { evaluateContextEfficiency } from "../src/evaluation/context-efficiency-evaluator.js";
import { runDirectSearchBaseline } from "../src/evaluation/direct-search-baseline.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

interface BenchmarkManifest {
  schemaVersion: "abcm.benchmark.context-efficiency/v1";
  workspaceId: string;
  projectId: string;
  scopeId: string;
  roleId: string;
  taskType: string;
  goal: string;
  queryTerms: string[];
  allowedPathPrefixes: string[];
  goldDocumentIds: string[];
  mandatoryDocumentIds: string[];
  claims: Array<{ id: string; allTerms: string[] }>;
  forbiddenMarkers: string[];
  repetitions: number;
}

const fixtureRoot = resolve("benchmarks/fixtures/context-efficiency-v1/workspace");
const fixtureManifest = parseSafeYaml(await Bun.file("benchmarks/fixtures/context-efficiency-v1/benchmark-manifest.yaml").text()) as BenchmarkManifest;
const baseUrl = process.env.ABCM_BENCH_BASE_URL ?? "http://127.0.0.1:8791";
const token = process.env.ABCM_BENCH_TOKEN ?? "benchmark-token-123456789";
const sha = (value: unknown) => `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`;
const percentile = (values: readonly number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)]!;
const elapsed = (started: number) => Number((performance.now() - started).toFixed(3));

const registry = new WorkspaceRegistry([{ id: fixtureManifest.workspaceId, root: fixtureRoot }]);
const directStarted = performance.now();
const direct = await runDirectSearchBaseline(new WorkspaceFileService(registry), {
  workspaceId: fixtureManifest.workspaceId,
  queryTerms: fixtureManifest.queryTerms,
  allowedPathPrefixes: fixtureManifest.allowedPathPrefixes,
  claimChecks: fixtureManifest.claims,
});
const directMs = elapsed(directStarted);
const inputIdentity = {
  workspaceSnapshotDigest: sha(direct.trace.reads.map(read => ({ path: read.path, checksum: read.checksum }))),
  principalAccessDigest: sha({ workspaceId: fixtureManifest.workspaceId, prefixes: fixtureManifest.allowedPathPrefixes }),
  requestDigest: sha({ goal: fixtureManifest.goal, taskType: fixtureManifest.taskType, queryTerms: fixtureManifest.queryTerms }),
  policyDigest: sha({ priorityOrder: ["task_relevance", "fallback_flexibility", "determinism", "workspace_isolation", "context_efficiency"] }),
};
const directReceipt = retrievalRunReceiptSchema.parse({
  schemaVersion: "abcm.eval.retrieval-run/v1",
  scenarioId: "docker-known-data",
  variant: "direct",
  runId: "direct-1",
  inputIdentity,
  cache: { state: "bypass", policyVersion: "direct-search-no-cache/v1" },
  selectedDocuments: direct.selectedDocuments.map(document => ({ documentId: document.documentId, tokenEstimate: document.tokenEstimate })),
  retrievedClaimIds: direct.retrievedClaimIds,
  totalInputTokens: direct.totalInputTokens,
  taskSucceeded: fixtureManifest.mandatoryDocumentIds.every(id => direct.selectedDocuments.some(document => document.documentId === id)),
  totalCost: direct.totalInputTokens / 1_000_000,
  repeatedResultDigests: Array.from({ length: fixtureManifest.repetitions }, () => direct.resultDigest),
  unauthorizedDisclosureCount: 0,
  fallback: { availableModes: ["direct-search", "explicit-documents", "bounded-resource-read"] },
});

const client = new Client({ name: "context-efficiency-docker-benchmark", version: "0.1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", baseUrl), { authProvider: { token: async () => token } }));
try {
  const scan = await client.callTool({ name: "scope_map.scan", arguments: { workspaceId: fixtureManifest.workspaceId } });
  if (scan.isError) throw new Error(`ScopeMap scan failed: ${JSON.stringify(scan.content)}`);
  const bootstrapStarted = performance.now();
  const bootstrap = await client.callTool({ name: "context.get_domain_language", arguments: {
    anchor: { workspaceId: fixtureManifest.workspaceId, projectId: fixtureManifest.projectId },
    roleId: fixtureManifest.roleId,
  } });
  const bootstrapMs = elapsed(bootstrapStarted);
  if (bootstrap.isError) throw new Error(`Bootstrap failed: ${JSON.stringify(bootstrap.content)}`);
  const bootstrapId = (bootstrap.structuredContent as { bootstrapId: string }).bootstrapId;
  const buildTimes: number[] = [];
  const bundles: Array<{
    bundleDigest: string;
    tokenEstimate: number;
    selectedDocuments: Array<{ documentId: string; tokenEstimate: number; projection: { content?: string } }>;
    omissions: unknown[];
    cache: { state: "hit" | "miss" | "stale"; policyVersion: string; projectionPolicyVersion: string; keyDigest: string };
  }> = [];
  for (let index = 0; index < fixtureManifest.repetitions; index++) {
    const started = performance.now();
    const bundle = await client.callTool({ name: "context.build_task_context", arguments: {
      domainLanguageBootstrapId: bootstrapId,
      roleId: fixtureManifest.roleId,
      taskType: fixtureManifest.taskType,
      goal: fixtureManifest.goal,
      targetHints: {
        scopeIds: [fixtureManifest.scopeId],
        componentNames: fixtureManifest.queryTerms,
        repositoryPaths: fixtureManifest.allowedPathPrefixes,
      },
      budgetProfile: "expanded",
      execution: { planId: "PLAN-0031", runId: "docker-eval" },
    } });
    buildTimes.push(elapsed(started));
    if (bundle.isError) throw new Error(`Context build failed: ${JSON.stringify(bundle.content)}`);
    bundles.push(bundle.structuredContent as typeof bundles[number]);
  }
  const first = bundles[0]!;
  const cacheStates = bundles.map(bundle => bundle.cache.state);
  const serialized = JSON.stringify(bundles);
  const traversal = await client.callTool({ name: "workspace.read_file", arguments: { workspaceId: fixtureManifest.workspaceId, path: "../foreign/secret.md" } });
  const traversalSerialized = JSON.stringify(traversal);
  const unauthorizedDisclosureCount = fixtureManifest.forbiddenMarkers.some(marker => serialized.includes(marker) || traversalSerialized.includes(marker)) ? 1 : 0;
  if (!traversal.isError) throw new Error("Workspace traversal unexpectedly succeeded.");
  const selectedIds = first.selectedDocuments.map(document => document.documentId);
  const projectedCorpus = first.selectedDocuments.map(document => document.projection.content ?? "").join("\n").toLocaleLowerCase("ru-RU");
  const retrievedClaimIds = fixtureManifest.claims.filter(claim => claim.allTerms.every(term => projectedCorpus.includes(term.toLocaleLowerCase("ru-RU")))).map(claim => claim.id);
  const abcmReceipt = retrievalRunReceiptSchema.parse({
    schemaVersion: "abcm.eval.retrieval-run/v1",
    scenarioId: "docker-known-data",
    variant: "abcmAutomatic",
    runId: "abcm-docker-1",
    inputIdentity,
    cache: first.cache,
    selectedDocuments: first.selectedDocuments.map(document => ({ documentId: document.documentId, tokenEstimate: document.tokenEstimate })),
    retrievedClaimIds,
    totalInputTokens: first.tokenEstimate,
    taskSucceeded: fixtureManifest.mandatoryDocumentIds.every(id => selectedIds.includes(id)),
    totalCost: first.tokenEstimate / 1_000_000,
    repeatedResultDigests: bundles.map(bundle => bundle.bundleDigest),
    unauthorizedDisclosureCount,
    fallback: { availableModes: ["direct-search", "explicit-documents", "bounded-resource-read"] },
  });
  const evaluationManifest = contextEfficiencyManifestSchema.parse({
    schemaVersion: "abcm.eval.context-efficiency/v1",
    id: "docker-known-data",
    language: "ru",
    priorityOrder: ["task_relevance", "fallback_flexibility", "determinism", "workspace_isolation", "context_efficiency"],
    variants: { direct: { mode: "direct-search" }, abcmAutomatic: { mode: "context-bundle" } },
    gates: {
      taskRelevance: { mandatoryRecallVsDirect: "gte", precisionVsDirect: "gte", taskSuccessRateMaxDegradation: 0.02 },
      fallbackFlexibility: { requiredModes: ["direct-search", "explicit-documents", "bounded-resource-read"], preservePrimaryFailure: true },
      determinism: { identicalResultRate: 1 },
      workspaceIsolation: { unauthorizedDisclosureMax: 0 },
      contextEfficiency: { medianTokenReductionMin: 0.25, costPerSuccessfulTaskReductionMin: 0.20, evaluateOnlySuccessfulTasks: true },
    },
    scenarios: [{
      id: "docker-known-data",
      goldDocumentIds: fixtureManifest.goldDocumentIds,
      mandatoryDocumentIds: fixtureManifest.mandatoryDocumentIds,
      goldClaimIds: fixtureManifest.claims.map(claim => claim.id),
      hiddenDocumentIds: ["foreign-secret"],
    }],
  });
  const report = evaluateContextEfficiency(evaluationManifest, [directReceipt, abcmReceipt]);
  const output = {
    benchmark: "context-efficiency-docker-v1",
    fixture: { workspaceId: fixtureManifest.workspaceId, goldDocumentIds: fixtureManifest.goldDocumentIds, repetitions: fixtureManifest.repetitions },
    direct: { durationMs: directMs, candidateReads: direct.trace.reads.length, selectedDocumentIds: direct.selectedDocuments.map(document => document.documentId), inputTokens: direct.totalInputTokens, digest: direct.resultDigest },
    abcm: { bootstrapMs, coldBuildMs: buildTimes[0], warmBuildP50Ms: percentile(buildTimes.slice(1), 0.5), warmBuildP95Ms: percentile(buildTimes.slice(1), 0.95), cacheStates, selectedDocumentIds: selectedIds, inputTokens: first.tokenEstimate, bundleDigest: first.bundleDigest, identicalBundleRate: new Set(bundles.map(bundle => bundle.bundleDigest)).size === 1 ? 1 : 0, omissionCount: first.omissions.length },
    priorityEvaluation: report.variants.abcmAutomatic,
  };
  console.log(JSON.stringify(output, null, 2));
  if (process.env.ABCM_BENCH_ENFORCE === "true" && (
    report.variants.abcmAutomatic?.overall !== "pass" ||
    cacheStates[0] !== "miss" ||
    cacheStates.slice(1).some(state => state !== "hit")
  )) process.exitCode = 1;
} finally {
  await client.close();
}
