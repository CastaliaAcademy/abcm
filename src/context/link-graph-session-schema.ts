import { z } from "zod/v4";

import { buildTaskContextSchema } from "./schema.js";

const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const sessionId = z.string().regex(/^graph-session-[a-f0-9]{24}$/);
const documentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const documentIds = z.array(documentId).max(256);
const edgeType = z.enum(["wiki-link", "embed", "heading-reference", "block-reference", "domain-relation", "tag", "backlink"]);
const selectionReason = z.enum([
  "required_applicable",
  "operator_controlled_applicable",
  "role_required",
  "task_type_required",
  "explicit_link",
  "path_exact",
  "path_prefix",
  "skill_required",
  "link_package_optional",
  "target_scope",
  "related_scope",
  "domain_or_entity_match",
  "semantic_or_keyword_match",
  "optional_background",
]);

export const contextLinkGraphStartInputSchema = z.object({
  workspaceId: z.string().min(1),
  request: buildTaskContextSchema,
  seedDocumentIds: documentIds.optional(),
}).strict();

export const contextLinkGraphCandidateSchema = z.object({
  documentId,
  kind: z.string().min(1),
  title: z.string().min(1),
  scopeId: z.string().min(1),
  relativePath: z.string().min(1),
  checksum,
  tokenForecast: z.number().int().positive(),
  via: z.array(z.object({
    edgeId: z.string().min(1),
    edgeType,
    fromDocumentId: documentId,
  }).strict()),
}).strict();

export const contextLinkGraphSessionOutputSchema = z.object({
  sessionId,
  status: z.enum(["active", "cancelled"]),
  sequence: z.number().int().nonnegative(),
  stateDigest: checksum,
  workspaceId: z.string().min(1),
  principalId: z.string().min(1),
  mapRevision: checksum,
  mapDigest: checksum,
  linkGraphDigest: checksum,
  linkGraphPolicyVersion: z.literal("v1"),
  selectionPolicyVersion: z.literal("context-selection/v4"),
  seedDocumentIds: documentIds,
  confirmedDocumentIds: documentIds,
  candidates: z.array(contextLinkGraphCandidateSchema),
  projectedTokenEstimate: z.number().int().nonnegative(),
  lastStep: z.object({
    sequence: z.number().int().positive(),
    requestDigest: checksum,
    previousStateDigest: checksum,
    resultDigest: checksum,
    projectedTokenDelta: z.number().int(),
  }).strict().optional(),
  fallbackModes: z.tuple([z.literal("direct-search"), z.literal("explicit-documents"), z.literal("bounded-resource-read")]),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  websocket: z.object({
    path: z.literal("/v1/context/link-graph/ws"),
    protocols: z.tuple([
      z.literal("abcm.link-graph.v1"),
      z.string().regex(/^abcm\.session\.graph-session-[a-f0-9]{24}$/),
      z.string().regex(/^abcm\.ticket\.[A-Za-z0-9_-]{32,}$/),
    ]),
    ticketExpiresAt: z.iso.datetime(),
  }).strict().optional(),
}).strict();

export const contextLinkGraphStepOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expand"), fromDocumentIds: documentIds.min(1), edgeTypes: z.array(edgeType).min(1).optional() }).strict(),
  z.object({ kind: z.literal("narrow"), documentIds }).strict(),
  z.object({ kind: z.literal("confirm"), documentIds: documentIds.min(1) }).strict(),
  z.object({ kind: z.literal("undo") }).strict(),
  z.object({ kind: z.literal("cancel") }).strict(),
]);

export const contextLinkGraphStepInputSchema = z.object({
  sessionId,
  sequence: z.number().int().positive(),
  previousStateDigest: checksum,
  operation: contextLinkGraphStepOperationSchema,
}).strict();

export const contextLinkGraphGetInputSchema = z.object({ sessionId }).strict();
export const contextLinkGraphFinalizeInputSchema = z.object({ sessionId, expectedStateDigest: checksum }).strict();
export const contextLinkGraphRetrievalReceiptSchema = z.object({
  receiptId: z.string().regex(/^graph-receipt-[a-f0-9]{24}$/),
  receiptDigest: checksum,
  sessionId,
  workspaceId: z.string().min(1),
  principalId: z.string().min(1),
  mapRevision: checksum,
  mapDigest: checksum,
  linkGraphDigest: checksum,
  linkGraphPolicyVersion: z.literal("v1"),
  selectionPolicyVersion: z.literal("context-selection/v4"),
  sequence: z.number().int().nonnegative(),
  stateDigest: checksum,
  confirmedDocumentIds: documentIds,
  selections: z.array(z.object({
    documentId,
    selectionReasons: z.array(selectionReason).min(1),
  }).strict()),
  projectedTokenEstimate: z.number().int().nonnegative(),
  contextBundleTokenEstimate: z.number().int().nonnegative(),
  steps: z.array(z.object({
    sequence: z.number().int().positive(),
    requestDigest: checksum,
    previousStateDigest: checksum,
    resultDigest: checksum,
    projectedTokenDelta: z.number().int(),
  }).strict()),
  contextBundleId: z.string().min(1),
  bundleDigest: checksum,
  createdAt: z.iso.datetime(),
}).strict();

export const restContextLinkGraphStepInputSchema = contextLinkGraphStepInputSchema.omit({ sessionId: true });
export const restContextLinkGraphFinalizeInputSchema = contextLinkGraphFinalizeInputSchema.omit({ sessionId: true });

export const contextLinkGraphWebSocketStepSchema = restContextLinkGraphStepInputSchema.extend({
  requestId: z.string().min(1).max(128),
}).strict();
