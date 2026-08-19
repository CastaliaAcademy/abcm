import { createHash } from "node:crypto";

import { z } from "zod/v4";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const id = z.string().min(1).max(256);
const safeCount = z.number().int().nonnegative();

const businessScenarioSchema = z.object({
  id,
  title: z.string().min(1),
  fixture: id,
  when: z.string().min(1),
  then: z.array(z.string().min(1)).min(1),
  gates: z.array(z.string().min(1)).optional(),
}).strict();

export const businessScenarioDatasetSchema = z.object({
  schemaVersion: z.literal("abcm.eval.business.v1"),
  id,
  title: z.string().min(1),
  status: id,
  language: z.string().min(2).max(64),
  ownerScope: id,
  sourceBaseline: z.object({
    path: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    sourceChecksum: digest,
  }).strict(),
  metrics: z.record(id, z.string().min(1)),
  proposedGates: z.record(id, z.unknown()),
  scenarios: z.array(businessScenarioSchema).min(1),
}).strict().superRefine((dataset, context) => {
  const ids = dataset.scenarios.map(scenario => scenario.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["scenarios"], message: "Business scenario ids must be unique." });
});

const realFixtureSchema = z.object({
  id,
  title: z.string().min(1).optional(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  goldCount: safeCount.optional(),
  special: z.string().min(1).optional(),
  includes: z.array(id).min(1).optional(),
}).strict();
const syntheticFixtureSchema = z.object({
  id,
  scopes: safeCount,
  files: safeCount,
  documents: safeCount,
  skills: safeCount,
}).strict();
const adversarialFixtureSchema = z.object({ id, properties: z.array(z.string().min(1)).min(1) }).strict();

export const businessFixtureCatalogSchema = z.object({
  schemaVersion: z.literal("abcm.eval.fixtures.v1"),
  id,
  title: z.string().min(1),
  status: id,
  language: z.string().min(2).max(64),
  ownerScope: id,
  reproducibility: z.object({ pin: z.array(z.string().min(1)).min(1), rawEvidence: z.array(z.string().min(1)).min(1) }).strict(),
  real: z.array(realFixtureSchema),
  synthetic: z.array(syntheticFixtureSchema),
  adversarial: z.array(adversarialFixtureSchema),
}).strict().superRefine((catalog, context) => {
  const ids = [...catalog.real, ...catalog.synthetic, ...catalog.adversarial].map(fixture => fixture.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: [], message: "Business fixture ids must be unique." });
});

export const contextBusinessVariants = ["V0", "V1", "V2", "V3", "V4", "V5"] as const;
const variantSchema = z.enum(contextBusinessVariants);

export const businessEvaluationInputSchema = z.object({
  workspaceId: id,
  phase: z.enum(["retrieval", "task-success"]),
  repetitions: z.number().int().min(1).max(30),
  blindSeedDigest: digest,
  inputIdentity: z.object({
    workspaceSnapshotDigest: digest,
    principalAccessDigest: digest,
    requestSetDigest: digest,
    policyDigest: digest,
    selectionPolicyVersion: id,
    cachePolicyDigest: digest,
    cachePolicyVersion: id,
    projectionPolicyVersion: id,
    budgetProfileDigest: digest,
    baselineIdentityDigest: digest,
    executionEnvironmentDigest: digest,
    measurementWindowDigest: digest,
    modelIdentityDigest: digest.nullable(),
    judgeRubricDigest: digest.nullable(),
    judgeIdentityClass: id.nullable(),
  }).strict(),
  gatePolicy: z.object({
    mandatoryRecallMin: z.number().min(0).max(1),
    precisionMin: z.number().min(0).max(1),
    relevantTokenRatioMin: z.number().min(0).max(1),
    taskSuccessRateMaxDegradationVsV0: z.number().min(0).max(1),
    deterministicBundleRateMin: z.number().min(0).max(1),
    stableErrorClassificationRateMin: z.number().min(0).max(1),
    unauthorizedLeakageMax: safeCount,
    tokenReductionMin: z.number().min(0).max(1),
    costPerSuccessfulTaskReductionMin: z.number().min(0).max(1),
    requiredFallbackModes: z.array(z.enum(["direct-search", "explicit-documents", "bounded-resource-read", "explainable-preview"])).min(1),
  }).strict(),
}).strict().superRefine((input, context) => {
  if (input.phase === "task-success" && (
    input.inputIdentity.modelIdentityDigest === null ||
    input.inputIdentity.judgeRubricDigest === null ||
    input.inputIdentity.judgeIdentityClass === null
  )) {
    context.addIssue({ code: "custom", path: ["inputIdentity"], message: "Task-success evaluation requires pinned model and blind judge identities." });
  }
});

