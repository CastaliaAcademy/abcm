import { z } from "zod/v4";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const nonEmptyId = z.string().min(1).max(256);

export const contextEfficiencyPriorityOrder = [
  "task_relevance",
  "fallback_flexibility",
  "determinism",
  "workspace_isolation",
  "context_efficiency",
] as const;

const fallbackModeSchema = z.enum(["direct-search", "explicit-documents", "bounded-resource-read", "explainable-preview"]);

const scenarioSchema = z.object({
  id: nonEmptyId,
  goldDocumentIds: z.array(nonEmptyId).min(1),
  mandatoryDocumentIds: z.array(nonEmptyId).min(1),
  goldClaimIds: z.array(nonEmptyId).optional(),
  hiddenDocumentIds: z.array(nonEmptyId).optional(),
}).strict().superRefine((scenario, context) => {
  const gold = new Set(scenario.goldDocumentIds);
  if (gold.size !== scenario.goldDocumentIds.length) context.addIssue({ code: "custom", path: ["goldDocumentIds"], message: "Gold document ids must be unique." });
  if (new Set(scenario.mandatoryDocumentIds).size !== scenario.mandatoryDocumentIds.length) context.addIssue({ code: "custom", path: ["mandatoryDocumentIds"], message: "Mandatory document ids must be unique." });
  if (new Set(scenario.goldClaimIds ?? []).size !== (scenario.goldClaimIds ?? []).length) context.addIssue({ code: "custom", path: ["goldClaimIds"], message: "Gold claim ids must be unique." });
  if (scenario.mandatoryDocumentIds.some(id => !gold.has(id))) context.addIssue({ code: "custom", path: ["mandatoryDocumentIds"], message: "Mandatory documents must belong to the gold set." });
  if ((scenario.hiddenDocumentIds ?? []).some(id => gold.has(id))) context.addIssue({ code: "custom", path: ["hiddenDocumentIds"], message: "Hidden documents cannot belong to the visible gold set." });
});

export const contextEfficiencyManifestSchema = z.object({
  schemaVersion: z.literal("abcm.eval.context-efficiency/v1"),
  id: nonEmptyId,
  language: z.string().min(2).max(64),
  priorityOrder: z.tuple(contextEfficiencyPriorityOrder.map(value => z.literal(value)) as [
    z.ZodLiteral<"task_relevance">,
    z.ZodLiteral<"fallback_flexibility">,
    z.ZodLiteral<"determinism">,
    z.ZodLiteral<"workspace_isolation">,
    z.ZodLiteral<"context_efficiency">,
  ]),
  variants: z.record(nonEmptyId, z.object({ mode: z.enum(["direct-search", "context-bundle", "context-bundle-with-fallback"]) }).strict()),
  gates: z.object({
    taskRelevance: z.object({
      mandatoryRecallVsDirect: z.literal("gte"),
      precisionVsDirect: z.literal("gte"),
      taskSuccessRateMaxDegradation: z.number().min(0).max(1),
    }).strict(),
    fallbackFlexibility: z.object({
      requiredModes: z.array(fallbackModeSchema).min(1),
      preservePrimaryFailure: z.literal(true),
    }).strict(),
    determinism: z.object({ identicalResultRate: z.literal(1) }).strict(),
    workspaceIsolation: z.object({ unauthorizedDisclosureMax: z.literal(0) }).strict(),
    contextEfficiency: z.object({
      medianTokenReductionMin: z.number().min(0).max(1),
      costPerSuccessfulTaskReductionMin: z.number().min(0).max(1),
      evaluateOnlySuccessfulTasks: z.literal(true),
    }).strict(),
  }).strict(),
  scenarios: z.array(scenarioSchema).min(1),
}).strict().superRefine((manifest, context) => {
  const scenarioIds = manifest.scenarios.map(scenario => scenario.id);
  if (new Set(scenarioIds).size !== scenarioIds.length) context.addIssue({ code: "custom", path: ["scenarios"], message: "Scenario ids must be unique." });
  if (manifest.variants.direct?.mode !== "direct-search") context.addIssue({ code: "custom", path: ["variants", "direct"], message: "The direct variant is required and must use direct-search mode." });
});

export const retrievalRunReceiptSchema = z.object({
  schemaVersion: z.literal("abcm.eval.retrieval-run/v1"),
  scenarioId: nonEmptyId,
  variant: nonEmptyId,
  runId: nonEmptyId,
  inputIdentity: z.object({
    workspaceSnapshotDigest: digest,
    principalAccessDigest: digest,
    requestDigest: digest,
    policyDigest: digest,
  }).strict(),
  selectedDocuments: z.array(z.object({
    documentId: nonEmptyId,
    tokenEstimate: z.number().int().nonnegative(),
  }).strict()),
  retrievedClaimIds: z.array(nonEmptyId).default([]),
  totalInputTokens: z.number().int().nonnegative(),
  taskSucceeded: z.boolean(),
  totalCost: z.number().nonnegative(),
  repeatedResultDigests: z.array(digest).min(1),
  unauthorizedDisclosureCount: z.number().int().nonnegative(),
  fallback: z.object({
    availableModes: z.array(fallbackModeSchema),
    usedMode: fallbackModeSchema.optional(),
    recoveredDocumentIds: z.array(nonEmptyId).optional(),
    recoveredClaimIds: z.array(nonEmptyId).optional(),
    addedTokens: z.number().int().nonnegative().optional(),
  }).strict(),
}).strict().superRefine((receipt, context) => {
  const selected = receipt.selectedDocuments.map(document => document.documentId);
  if (new Set(selected).size !== selected.length) context.addIssue({ code: "custom", path: ["selectedDocuments"], message: "Selected document ids must be unique." });
  if (new Set(receipt.retrievedClaimIds).size !== receipt.retrievedClaimIds.length) context.addIssue({ code: "custom", path: ["retrievedClaimIds"], message: "Retrieved claim ids must be unique." });
  if (receipt.fallback.usedMode !== undefined && !receipt.fallback.availableModes.includes(receipt.fallback.usedMode)) {
    context.addIssue({ code: "custom", path: ["fallback", "usedMode"], message: "Used fallback mode must be advertised as available." });
  }
  if (receipt.fallback.usedMode === undefined && ((receipt.fallback.recoveredDocumentIds?.length ?? 0) > 0 || (receipt.fallback.recoveredClaimIds?.length ?? 0) > 0 || (receipt.fallback.addedTokens ?? 0) > 0)) {
    context.addIssue({ code: "custom", path: ["fallback"], message: "Fallback recovery requires a used mode." });
  }
});

export type ContextEfficiencyManifest = z.infer<typeof contextEfficiencyManifestSchema>;
export type RetrievalRunReceipt = z.infer<typeof retrievalRunReceiptSchema>;
export type ContextEfficiencyFallbackMode = z.infer<typeof fallbackModeSchema>;
