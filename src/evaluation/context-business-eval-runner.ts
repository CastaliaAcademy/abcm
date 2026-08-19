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
    modelIdentityDigest: digest.nullable(),
    judgeRubricDigest: digest.nullable(),
    judgeIdentityClass: id.nullable(),
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
        const orderedVariants = [...contextBusinessVariants].sort((left, right) =>
          sha({ seed: input.blindSeedDigest, scenarioId: scenario.id, repeatIndex, variant: left }).localeCompare(
            sha({ seed: input.blindSeedDigest, scenarioId: scenario.id, repeatIndex, variant: right }),
          ));
        for (const variant of orderedVariants) {
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
    };
    const receipt = businessEvaluationReceiptSchema.parse({
      ...receiptWithoutDigest,
      aggregateDigest: sha(receiptWithoutDigest),
      createdAt: new Date(this.#clock()).toISOString(),
    });
    return this.#catalog.recordBusinessEvaluation(deepFreeze(receipt));
  }
}
