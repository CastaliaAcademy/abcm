import { createHash } from "node:crypto";

import { z } from "zod/v4";

import { ContextBuilder, CONTEXT_SELECTION_POLICY_VERSION, type ContextBuilderDependencies } from "../context/context-builder.js";
import {
  CONTEXT_BUILD_CACHE_POLICY_VERSION,
  DOCUMENT_PROJECTION_POLICY_VERSION,
  MemoryContextBuildCacheCatalog,
} from "../context/context-build-cache.js";
import type { BuildTaskContextRequest, ExplicitDocumentReference, SelectedContextDocument } from "../context/types.js";
import { AbcmError } from "../core/errors.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type { DocumentRecord, MapRevision, ScopeNode } from "../scope-map/types.js";
import {
  ContextBusinessEvalRunner,
  businessEvaluationInputSchema,
  businessFixtureCatalogSchema,
  businessScenarioDatasetSchema,
  type BusinessEvaluationCatalog,
  type BusinessEvaluationReceipt,
  type BusinessVariant,
  type BusinessVariantExecutionRequest,
  type BusinessVariantObservation,
  contextBusinessVariants,
} from "./context-business-eval-runner.js";
import { runDirectSearchBaseline } from "./direct-search-baseline.js";

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const idSchema = z.string().min(1).max(256);
const safePathSchema = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some(part => part === "" || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "Path must be a safe workspace-relative path." });
  }
});
const stringList = z.array(z.string().min(1)).max(256);
const explicitDocumentSchema = z.discriminatedUnion("selector", [
  z.object({ selector: z.literal("document-id"), documentId: idSchema, expectedKind: idSchema.optional() }).strict(),
  z.object({ selector: z.literal("uri"), uri: z.string().regex(/^abcm:\/\/(?:artifact|document|plan|architecture)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/), expectedKind: idSchema.optional() }).strict(),
  z.object({ selector: z.literal("repository-file"), path: safePathSchema, expectedKind: idSchema.optional() }).strict(),
  z.object({ selector: z.literal("repository-directory"), path: safePathSchema, recursive: z.boolean().optional(), expectedKind: idSchema.optional() }).strict(),
  z.object({ selector: z.literal("repository-prefix"), prefix: safePathSchema, expectedKind: idSchema.optional() }).strict(),
]);

const profiledContextRequestSchema = z.object({
  projectId: idSchema,
  roleId: idSchema,
  taskType: idSchema,
  goal: z.string().min(1).max(16_384),
  canonicalDomains: stringList.optional(),
  canonicalTerms: stringList.optional(),
  keywords: stringList.optional(),
  targetHints: stringList.optional(),
  exactScopeIds: z.array(idSchema).min(1).max(8).optional(),
  explicitLinks: stringList.optional(),
  artifacts: stringList.optional(),
  repositoryPaths: z.array(safePathSchema).max(256).optional(),
  budgetProfile: idSchema.optional(),
  requestedSkillIds: stringList.optional(),
  explicitDocuments: z.array(explicitDocumentSchema).min(1).max(64).optional(),
}).strict();

const gatePolicySchema = businessEvaluationInputSchema.shape.gatePolicy;

