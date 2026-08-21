import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod/v4";

import { parseSafeYaml } from "../src/core/safe-yaml.js";
import type { ContextLinkGraphFinalizeResult, ContextLinkGraphSessionView } from "../src/context/link-graph-session.js";
import { contextEfficiencyManifestSchema, retrievalRunReceiptSchema } from "../src/evaluation/context-efficiency-contracts.js";
import { evaluateContextEfficiency } from "../src/evaluation/context-efficiency-evaluator.js";
import { runDirectSearchBaseline } from "../src/evaluation/direct-search-baseline.js";
import {
  ContextBusinessEvalRunner,
  InMemoryBusinessEvaluationCatalog,
  businessFixtureCatalogSchema,
  businessScenarioDatasetSchema,
} from "../src/evaluation/context-business-eval-runner.js";
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
const businessQualificationSchema = z.object({
  schemaVersion: z.literal("abcm.benchmark.context-business/v1"),
  id: z.string().min(1),
  title: z.string().min(1),
  language: z.string().min(2),
  phase: z.literal("retrieval"),
  repetitions: z.number().int().min(1).max(30),
  blindSeed: z.string().min(1),
  fixtureId: z.string().min(1),
  sourceBaseline: z.object({
    path: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceChecksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict(),
  scenarioIds: z.array(z.string().regex(/^BIZ-SYN-[0-9]{3}$/)).length(16),
  gatePolicy: z.object({
    mandatoryRecallMin: z.number().min(0).max(1), precisionMin: z.number().min(0).max(1), relevantTokenRatioMin: z.number().min(0).max(1),
    taskSuccessRateMaxDegradationVsV0: z.number().min(0).max(1), deterministicBundleRateMin: z.number().min(0).max(1),
    stableErrorClassificationRateMin: z.number().min(0).max(1), unauthorizedLeakageMax: z.number().int().nonnegative(),
    tokenReductionMin: z.number().min(0).max(1), costPerSuccessfulTaskReductionMin: z.number().min(0).max(1),
    requiredFallbackModes: z.array(z.enum(["direct-search", "explicit-documents", "bounded-resource-read", "explainable-preview"])).min(1),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (new Set(manifest.scenarioIds).size !== manifest.scenarioIds.length) context.addIssue({ code: "custom", path: ["scenarioIds"], message: "Scenario ids must be unique." });
});
const businessQualification = businessQualificationSchema.parse(
  parseSafeYaml(await Bun.file("benchmarks/fixtures/context-efficiency-v1/business-qualification.yaml").text()),
);
const linkGraphQualificationSchema = z.object({
  schemaVersion: z.literal("abcm.benchmark.link-graph-context/v1"),
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  seedDocumentIds: z.array(z.string().min(1)).min(1),
  expectedInitialCandidates: z.array(z.string().min(1)),
  expandFromDocumentIds: z.array(z.string().min(1)).min(1),
  expectedExpandedCandidates: z.array(z.string().min(1)),
  confirmedDocumentIds: z.array(z.string().min(1)).min(1),
  mandatoryDocumentIds: z.array(z.string().min(1)).min(1),
  requiredFallbackModes: z.array(z.enum(["direct-search", "explicit-documents", "bounded-resource-read"])).min(1),
  repetitions: z.number().int().min(2).max(30),
  gates: z.object({
    relevance: z.object({ mandatoryRecallMin: z.number().min(0).max(1), precisionVsDirect: z.literal("gte") }).strict(),
    fallback: z.object({ requireAllDeclaredModes: z.literal(true) }).strict(),
    determinism: z.object({ identicalBundleRateMin: z.number().min(0).max(1) }).strict(),
    isolation: z.object({ unauthorizedDisclosureMax: z.number().int().nonnegative() }).strict(),
    contextEfficiency: z.object({ tokenReductionMin: z.number().min(0).max(1) }).strict(),
  }).strict(),
}).strict();
const linkGraphQualification = linkGraphQualificationSchema.parse(
  parseSafeYaml(await Bun.file("benchmarks/fixtures/context-efficiency-v1/link-graph-qualification.yaml").text()),
);
const baseUrl = process.env.ABCM_BENCH_BASE_URL ?? "http://127.0.0.1:8791";
const token = process.env.ABCM_BENCH_TOKEN ?? "benchmark-token-123456789";
const measurementStartedAt = new Date().toISOString();
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
  const guidedStarted = performance.now();
  const guidedResult = await client.callTool({ name: "context.build_task_context", arguments: {
    domainLanguageBootstrapId: bootstrapId,
    roleId: fixtureManifest.roleId,
    taskType: fixtureManifest.taskType,
    goal: fixtureManifest.goal,
    targetHints: { scopeIds: [fixtureManifest.scopeId] },
    explicitDocuments: fixtureManifest.goldDocumentIds.map(documentId => ({ selector: "document-id", documentId })),
    budgetProfile: "expanded",
    execution: { planId: "PLAN-0031", runId: "docker-eval-guided" },
  } });
  const guidedMs = elapsed(guidedStarted);
  if (guidedResult.isError) throw new Error(`Guided context build failed: ${JSON.stringify(guidedResult.content)}`);
  const guided = guidedResult.structuredContent as typeof first;
  const guidedCorpus = guided.selectedDocuments.map(document => document.projection.content ?? "").join("\n").toLocaleLowerCase("ru-RU");
  const guidedClaimIds = fixtureManifest.claims.filter(claim => claim.allTerms.every(term => guidedCorpus.includes(term.toLocaleLowerCase("ru-RU")))).map(claim => claim.id);
  const graphRuns: Array<{ view: ContextLinkGraphSessionView; result: ContextLinkGraphFinalizeResult; durationMs: number }> = [];
  for (let index = 0; index < linkGraphQualification.repetitions; index++) {
    const graphStarted = performance.now();
    const started = await client.callTool({ name: "context.start_link_graph_session", arguments: {
      workspaceId: linkGraphQualification.workspaceId,
      seedDocumentIds: linkGraphQualification.seedDocumentIds,
      request: {
        domainLanguageBootstrapId: bootstrapId,
        roleId: fixtureManifest.roleId,
        taskType: fixtureManifest.taskType,
        goal: fixtureManifest.goal,
        targetHints: { scopeIds: [fixtureManifest.scopeId] },
        budgetProfile: "expanded",
        execution: { planId: "PLAN-0033", runId: "docker-link-graph-eval" },
      },
    } });
    if (started.isError) throw new Error(`Link-graph session start failed: ${JSON.stringify(started.content)}`);
    const initial = started.structuredContent as unknown as ContextLinkGraphSessionView;
    const initialCandidateIds = initial.candidates.map(candidate => candidate.documentId).sort();
    if (JSON.stringify(initialCandidateIds) !== JSON.stringify([...linkGraphQualification.expectedInitialCandidates].sort())) {
      throw new Error(`Unexpected initial link-graph candidates: ${JSON.stringify(initialCandidateIds)}`);
    }
    const expandedResult = await client.callTool({ name: "context.step_link_graph_session", arguments: {
      sessionId: initial.sessionId,
      sequence: 1,
      previousStateDigest: initial.stateDigest,
      operation: { kind: "expand", fromDocumentIds: linkGraphQualification.expandFromDocumentIds },
    } });
    if (expandedResult.isError) throw new Error(`Link-graph expansion failed: ${JSON.stringify(expandedResult.content)}`);
    const expanded = expandedResult.structuredContent as unknown as ContextLinkGraphSessionView;
    const expandedCandidateIds = expanded.candidates.map(candidate => candidate.documentId).sort();
    if (JSON.stringify(expandedCandidateIds) !== JSON.stringify([...linkGraphQualification.expectedExpandedCandidates].sort())) {
      throw new Error(`Unexpected expanded link-graph candidates: ${JSON.stringify(expandedCandidateIds)}`);
    }
    const confirmedResult = await client.callTool({ name: "context.step_link_graph_session", arguments: {
      sessionId: initial.sessionId,
      sequence: 2,
      previousStateDigest: expanded.stateDigest,
      operation: { kind: "confirm", documentIds: linkGraphQualification.confirmedDocumentIds },
    } });
    if (confirmedResult.isError) throw new Error(`Link-graph confirmation failed: ${JSON.stringify(confirmedResult.content)}`);
    const confirmed = confirmedResult.structuredContent as unknown as ContextLinkGraphSessionView;
    const finalizedResult = await client.callTool({ name: "context.finalize_link_graph_session", arguments: {
      sessionId: initial.sessionId,
      expectedStateDigest: confirmed.stateDigest,
    } });
    if (finalizedResult.isError) throw new Error(`Link-graph finalization failed: ${JSON.stringify(finalizedResult.content)}`);
    graphRuns.push({
      view: confirmed,
      result: finalizedResult.structuredContent as unknown as ContextLinkGraphFinalizeResult,
      durationMs: elapsed(graphStarted),
    });
  }
  const graphFirst = graphRuns[0]!;
  const graphSelectedIds = graphFirst.result.bundle.selectedDocuments.map(document => document.documentId);
  const graphGold = new Set(fixtureManifest.goldDocumentIds);
  const graphMandatoryRecall = linkGraphQualification.mandatoryDocumentIds.filter(documentId => graphSelectedIds.includes(documentId)).length /
    linkGraphQualification.mandatoryDocumentIds.length;
  const graphPrecision = graphSelectedIds.filter(documentId => graphGold.has(documentId)).length / graphSelectedIds.length;
  const directPrecision = direct.selectedDocuments.filter(document => graphGold.has(document.documentId)).length / direct.selectedDocuments.length;
  const graphTokenReduction = (direct.totalInputTokens - graphFirst.result.bundle.tokenEstimate) / direct.totalInputTokens;
  const graphSerialized = JSON.stringify(graphRuns.map(run => ({ view: run.view, receipt: run.result.receipt })));
  const graphUnauthorizedDisclosureCount = fixtureManifest.forbiddenMarkers.some(marker => graphSerialized.includes(marker)) ? 1 : 0;
  const graphIdenticalBundleRate = new Set(graphRuns.map(run => run.result.bundle.bundleDigest)).size === 1 ? 1 : 0;
  const graphFallbackPass = linkGraphQualification.requiredFallbackModes.every(mode => graphFirst.view.fallbackModes.includes(mode));
  const linkGraphPriorityEvaluation = {
    priorityOrder: ["task_relevance", "fallback_flexibility", "determinism", "workspace_isolation", "context_efficiency"],
    taskRelevance: {
      mandatoryRecall: graphMandatoryRecall,
      precision: graphPrecision,
      directPrecision,
      pass: graphMandatoryRecall >= linkGraphQualification.gates.relevance.mandatoryRecallMin && graphPrecision >= directPrecision,
    },
    fallbackFlexibility: {
      availableModes: graphFirst.view.fallbackModes,
      pass: graphFallbackPass,
    },
    determinism: {
      identicalBundleRate: graphIdenticalBundleRate,
      pass: graphIdenticalBundleRate >= linkGraphQualification.gates.determinism.identicalBundleRateMin,
    },
    workspaceIsolation: {
      unauthorizedDisclosureCount: graphUnauthorizedDisclosureCount,
      pass: graphUnauthorizedDisclosureCount <= linkGraphQualification.gates.isolation.unauthorizedDisclosureMax,
    },
    contextEfficiency: {
      directInputTokens: direct.totalInputTokens,
      graphInputTokens: graphFirst.result.bundle.tokenEstimate,
      tokenReduction: graphTokenReduction,
      pass: graphTokenReduction >= linkGraphQualification.gates.contextEfficiency.tokenReductionMin,
    },
  };
  const linkGraphOverallPass = Object.entries(linkGraphPriorityEvaluation)
    .filter(([key]) => key !== "priorityOrder")
    .every(([, gate]) => (gate as { pass: boolean }).pass);
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
  const businessDataset = businessScenarioDatasetSchema.parse({
    schemaVersion: "abcm.eval.business.v1",
    id: businessQualification.id,
    title: businessQualification.title,
    status: "qualification",
    language: businessQualification.language,
    ownerScope: "abcm",
    sourceBaseline: businessQualification.sourceBaseline,
    metrics: { mandatoryRecall: "known gold", precision: "known gold", tokenReduction: "relative to V0" },
    proposedGates: { source: "PLAN-0031" },
    scenarios: businessQualification.scenarioIds.map((scenarioId, index) => ({
      id: scenarioId,
      title: `Known-data matrix case ${index + 1}`,
      fixture: businessQualification.fixtureId,
      when: `Одинаковая pinned структура, независимый scenario identity ${index + 1}.`,
      then: ["V0-V5 не смешиваются; relevance, cache, isolation и economics вычисляются сервером."],
      gates: ["mandatoryRecall=1.0", "unauthorizedLeakage=0"],
    })),
  });
  const businessFixtures = businessFixtureCatalogSchema.parse({
    schemaVersion: "abcm.eval.fixtures.v1",
    id: "docker-known-data-fixtures-v1",
    title: "Known-data Docker fixture",
    status: "qualification",
    language: "ru",
    ownerScope: "abcm",
    reproducibility: { pin: ["workspace snapshot", "container image", "request and policy digests"], rawEvidence: ["body-free business receipt", "Docker benchmark output"] },
    real: [],
    synthetic: [{ id: businessQualification.fixtureId, scopes: 3, files: 10, documents: 6, skills: 0 }],
    adversarial: [],
  });
  const gold = new Set(fixtureManifest.goldDocumentIds);
  const observation = (
    variant: "V0" | "V1" | "V2" | "V3" | "V4" | "V5",
  ) => {
    const selected = variant === "V3" || variant === "V4" ? first : variant === "V5" ? guided : undefined;
    const documents = selected === undefined
      ? direct.selectedDocuments.map(document => ({ documentId: document.documentId, tokenEstimate: document.tokenEstimate }))
      : selected.selectedDocuments.map(document => ({ documentId: document.documentId, tokenEstimate: document.tokenEstimate }));
    const claims = selected === undefined ? direct.retrievedClaimIds : variant === "V5" ? guidedClaimIds : retrievedClaimIds;
    const tokens = selected?.tokenEstimate ?? direct.totalInputTokens;
    const selectedGold = documents.filter(document => gold.has(document.documentId)).length;
    const mandatoryRecall = fixtureManifest.mandatoryDocumentIds.filter(documentId => documents.some(document => document.documentId === documentId)).length / fixtureManifest.mandatoryDocumentIds.length;
    const cache = variant === "V3"
      ? { state: "miss" as const, policyVersion: first.cache.policyVersion, keyDigest: first.cache.keyDigest }
      : variant === "V4"
        ? { state: "hit" as const, policyVersion: bundles[1]!.cache.policyVersion, keyDigest: bundles[1]!.cache.keyDigest }
        : variant === "V5"
          ? { state: guided.cache.state, policyVersion: guided.cache.policyVersion, keyDigest: guided.cache.keyDigest }
          : { state: "bypass" as const, policyVersion: "direct-search-no-cache/v1" };
    return {
      resultDigest: selected?.bundleDigest ?? direct.resultDigest,
      selectorTraceDigest: sha({ variant, goal: fixtureManifest.goal, explicitDocuments: variant === "V5" ? fixtureManifest.goldDocumentIds : [] }),
      selectedDocuments: documents,
      retrievedClaimIds: claims,
      totalInputTokens: tokens,
      taskSucceeded: mandatoryRecall === 1,
      totalCostMicrounits: tokens,
      unauthorizedDisclosureCount,
      errorCode: null,
      cache,
      latencyMs: { total: variant === "V3" ? buildTimes[0]! : variant === "V4" ? buildTimes[1]! : variant === "V5" ? guidedMs : directMs },
      fallback: { availableModes: ["direct-search", "explicit-documents", "bounded-resource-read"] as const },
      rawMetrics: {
        mandatoryRecall,
        precision: documents.length === 0 ? 0 : selectedGold / documents.length,
        relevantTokenRatio: documents.length === 0 ? 0 : selectedGold / documents.length,
        firstAttemptSucceeded: mandatoryRecall === 1,
        explicitLinkResolutionRate: variant === "V5" ? selectedGold / fixtureManifest.goldDocumentIds.length : 1,
        stableErrorClassificationRate: 1,
        omissionCount: selected === undefined ? 0 : selected.omissions.length,
        outputTokens: 0,
        toolTokens: 0,
      },
    };
  };
  const businessReceipt = await new ContextBusinessEvalRunner(
    new InMemoryBusinessEvaluationCatalog(),
    async request => observation(request.variant),
  ).run(businessDataset, businessFixtures, {
    workspaceId: fixtureManifest.workspaceId,
    phase: businessQualification.phase,
    repetitions: businessQualification.repetitions,
    blindSeedDigest: sha(businessQualification.blindSeed),
    inputIdentity: {
      workspaceSnapshotDigest: inputIdentity.workspaceSnapshotDigest,
      principalAccessDigest: inputIdentity.principalAccessDigest,
      requestSetDigest: inputIdentity.requestDigest,
      policyDigest: inputIdentity.policyDigest,
      selectionPolicyVersion: "context-selection/v4",
      cachePolicyDigest: sha(first.cache.policyVersion),
      cachePolicyVersion: first.cache.policyVersion,
      projectionPolicyVersion: first.cache.projectionPolicyVersion,
      budgetProfileDigest: sha({ budgetProfile: "expanded" }),
      baselineIdentityDigest: sha(directReceipt),
      executionEnvironmentDigest: sha({ runtime: Bun.version, benchmark: "context-efficiency-docker-v1", baseUrl }),
      measurementWindowDigest: sha({ measurementStartedAt }),
      modelIdentityDigest: null,
      judgeRubricDigest: null,
      judgeIdentityClass: null,
    },
    gatePolicy: businessQualification.gatePolicy,
  });
  const serverOwnedResponse = await fetch(new URL("/v1/context/business-evaluations", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ profileId: "docker-known-data-server-owned-v1" }),
  });
  if (!serverOwnedResponse.ok) throw new Error(`Server-owned business evaluation failed: ${serverOwnedResponse.status} ${await serverOwnedResponse.text()}`);
  const serverOwnedReceipt = await serverOwnedResponse.json() as typeof businessReceipt;
  const output = {
    benchmark: "context-efficiency-docker-v1",
    fixture: { workspaceId: fixtureManifest.workspaceId, goldDocumentIds: fixtureManifest.goldDocumentIds, repetitions: fixtureManifest.repetitions },
    direct: { durationMs: directMs, candidateReads: direct.trace.reads.length, selectedDocumentIds: direct.selectedDocuments.map(document => document.documentId), inputTokens: direct.totalInputTokens, digest: direct.resultDigest },
    abcm: { bootstrapMs, coldBuildMs: buildTimes[0], warmBuildP50Ms: percentile(buildTimes.slice(1), 0.5), warmBuildP95Ms: percentile(buildTimes.slice(1), 0.95), cacheStates, selectedDocumentIds: selectedIds, inputTokens: first.tokenEstimate, bundleDigest: first.bundleDigest, identicalBundleRate: new Set(bundles.map(bundle => bundle.bundleDigest)).size === 1 ? 1 : 0, omissionCount: first.omissions.length },
    linkGraph: {
      qualificationId: linkGraphQualification.id,
      repetitions: linkGraphQualification.repetitions,
      durationP50Ms: percentile(graphRuns.map(run => run.durationMs), 0.5),
      durationP95Ms: percentile(graphRuns.map(run => run.durationMs), 0.95),
      selectedDocumentIds: graphSelectedIds,
      confirmedDocumentIds: graphFirst.result.receipt.confirmedDocumentIds,
      inputTokens: graphFirst.result.bundle.tokenEstimate,
      bundleDigest: graphFirst.result.bundle.bundleDigest,
      receiptDigest: graphFirst.result.receipt.receiptDigest,
      receiptBodyFree: !graphSerialized.toLocaleLowerCase("ru-RU").includes("прежний результат"),
      priorityEvaluation: linkGraphPriorityEvaluation,
      overall: linkGraphOverallPass ? "pass" : "fail",
    },
    priorityEvaluation: report.variants.abcmAutomatic,
    businessEvaluation: {
      runId: businessReceipt.runId,
      aggregateDigest: businessReceipt.aggregateDigest,
      scenarios: businessDataset.scenarios.length,
      observations: businessReceipt.runs.length,
      bodyFree: !JSON.stringify(businessReceipt).toLocaleLowerCase("ru-RU").includes("idempotency key"),
      variants: businessReceipt.variantAggregates,
    },
    serverOwnedBusinessEvaluation: {
      runId: serverOwnedReceipt.runId,
      aggregateDigest: serverOwnedReceipt.aggregateDigest,
      scenarios: new Set(serverOwnedReceipt.runs.map(run => run.scenarioId)).size,
      observations: serverOwnedReceipt.runs.length,
      bodyFree: !JSON.stringify(serverOwnedReceipt).includes("idempotency key"),
      variants: serverOwnedReceipt.variantAggregates,
    },
  };
  console.log(JSON.stringify(output, null, 2));
  if (process.env.ABCM_BENCH_ENFORCE === "true" && (
    report.variants.abcmAutomatic?.overall !== "pass" ||
    !linkGraphOverallPass ||
    !graphRuns.every(run => run.result.receipt.steps.length === 2) ||
    graphRuns.some(run => run.result.receipt.bundleDigest !== run.result.bundle.bundleDigest) ||
    cacheStates[0] !== "miss" ||
    cacheStates.slice(1).some(state => state !== "hit") ||
    businessReceipt.variantAggregates.some(aggregate => aggregate.variant !== "V0" && aggregate.gates.overall !== "pass") ||
    serverOwnedReceipt.variantAggregates.some(aggregate => ["V3", "V4", "V5"].includes(aggregate.variant) && aggregate.gates.overall !== "pass")
  )) process.exitCode = 1;
} finally {
  await client.close();
}