export const businessEvaluationRunRequestSchema = z.object({
  dataset: businessScenarioDatasetSchema,
  fixtures: businessFixtureCatalogSchema,
  input: businessEvaluationInputSchema,
}).strict();

export const businessEvaluationListRequestSchema = z.object({
  workspaceId: id,
  datasetId: id,
}).strict();

const fallbackModeSchema = z.enum(["direct-search", "explicit-documents", "bounded-resource-read", "explainable-preview"]);
export const businessVariantObservationSchema = z.object({
  resultDigest: digest,
  selectorTraceDigest: digest,
  selectedDocuments: z.array(z.object({ documentId: id, tokenEstimate: safeCount }).strict()),
  retrievedClaimIds: z.array(id),
  totalInputTokens: safeCount,
  taskSucceeded: z.boolean(),
  totalCostMicrounits: safeCount,
  unauthorizedDisclosureCount: safeCount,
  errorCode: id.nullable(),
  cache: z.object({
    state: z.enum(["bypass", "hit", "miss", "stale"]),
    policyVersion: id,
    keyDigest: digest.optional(),
  }).strict(),
  latencyMs: z.object({
    total: z.number().nonnegative(),
    bootstrap: z.number().nonnegative().optional(),
    resolution: z.number().nonnegative().optional(),
    materialization: z.number().nonnegative().optional(),
  }).strict(),
  fallback: z.object({
    availableModes: z.array(fallbackModeSchema),
    usedMode: fallbackModeSchema.optional(),
    recoveredDocumentIds: z.array(id).optional(),
    addedTokens: safeCount.optional(),
  }).strict(),
  rawMetrics: z.object({
    mandatoryRecall: z.number().min(0).max(1),
    precision: z.number().min(0).max(1),
    relevantTokenRatio: z.number().min(0).max(1),
    firstAttemptSucceeded: z.boolean(),
    explicitLinkResolutionRate: z.number().min(0).max(1),
    stableErrorClassificationRate: z.number().min(0).max(1),
    omissionCount: safeCount,
    outputTokens: safeCount,
    toolTokens: safeCount,
  }).strict(),
}).strict().superRefine((observation, context) => {
  const documentIds = observation.selectedDocuments.map(document => document.documentId);
  if (new Set(documentIds).size !== documentIds.length) context.addIssue({ code: "custom", path: ["selectedDocuments"], message: "Selected document ids must be unique." });
  if (new Set(observation.retrievedClaimIds).size !== observation.retrievedClaimIds.length) context.addIssue({ code: "custom", path: ["retrievedClaimIds"], message: "Retrieved claim ids must be unique." });
  if (observation.fallback.usedMode !== undefined && !observation.fallback.availableModes.includes(observation.fallback.usedMode)) {
    context.addIssue({ code: "custom", path: ["fallback", "usedMode"], message: "Used fallback mode must be advertised." });
  }
});

const businessRunObservationReceiptSchema = businessVariantObservationSchema.extend({
  scenarioId: id,
  fixtureId: id,
  variant: variantSchema,
  repeatIndex: z.number().int().nonnegative(),
  blindLabel: z.string().regex(/^blind-[a-f0-9]{16}$/),
  observationDigest: digest,
}).strict();