const scenarioExecutionSchema = z.object({
  scenarioId: idSchema,
  directSearch: z.object({
    queryTerms: stringList.min(1),
    allowedPathPrefixes: z.array(safePathSchema).min(1).max(256),
    includeExtensions: z.array(z.string().regex(/^\.[A-Za-z0-9]+$/)).min(1).max(32).optional(),
  }).strict(),
  context: profiledContextRequestSchema,
  guided: z.object({
    exactScopeIds: z.array(idSchema).min(1).max(8).optional(),
    explicitDocuments: z.array(explicitDocumentSchema).min(1).max(64).optional(),
  }).strict().optional(),
  goldDocumentIds: z.array(idSchema).min(1).max(512),
  mandatoryDocumentIds: z.array(idSchema).min(1).max(512),
  goldClaims: z.array(z.object({ id: idSchema, allTerms: stringList.min(1) }).strict()).max(512),
  forbiddenMarkers: z.array(z.string().min(1)).max(512),
}).strict().superRefine((scenario, context) => {
  for (const field of ["goldDocumentIds", "mandatoryDocumentIds"] as const) {
    if (new Set(scenario[field]).size !== scenario[field].length) context.addIssue({ code: "custom", path: [field], message: `${field} must be unique.` });
  }
  const gold = new Set(scenario.goldDocumentIds);
  for (const [index, documentId] of scenario.mandatoryDocumentIds.entries()) {
    if (!gold.has(documentId)) context.addIssue({ code: "custom", path: ["mandatoryDocumentIds", index], message: "Mandatory documents must belong to the gold set." });
  }
  if (new Set(scenario.goldClaims.map(claim => claim.id)).size !== scenario.goldClaims.length) {
    context.addIssue({ code: "custom", path: ["goldClaims"], message: "Gold claim ids must be unique." });
  }
});

export const businessEvaluationExecutionProfileSchema = z.object({
  schemaVersion: z.literal("abcm.eval.execution-profile/v1"),
  id: idSchema,
  version: idSchema,
  status: z.enum(["approved", "qualification"]),
  workspaceId: idSchema,
  phase: z.enum(["retrieval", "task-success"]),
  taskSuccess: z.object({
    workerPoolId: idSchema,
    modelIdentityDigest: digestSchema,
    judgeRubricDigest: digestSchema,
    judgeIdentityClass: idSchema,
  }).strict().optional(),
  dataset: businessScenarioDatasetSchema,
  fixtures: businessFixtureCatalogSchema,
  repetitions: z.number().int().min(1).max(30),
  blindSeedDigest: digestSchema,
  baselineIdentityDigest: digestSchema,
  executionEnvironmentDigest: digestSchema,
  measurementWindowDigest: digestSchema,
  gatePolicy: gatePolicySchema,
  scenarios: z.array(scenarioExecutionSchema).min(1),
}).strict().superRefine((profile, context) => {
  if (profile.phase === "task-success" && profile.taskSuccess === undefined) {
    context.addIssue({ code: "custom", path: ["taskSuccess"], message: "Task-success profiles require pinned worker, model, and judge identities." });
  }
  if (profile.phase === "retrieval" && profile.taskSuccess !== undefined) {
    context.addIssue({ code: "custom", path: ["taskSuccess"], message: "Retrieval profiles must not configure a task-success worker." });
  }
  const datasetIds = profile.dataset.scenarios.map(scenario => scenario.id);
  const executionIds = profile.scenarios.map(scenario => scenario.scenarioId);
  if (new Set(executionIds).size !== executionIds.length || datasetIds.length !== executionIds.length || datasetIds.some(id => !executionIds.includes(id))) {
    context.addIssue({ code: "custom", path: ["scenarios"], message: "Every dataset scenario must have exactly one execution and no extra execution is allowed." });
  }
  const fixtureIds = new Set([...profile.fixtures.real, ...profile.fixtures.synthetic, ...profile.fixtures.adversarial].map(fixture => fixture.id));
  for (const [index, scenario] of profile.dataset.scenarios.entries()) {
    if (!fixtureIds.has(scenario.fixture)) context.addIssue({ code: "custom", path: ["dataset", "scenarios", index, "fixture"], message: "Scenario fixture is absent from the profile fixture catalog." });
  }
});

export const serverOwnedBusinessEvaluationRunRequestSchema = z.object({ profileId: idSchema }).strict();
export const businessEvaluationProfileSummarySchema = z.object({
  id: idSchema,
  version: idSchema,
  workspaceId: idSchema,
  datasetId: idSchema,
  phase: z.enum(["retrieval", "task-success"]),
  scenarioCount: z.number().int().positive(),
}).strict();

export type BusinessEvaluationExecutionProfile = z.infer<typeof businessEvaluationExecutionProfileSchema>;
export type ServerOwnedBusinessEvaluationRunRequest = z.infer<typeof serverOwnedBusinessEvaluationRunRequestSchema>;
export type BusinessEvaluationProfileSummary = z.infer<typeof businessEvaluationProfileSummarySchema>;

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function tokens(content: string): number {
  return Math.ceil(new TextEncoder().encode(content).byteLength / 4);
}