const gateStatusSchema = z.enum(["pass", "fail", "baseline", "not_evaluable"]);
const businessVariantAggregateSchema = z.object({
  variant: variantSchema,
  runCount: z.number().int().positive(),
  medianInputTokens: z.number().nonnegative(),
  medianMandatoryRecall: z.number().min(0).max(1),
  medianPrecision: z.number().min(0).max(1),
  medianRelevantTokenRatio: z.number().min(0).max(1),
  taskSuccessRate: z.number().min(0).max(1),
  firstAttemptSuccessRate: z.number().min(0).max(1),
  deterministicBundleRate: z.number().min(0).max(1),
  stableErrorClassificationRate: z.number().min(0).max(1),
  explicitLinkResolutionRate: z.number().min(0).max(1),
  unauthorizedDisclosureCount: safeCount,
  totalCostMicrounits: safeCount,
  costPerSuccessfulTaskMicrounits: z.number().nonnegative().nullable(),
  medianOmissionCount: z.number().nonnegative(),
  latencyMs: z.object({ p50: z.number().nonnegative(), p95: z.number().nonnegative(), p99: z.number().nonnegative() }).strict(),
  comparisonToV0: z.object({
    taskSuccessRateDegradation: z.number(),
    tokenReduction: z.number(),
    costPerSuccessfulTaskReduction: z.number().nullable(),
  }).strict(),
  gates: z.object({
    correctness: gateStatusSchema,
    quality: gateStatusSchema,
    fallbackFlexibility: gateStatusSchema,
    efficiency: gateStatusSchema,
    overall: z.enum(["pass", "fail", "baseline"]),
  }).strict(),
}).strict();

export const businessEvaluationReceiptSchema = z.object({
  schemaVersion: z.literal("abcm.eval.business-run/v1"),
  runnerVersion: z.literal("context-business-runner/v1"),
  runId: z.string().regex(/^business-run-[a-f0-9]{24}$/),
  workspaceId: id,
  datasetId: id,
  datasetDigest: digest,
  fixtureCatalogId: id,
  fixtureCatalogDigest: digest,
  phase: z.enum(["retrieval", "task-success"]),
  repetitions: z.number().int().min(1).max(30),
  inputIdentity: businessEvaluationInputSchema.shape.inputIdentity,
  blindSeedDigest: digest,
  variants: z.tuple(contextBusinessVariants.map(value => z.literal(value)) as [
    z.ZodLiteral<"V0">,
    z.ZodLiteral<"V1">,
    z.ZodLiteral<"V2">,
    z.ZodLiteral<"V3">,
    z.ZodLiteral<"V4">,
    z.ZodLiteral<"V5">,
  ]),
  baselineVariant: z.literal("V0"),
  runs: z.array(businessRunObservationReceiptSchema).min(1),
  variantAggregates: z.array(businessVariantAggregateSchema).length(6),
  aggregateDigest: digest,
  createdAt: z.string().datetime(),
}).strict();

export type BusinessScenarioDataset = z.infer<typeof businessScenarioDatasetSchema>;
export type BusinessFixtureCatalog = z.infer<typeof businessFixtureCatalogSchema>;
export type BusinessEvaluationInput = z.infer<typeof businessEvaluationInputSchema>;
export type BusinessEvaluationRunRequest = z.infer<typeof businessEvaluationRunRequestSchema>;
export type BusinessVariant = z.infer<typeof variantSchema>;
export type BusinessVariantObservation = z.infer<typeof businessVariantObservationSchema>;
export type BusinessEvaluationReceipt = z.infer<typeof businessEvaluationReceiptSchema>;

export interface BusinessEvaluationCatalog {
  getBusinessEvaluation(workspaceId: string, runId: string): BusinessEvaluationReceipt | undefined;
  recordBusinessEvaluation(receipt: BusinessEvaluationReceipt): BusinessEvaluationReceipt;
  listBusinessEvaluations(workspaceId: string, datasetId: string): BusinessEvaluationReceipt[];
}

export interface BusinessVariantExecutionRequest {
  workspaceId: string;
  dataset: BusinessScenarioDataset;
  scenario: BusinessScenarioDataset["scenarios"][number];
  fixtures: BusinessFixtureCatalog;
  variant: BusinessVariant;
  repeatIndex: number;
  phase: BusinessEvaluationInput["phase"];
  blindLabel: string;
  inputIdentity: BusinessEvaluationInput["inputIdentity"];
  signal?: AbortSignal;
}