function canReadDocument(principal: ContextPrincipal, node: ScopeNode): boolean {
  if (principal.access.workspacePermissions.includes("document.read")) return true;
  if (principal.access.scopeGrants?.[node.scopeId]?.includes("document.read") === true) return true;
  return node.aliases.some(alias => principal.access.scopeGrants?.[alias]?.includes("document.read") === true);
}

function active(document: DocumentRecord): boolean {
  return !["deleted", "archived", "superseded"].includes(document.lifecycle);
}

interface MaterializedEvaluationDocument {
  documentId: string;
  checksum: string;
  tokenEstimate: number;
  body: string;
}

export class BusinessEvaluationProfileRegistry {
  readonly #profiles = new Map<string, BusinessEvaluationExecutionProfile>();

  constructor(input: readonly unknown[]) {
    for (const candidate of input) {
      const profile = businessEvaluationExecutionProfileSchema.parse(candidate);
      if (this.#profiles.has(profile.id)) throw new Error(`Business evaluation profile '${profile.id}' is duplicated.`);
      this.#profiles.set(profile.id, Object.freeze(profile));
    }
    if (this.#profiles.size === 0) throw new Error("At least one business evaluation profile is required.");
  }

  get(profileId: string): BusinessEvaluationExecutionProfile {
    const profile = this.#profiles.get(profileId);
    if (profile === undefined) throw new AbcmError("REQUEST_INVALID", `Business evaluation profile '${profileId}' is not registered.`);
    return profile;
  }

  list(): BusinessEvaluationProfileSummary[] {
    return [...this.#profiles.values()].map(profile => ({
      id: profile.id,
      version: profile.version,
      workspaceId: profile.workspaceId,
      datasetId: profile.dataset.id,
      phase: profile.phase,
      scenarioCount: profile.scenarios.length,
    })).sort((left, right) => left.id.localeCompare(right.id));
  }
}

export interface ServerOwnedBusinessEvaluationServiceDependencies extends Omit<ContextBuilderDependencies, "cache"> {
  principal: ContextPrincipal;
}

export interface BusinessEvaluationApi {
  listProfiles(): BusinessEvaluationProfileSummary[];
  list(workspaceId: string, datasetId: string): BusinessEvaluationReceipt[];
  run(input: unknown, signal?: AbortSignal): Promise<BusinessEvaluationReceipt>;
}

export interface PreparedTaskSuccessJob {
  scenarioId: string;
  variant: BusinessVariant;
  repeatIndex: number;
  blindLabel: string;
  prompt: string;
  contextDocuments: readonly { documentId: string; content: string }[];
  retrievalObservation: BusinessVariantObservation;
}

export interface PreparedTaskSuccessEvaluation {
  profile: BusinessEvaluationExecutionProfile;
  input: z.infer<typeof businessEvaluationInputSchema>;
  jobs: readonly PreparedTaskSuccessJob[];
}

export class ServerOwnedBusinessEvaluationService implements BusinessEvaluationApi {
  readonly #catalog: BusinessEvaluationCatalog;
  readonly #profiles: BusinessEvaluationProfileRegistry;
  readonly #dependencies: ServerOwnedBusinessEvaluationServiceDependencies;

  constructor(catalog: BusinessEvaluationCatalog, profiles: BusinessEvaluationProfileRegistry, dependencies: ServerOwnedBusinessEvaluationServiceDependencies) {
    this.#catalog = catalog;
    this.#profiles = profiles;
    this.#dependencies = dependencies;
  }

  listProfiles(): BusinessEvaluationProfileSummary[] {
    return this.#profiles.list();
  }

  list(workspaceId: string, datasetId: string): BusinessEvaluationReceipt[] {
    return this.#catalog.listBusinessEvaluations(workspaceId, datasetId);
  }