export type BusinessVariantExecutor = (request: BusinessVariantExecutionRequest) => Promise<BusinessVariantObservation | unknown>;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function percentile(values: readonly number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))]!;
}

function median(values: readonly number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1]! + ordered[middle]!) / 2 : ordered[middle]!;
}

export class InMemoryBusinessEvaluationCatalog implements BusinessEvaluationCatalog {
  readonly #receipts = new Map<string, BusinessEvaluationReceipt>();

  getBusinessEvaluation(workspaceId: string, runId: string): BusinessEvaluationReceipt | undefined {
    const receipt = this.#receipts.get(runId);
    return receipt?.workspaceId === workspaceId ? receipt : undefined;
  }

  recordBusinessEvaluation(receipt: BusinessEvaluationReceipt): BusinessEvaluationReceipt {
    const parsed = businessEvaluationReceiptSchema.parse(receipt);
    const existing = this.#receipts.get(parsed.runId);
    if (existing !== undefined) {
      if (existing.aggregateDigest !== parsed.aggregateDigest) throw new Error("Business evaluation run identity is already bound to another immutable receipt.");
      return existing;
    }
    const frozen = deepFreeze(parsed);
    this.#receipts.set(frozen.runId, frozen);
    return frozen;
  }

  listBusinessEvaluations(workspaceId: string, datasetId: string): BusinessEvaluationReceipt[] {
    return [...this.#receipts.values()]
      .filter(receipt => receipt.workspaceId === workspaceId && receipt.datasetId === datasetId)
      .sort((left, right) => left.runId.localeCompare(right.runId));
  }
}

export class ContextBusinessEvalRunner {
  readonly #catalog: BusinessEvaluationCatalog;
  readonly #executor: BusinessVariantExecutor;
  readonly #clock: () => number;

  constructor(catalog: BusinessEvaluationCatalog, executor: BusinessVariantExecutor, clock: () => number = Date.now) {
    this.#catalog = catalog;
    this.#executor = executor;
    this.#clock = clock;
  }

  list(workspaceId: string, datasetId: string): BusinessEvaluationReceipt[] {
    return this.#catalog.listBusinessEvaluations(workspaceId, datasetId);
  }