  async run(input: unknown, signal?: AbortSignal): Promise<BusinessEvaluationReceipt> {
    const request = serverOwnedBusinessEvaluationRunRequestSchema.parse(input);
    const profile = this.#profiles.get(request.profileId);
    if (profile.phase !== "retrieval") throw new AbcmError("REQUEST_INVALID", "Task-success profiles must be started through the external-worker workflow.");
    const revision = this.#dependencies.scopeMap.getActiveRevision(profile.workspaceId);
    const contextBuilder = new ContextBuilder({ ...this.#dependencies, cache: new MemoryContextBuildCacheCatalog() });
    const executor = this.#executor(profile, revision, contextBuilder);
    const runner = new ContextBusinessEvalRunner(this.#catalog, executor);
    return runner.run(profile.dataset, profile.fixtures, this.#evaluationInput(profile, revision), signal);
  }

  async prepareTaskSuccess(profileId: string, signal?: AbortSignal): Promise<PreparedTaskSuccessEvaluation> {
    const profile = this.#profiles.get(profileId);
    if (profile.phase !== "task-success" || profile.taskSuccess === undefined) throw new AbcmError("REQUEST_INVALID", "Profile is not configured for task-success evaluation.");
    const revision = this.#dependencies.scopeMap.getActiveRevision(profile.workspaceId);
    const contextBuilder = new ContextBuilder({ ...this.#dependencies, cache: new MemoryContextBuildCacheCatalog() });
    const jobs: PreparedTaskSuccessJob[] = [];
    const executor = this.#executor(profile, revision, contextBuilder, job => jobs.push(job));
    const input = this.#evaluationInput(profile, revision);
    for (const scenario of profile.dataset.scenarios) {
      for (let repeatIndex = 0; repeatIndex < profile.repetitions; repeatIndex++) {
        for (const variant of contextBusinessVariants) {
          signal?.throwIfAborted();
          const blindLabel = `blind-${sha({ seed: profile.blindSeedDigest, scenarioId: scenario.id, repeatIndex, variant }).slice(-16)}`;
          await executor({ workspaceId: profile.workspaceId, dataset: profile.dataset, scenario, fixtures: profile.fixtures, variant, repeatIndex, phase: profile.phase, blindLabel, inputIdentity: input.inputIdentity, ...(signal === undefined ? {} : { signal }) });
        }
      }
    }
    return { profile, input, jobs };
  }

  async finalizeTaskSuccess(profileId: string, observations: ReadonlyMap<string, BusinessVariantObservation>, signal?: AbortSignal): Promise<BusinessEvaluationReceipt> {
    const profile = this.#profiles.get(profileId);
    if (profile.phase !== "task-success") throw new AbcmError("REQUEST_INVALID", "Profile is not configured for task-success evaluation.");
    const revision = this.#dependencies.scopeMap.getActiveRevision(profile.workspaceId);
    const runner = new ContextBusinessEvalRunner(this.#catalog, async request => {
      const key = `${request.scenario.id}:${request.variant}:${request.repeatIndex}`;
      const observation = observations.get(key);
      if (observation === undefined) throw new Error(`Task-success observation '${key}' is missing.`);
      return observation;
    });
    return runner.run(profile.dataset, profile.fixtures, this.#evaluationInput(profile, revision), signal);
  }

  #evaluationInput(profile: BusinessEvaluationExecutionProfile, revision: MapRevision): z.infer<typeof businessEvaluationInputSchema> {
    const inputIdentity = {
      workspaceSnapshotDigest: revision.digest,
      principalAccessDigest: sha(this.#dependencies.principal.access),
      requestSetDigest: sha(profile.scenarios),
      policyDigest: sha({ profileVersion: profile.version, semantics: "server-owned-v0-v5/v1" }),
      selectionPolicyVersion: CONTEXT_SELECTION_POLICY_VERSION,
      cachePolicyDigest: sha(CONTEXT_BUILD_CACHE_POLICY_VERSION),
      cachePolicyVersion: CONTEXT_BUILD_CACHE_POLICY_VERSION,
      projectionPolicyVersion: DOCUMENT_PROJECTION_POLICY_VERSION,
      budgetProfileDigest: sha(profile.scenarios.map(scenario => scenario.context.budgetProfile ?? "default")),
      baselineIdentityDigest: profile.baselineIdentityDigest,
      executionEnvironmentDigest: profile.executionEnvironmentDigest,
      measurementWindowDigest: profile.measurementWindowDigest,
      modelIdentityDigest: profile.taskSuccess?.modelIdentityDigest ?? null,
      judgeRubricDigest: profile.taskSuccess?.judgeRubricDigest ?? null,
      judgeIdentityClass: profile.taskSuccess?.judgeIdentityClass ?? null,
    };
    return businessEvaluationInputSchema.parse({
      workspaceId: profile.workspaceId,
      phase: profile.phase,
      repetitions: profile.repetitions,
      blindSeedDigest: profile.blindSeedDigest,
      inputIdentity,
      gatePolicy: profile.gatePolicy,
    });
  }

  #executor(
    profile: BusinessEvaluationExecutionProfile,
    revision: MapRevision,
    contextBuilder: ContextBuilder,
    capture?: (job: PreparedTaskSuccessJob) => void,
  ) {
    const scenarios = new Map(profile.scenarios.map(scenario => [scenario.scenarioId, scenario]));
    return async (request: BusinessVariantExecutionRequest): Promise<BusinessVariantObservation> => {
      const scenario = scenarios.get(request.scenario.id)!;
      const started = performance.now();
      const materialized = await this.#executeVariant(profile, scenario, request.variant, request.repeatIndex, revision, contextBuilder, request.signal);
      const selectedIds = new Set(materialized.documents.map(document => document.documentId));
      const gold = new Set(scenario.goldDocumentIds);
      const mandatoryRecall = scenario.mandatoryDocumentIds.filter(id => selectedIds.has(id)).length / scenario.mandatoryDocumentIds.length;
      const selectedGold = materialized.documents.filter(document => gold.has(document.documentId));
      const totalInputTokens = materialized.documents.reduce((sum, document) => sum + document.tokenEstimate, 0);
      const goldTokens = selectedGold.reduce((sum, document) => sum + document.tokenEstimate, 0);
      const corpus = materialized.documents.map(document => document.body).join("\n").toLocaleLowerCase("ru-RU");
      const retrievedClaimIds = scenario.goldClaims
        .filter(claim => claim.allTerms.every(term => corpus.includes(term.toLocaleLowerCase("ru-RU"))))
        .map(claim => claim.id);
      const unauthorizedDisclosureCount = scenario.forbiddenMarkers.filter(marker => corpus.includes(marker.toLocaleLowerCase("ru-RU"))).length;
      const observation: BusinessVariantObservation = {
        resultDigest: materialized.resultDigest,
        selectorTraceDigest: sha({ profileId: profile.id, scenarioId: scenario.scenarioId, variant: request.variant, request: scenario.context }),
        selectedDocuments: materialized.documents.map(document => ({ documentId: document.documentId, tokenEstimate: document.tokenEstimate })),
        retrievedClaimIds,
        totalInputTokens,
        taskSucceeded: mandatoryRecall === 1 && unauthorizedDisclosureCount === 0,
        totalCostMicrounits: totalInputTokens,
        unauthorizedDisclosureCount,
        errorCode: null,
        cache: materialized.cache,
        latencyMs: { total: Number((performance.now() - started).toFixed(3)) },
        fallback: { availableModes: ["direct-search", "explicit-documents", "bounded-resource-read", "explainable-preview"] },
        rawMetrics: {
          mandatoryRecall,
          precision: materialized.documents.length === 0 ? 0 : selectedGold.length / materialized.documents.length,
          relevantTokenRatio: totalInputTokens === 0 ? 0 : goldTokens / totalInputTokens,
          firstAttemptSucceeded: mandatoryRecall === 1,
          explicitLinkResolutionRate: request.variant === "V5" ? selectedGold.length / scenario.goldDocumentIds.length : 1,
          stableErrorClassificationRate: 1,
          omissionCount: materialized.omissionCount,
          outputTokens: 0,
          toolTokens: 0,
        },
      };
      capture?.({
        scenarioId: scenario.scenarioId,
        variant: request.variant,
        repeatIndex: request.repeatIndex,
        blindLabel: request.blindLabel,
        prompt: scenario.context.goal,
        contextDocuments: materialized.documents.map(document => ({ documentId: document.documentId, content: document.body })),
        retrievalObservation: observation,
      });
      return observation;
    };
  }

  async #executeVariant(
    profile: BusinessEvaluationExecutionProfile,
    scenario: BusinessEvaluationExecutionProfile["scenarios"][number],
    variant: BusinessVariant,
    repeatIndex: number,
    revision: MapRevision,
    contextBuilder: ContextBuilder,
    signal?: AbortSignal,
  ): Promise<{ documents: MaterializedEvaluationDocument[]; resultDigest: `sha256:${string}`; cache: BusinessVariantObservation["cache"]; omissionCount: number }> {
    if (variant === "V0") {
      const readablePaths = new Set(revision.documents.filter(document => this.#readable(revision, document)).map(document => document.relativePath));
      const direct = await runDirectSearchBaseline(this.#dependencies.files, {
        workspaceId: profile.workspaceId,
        queryTerms: scenario.directSearch.queryTerms,
        allowedPathPrefixes: scenario.directSearch.allowedPathPrefixes,
        ...(scenario.directSearch.includeExtensions === undefined ? {} : { includeExtensions: scenario.directSearch.includeExtensions }),
        claimChecks: scenario.goldClaims,
        authorizePath: path => readablePaths.has(path),
      }, signal);
      const documents = await Promise.all(direct.selectedDocuments.map(async selected => {
        const file = await this.#dependencies.files.read(profile.workspaceId, selected.path, signal);
        return { documentId: selected.documentId, checksum: selected.checksum, tokenEstimate: selected.tokenEstimate, body: new TextDecoder().decode(file.content) };
      }));
      return { documents, resultDigest: direct.resultDigest as `sha256:${string}`, cache: { state: "bypass", policyVersion: "direct-search-no-cache/v1" }, omissionCount: 0 };
    }
    if (variant === "V1") {
      const documents = await this.#materializeDocumentIds(profile.workspaceId, revision, scenario.goldDocumentIds, signal);
      return { documents, resultDigest: sha(documents.map(document => ({ id: document.documentId, checksum: document.checksum }))), cache: { state: "bypass", policyVersion: "structured-manual-no-cache/v1" }, omissionCount: 0 };
    }
    const bootstrap = await this.#dependencies.domainLanguage.createBootstrap({
      anchor: { workspaceId: profile.workspaceId, projectId: scenario.context.projectId },
      roleId: scenario.context.roleId,
    }, this.#dependencies.principal, signal);
    const baseRequest = this.#contextRequest(profile, scenario, repeatIndex, bootstrap.bootstrapId);
    if (variant === "V2") {
      const path = await this.#dependencies.scopePathResolver.resolve(baseRequest, this.#dependencies.principal, signal);
      const scopes = new Set([...path.scopeIds, ...path.affectedScopeIds]);
      const ids = revision.documents.filter(document => scopes.has(document.scopeId) && active(document) && document.contextPolicy !== "explicit-only").map(document => document.documentId);
      const documents = await this.#materializeDocumentIds(profile.workspaceId, revision, ids, signal);
      return { documents, resultDigest: sha({ path: path.resolverTrace, documents: documents.map(document => document.checksum) }), cache: { state: "bypass", policyVersion: "scope-map-no-bundle/v1" }, omissionCount: 0 };
    }
    const guidedExactScopes = scenario.guided?.exactScopeIds ?? baseRequest.exactScopeIds;
    const buildRequest: BuildTaskContextRequest = variant === "V5"
      ? {
          ...baseRequest,
          ...(guidedExactScopes === undefined ? {} : { exactScopeIds: guidedExactScopes }),
          explicitDocuments: (scenario.guided?.explicitDocuments ?? scenario.goldDocumentIds.map(documentId => ({ selector: "document-id", documentId } as const))) as readonly ExplicitDocumentReference[],
        }
      : baseRequest;
    const bundle = await contextBuilder.build(buildRequest, this.#dependencies.principal, signal);
    const documents = bundle.selectedDocuments.map(document => this.#fromSelected(document));
    return {
      documents,
      resultDigest: sha({
        documents: documents.map(document => ({ documentId: document.documentId, checksum: document.checksum, tokenEstimate: document.tokenEstimate, contentDigest: sha(document.body) })),
        omissions: bundle.omissions,
        primaryTargetScope: bundle.primaryTargetScope,
        affectedScopes: bundle.affectedScopes,
      }),
      cache: { state: bundle.cache.state, policyVersion: bundle.cache.policyVersion, keyDigest: bundle.cache.keyDigest as `sha256:${string}` },
      omissionCount: bundle.omissions.length,
    };
  }

  #contextRequest(
    profile: BusinessEvaluationExecutionProfile,
    scenario: BusinessEvaluationExecutionProfile["scenarios"][number],
    repeatIndex: number,
    bootstrapId: string,
  ): BuildTaskContextRequest {
    const context = scenario.context;
    return {
      domainLanguageBootstrapId: bootstrapId,
      roleId: context.roleId,
      taskType: context.taskType,
      goal: context.goal,
      ...(context.canonicalDomains === undefined ? {} : { canonicalDomains: context.canonicalDomains }),
      ...(context.canonicalTerms === undefined ? {} : { canonicalTerms: context.canonicalTerms }),
      ...(context.keywords === undefined ? {} : { keywords: context.keywords }),
      ...(context.targetHints === undefined ? {} : { targetHints: context.targetHints }),
      ...(context.exactScopeIds === undefined ? {} : { exactScopeIds: context.exactScopeIds }),
      ...(context.explicitLinks === undefined ? {} : { explicitLinks: context.explicitLinks }),
      ...(context.artifacts === undefined ? {} : { artifacts: context.artifacts }),
      ...(context.repositoryPaths === undefined ? {} : { repositoryPaths: context.repositoryPaths }),
      ...(context.budgetProfile === undefined ? {} : { budgetProfile: context.budgetProfile }),
      ...(context.requestedSkillIds === undefined ? {} : { requestedSkillIds: context.requestedSkillIds }),
      ...(context.explicitDocuments === undefined ? {} : { explicitDocuments: context.explicitDocuments as readonly ExplicitDocumentReference[] }),
      execution: {
        planId: "BUSINESS-EVAL",
        runId: profile.id,
        assignmentId: `${scenario.scenarioId}-${repeatIndex}-${profile.measurementWindowDigest.slice(-12)}`,
      },
    };
  }

  #readable(revision: MapRevision, document: DocumentRecord): boolean {
    const node = revision.nodes.find(candidate => candidate.scopeId === document.scopeId);
    return node !== undefined && active(document) && canReadDocument(this.#dependencies.principal, node);
  }

  async #materializeDocumentIds(workspaceId: string, revision: MapRevision, ids: readonly string[], signal?: AbortSignal): Promise<MaterializedEvaluationDocument[]> {
    const documents: MaterializedEvaluationDocument[] = [];
    for (const documentId of [...new Set(ids)].sort()) {
      const record = revision.documents.find(document => document.documentId === documentId);
      if (record === undefined || !this.#readable(revision, record)) continue;
      const file = await this.#dependencies.files.read(workspaceId, record.relativePath, signal);
      if (file.entry.checksum !== record.checksum) throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_STALE", `Document '${documentId}' changed after map publication.`);
      const body = new TextDecoder().decode(file.content);
      documents.push({ documentId, checksum: record.checksum, tokenEstimate: tokens(body), body });
    }
    return documents;
  }

  #fromSelected(document: SelectedContextDocument): MaterializedEvaluationDocument {
    return {
      documentId: document.documentId,
      checksum: document.checksum,
      tokenEstimate: document.tokenEstimate,
      body: document.projection.content ?? "",
    };
  }
}