  async run(datasetInput: unknown, fixtureInput: unknown, runInput: unknown, signal?: AbortSignal): Promise<BusinessEvaluationReceipt> {
    signal?.throwIfAborted();
    const dataset = businessScenarioDatasetSchema.parse(datasetInput);
    const fixtures = businessFixtureCatalogSchema.parse(fixtureInput);
    const input = businessEvaluationInputSchema.parse(runInput);
    const fixtureIds = new Set([...fixtures.real, ...fixtures.synthetic, ...fixtures.adversarial].map(fixture => fixture.id));
    for (const scenario of dataset.scenarios) {
      if (!fixtureIds.has(scenario.fixture)) throw new Error(`Business scenario '${scenario.id}' references unknown fixture '${scenario.fixture}'.`);
    }
    const datasetDigest = sha(dataset);
    const fixtureCatalogDigest = sha(fixtures);
    const runIdentity = {
      runnerVersion: "context-business-runner/v1",
      workspaceId: input.workspaceId,
      datasetDigest,
      fixtureCatalogDigest,
      phase: input.phase,
      repetitions: input.repetitions,
      blindSeedDigest: input.blindSeedDigest,
      inputIdentity: input.inputIdentity,
      variants: contextBusinessVariants,
    };
    const runIdentityDigest = sha(runIdentity);
    const runId = `business-run-${runIdentityDigest.slice("sha256:".length, "sha256:".length + 24)}`;
    const existing = this.#catalog.getBusinessEvaluation(input.workspaceId, runId);
    if (existing !== undefined) return existing;

    const runs: z.infer<typeof businessRunObservationReceiptSchema>[] = [];
    for (const scenario of dataset.scenarios) {
      for (let repeatIndex = 0; repeatIndex < input.repetitions; repeatIndex++) {
        const executionBlocks: readonly (BusinessVariant | readonly ["V3", "V4"])[] = ["V0", "V1", "V2", ["V3", "V4"], "V5"];
        const orderedVariants = [...executionBlocks].sort((left, right) =>
          sha({ seed: input.blindSeedDigest, scenarioId: scenario.id, repeatIndex, block: left }).localeCompare(
            sha({ seed: input.blindSeedDigest, scenarioId: scenario.id, repeatIndex, block: right }),
          ));
        for (const variant of orderedVariants.flatMap(block => typeof block === "string" ? [block] : block)) {
          signal?.throwIfAborted();
          const blindLabel = `blind-${sha({ seed: input.blindSeedDigest, scenarioId: scenario.id, repeatIndex, variant }).slice(-16)}`;
          const observation = businessVariantObservationSchema.parse(await this.#executor({
            workspaceId: input.workspaceId,
            dataset,
            scenario,
            fixtures,
            variant,
            repeatIndex,
            phase: input.phase,
            blindLabel,
            inputIdentity: input.inputIdentity,
            ...(signal === undefined ? {} : { signal }),
          }));
          signal?.throwIfAborted();
          if (variant === "V3" && observation.cache.state !== "miss") {
            throw new Error(`Cold-cache variant V3 must report cache.state=miss for '${scenario.id}' repeat ${repeatIndex}.`);
          }
          if (variant === "V4" && observation.cache.state !== "hit") {
            throw new Error(`Warm-cache variant V4 must report cache.state=hit for '${scenario.id}' repeat ${repeatIndex}.`);
          }
          if ((variant === "V3" || variant === "V4") && observation.cache.policyVersion !== input.inputIdentity.cachePolicyVersion) {
            throw new Error(`Variant ${variant} cache policy version does not match pinned evaluation identity.`);
          }
          runs.push(businessRunObservationReceiptSchema.parse({
            ...observation,
            scenarioId: scenario.id,
            fixtureId: scenario.fixture,
            variant,
            repeatIndex,
            blindLabel,
            observationDigest: sha(observation),
          }));
        }
      }
    }
    const receiptWithoutDigest = {
      schemaVersion: "abcm.eval.business-run/v1" as const,
      runnerVersion: "context-business-runner/v1" as const,
      runId,
      workspaceId: input.workspaceId,
      datasetId: dataset.id,
      datasetDigest,
      fixtureCatalogId: fixtures.id,
      fixtureCatalogDigest,
      phase: input.phase,
      repetitions: input.repetitions,
      inputIdentity: input.inputIdentity,
      blindSeedDigest: input.blindSeedDigest,
      variants: contextBusinessVariants,
      baselineVariant: "V0" as const,
      runs,
      variantAggregates: this.#aggregate(runs, input),
    };
    const receipt = businessEvaluationReceiptSchema.parse({
      ...receiptWithoutDigest,
      aggregateDigest: sha(receiptWithoutDigest),
      createdAt: new Date(this.#clock()).toISOString(),
    });
    return this.#catalog.recordBusinessEvaluation(deepFreeze(receipt));
  }

  #aggregate(runs: readonly z.infer<typeof businessRunObservationReceiptSchema>[], input: BusinessEvaluationInput) {
    const preliminary = contextBusinessVariants.map(variant => {
      const selected = runs.filter(run => run.variant === variant);
      const successful = selected.filter(run => run.taskSucceeded).length;
      const totalCostMicrounits = selected.reduce((sum, run) => sum + run.totalCostMicrounits, 0);
      const scenarioGroups = new Map<string, string[]>();
      for (const run of selected) {
        const group = scenarioGroups.get(run.scenarioId) ?? [];
        group.push(run.resultDigest);
        scenarioGroups.set(run.scenarioId, group);
      }
      const deterministicBundleRate = [...scenarioGroups.values()].filter(digests => new Set(digests).size === 1).length / scenarioGroups.size;
      return {
        variant,
        runCount: selected.length,
        medianInputTokens: median(selected.map(run => run.totalInputTokens)),
        medianMandatoryRecall: median(selected.map(run => run.rawMetrics.mandatoryRecall)),
        medianPrecision: median(selected.map(run => run.rawMetrics.precision)),
        medianRelevantTokenRatio: median(selected.map(run => run.rawMetrics.relevantTokenRatio)),
        taskSuccessRate: successful / selected.length,
        firstAttemptSuccessRate: selected.filter(run => run.rawMetrics.firstAttemptSucceeded).length / selected.length,
        deterministicBundleRate,
        stableErrorClassificationRate: median(selected.map(run => run.rawMetrics.stableErrorClassificationRate)),
        explicitLinkResolutionRate: median(selected.map(run => run.rawMetrics.explicitLinkResolutionRate)),
        unauthorizedDisclosureCount: selected.reduce((sum, run) => sum + run.unauthorizedDisclosureCount, 0),
        totalCostMicrounits,
        costPerSuccessfulTaskMicrounits: successful === 0 ? null : totalCostMicrounits / successful,
        medianOmissionCount: median(selected.map(run => run.rawMetrics.omissionCount)),
        latencyMs: {
          p50: percentile(selected.map(run => run.latencyMs.total), 0.5),
          p95: percentile(selected.map(run => run.latencyMs.total), 0.95),
          p99: percentile(selected.map(run => run.latencyMs.total), 0.99),
        },
      };
    });
    const baseline = preliminary.find(aggregate => aggregate.variant === "V0")!;
    return preliminary.map(aggregate => {
      const costReduction = aggregate.costPerSuccessfulTaskMicrounits === null || baseline.costPerSuccessfulTaskMicrounits === null || baseline.costPerSuccessfulTaskMicrounits === 0
        ? null
        : 1 - aggregate.costPerSuccessfulTaskMicrounits / baseline.costPerSuccessfulTaskMicrounits;
      const comparisonToV0 = {
        taskSuccessRateDegradation: baseline.taskSuccessRate - aggregate.taskSuccessRate,
        tokenReduction: baseline.medianInputTokens === 0 ? 0 : 1 - aggregate.medianInputTokens / baseline.medianInputTokens,
        costPerSuccessfulTaskReduction: costReduction,
      };
      const correctness = aggregate.medianMandatoryRecall >= input.gatePolicy.mandatoryRecallMin &&
        aggregate.deterministicBundleRate >= input.gatePolicy.deterministicBundleRateMin &&
        aggregate.stableErrorClassificationRate >= input.gatePolicy.stableErrorClassificationRateMin &&
        aggregate.unauthorizedDisclosureCount <= input.gatePolicy.unauthorizedLeakageMax;
      const quality = aggregate.medianPrecision >= input.gatePolicy.precisionMin &&
        aggregate.medianRelevantTokenRatio >= input.gatePolicy.relevantTokenRatioMin &&
        comparisonToV0.taskSuccessRateDegradation <= input.gatePolicy.taskSuccessRateMaxDegradationVsV0;
      const fallbackFlexibility = runs.filter(run => run.variant === aggregate.variant).every(run =>
        input.gatePolicy.requiredFallbackModes.every(mode => run.fallback.availableModes.includes(mode)),
      );
      const isDiagnosticComparator = aggregate.variant === "V1" || aggregate.variant === "V2";
      const efficiency = aggregate.variant === "V0"
        ? "baseline" as const
        : isDiagnosticComparator
          ? "not_evaluable" as const
          : !correctness || !quality || !fallbackFlexibility
          ? "not_evaluable" as const
          : comparisonToV0.tokenReduction >= input.gatePolicy.tokenReductionMin &&
              costReduction !== null && costReduction >= input.gatePolicy.costPerSuccessfulTaskReductionMin
            ? "pass" as const
            : "fail" as const;
      return businessVariantAggregateSchema.parse({
        ...aggregate,
        comparisonToV0,
        gates: aggregate.variant === "V0"
          ? { correctness: correctness ? "pass" : "fail", quality: quality ? "pass" : "fail", fallbackFlexibility: fallbackFlexibility ? "pass" : "fail", efficiency, overall: correctness && quality && fallbackFlexibility ? "baseline" : "fail" }
          : { correctness: correctness ? "pass" : "fail", quality: quality ? "pass" : "fail", fallbackFlexibility: fallbackFlexibility ? "pass" : "fail", efficiency, overall: correctness && quality && fallbackFlexibility && (isDiagnosticComparator || efficiency === "pass") ? "pass" : "fail" },
      });
    });
  }
}
