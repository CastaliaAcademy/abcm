import { z } from "zod/v4";

import { ABCM_AGENT_INSTRUCTIONS_VERSION } from "../agent-instructions/agent-instructions.js";
import {
  architectureComplianceSchema,
  architecturePolicyInputSchema,
  architecturePolicyRecordSchema,
  architecturePolicyResolutionSchema,
  architecturePolicyTargetSchema,
} from "../architecture/architecture-policy-service.js";
import { buildTaskContextSchema } from "../context/schema.js";
import {
  contextLinkPackageBuildInputSchema,
  contextLinkPackageGetInputSchema,
  contextLinkPackageListInputSchema,
  contextLinkPackageListOutputSchema,
  contextLinkPackageMemberDispositionSchema,
  contextLinkPackageViewSchema,
} from "../context/link-package-schema.js";
import {
  artifactAmendmentAcceptInputSchema,
  artifactAmendmentPreviewInputSchema,
  artifactAmendmentPreviewOutputSchema,
  artifactAmendmentReceiptSchema,
  artifactLineageGetInputSchema,
  artifactLineageOutputSchema,
} from "../artifacts/amendment-schema.js";
export {
  contextLinkPackageBuildInputSchema,
  contextLinkPackageGetInputSchema,
  contextLinkPackageListInputSchema,
  contextLinkPackageListOutputSchema,
  contextLinkPackageViewSchema,
} from "../context/link-package-schema.js";
export {
  artifactAmendmentAcceptInputSchema,
  artifactAmendmentPreviewInputSchema,
  artifactAmendmentPreviewOutputSchema,
  artifactAmendmentReceiptSchema,
  artifactLineageGetInputSchema,
  artifactLineageOutputSchema,
} from "../artifacts/amendment-schema.js";
import {
  contextLinkGraphFinalizeInputSchema,
  contextLinkGraphGetInputSchema,
  contextLinkGraphSessionOutputSchema,
  contextLinkGraphRetrievalReceiptSchema,
  contextLinkGraphStartInputSchema,
  contextLinkGraphStepInputSchema,
} from "../context/link-graph-session-schema.js";
export {
  contextLinkGraphFinalizeInputSchema,
  contextLinkGraphGetInputSchema,
  contextLinkGraphSessionOutputSchema,
  contextLinkGraphRetrievalReceiptSchema,
  contextLinkGraphStartInputSchema,
  contextLinkGraphStepInputSchema,
} from "../context/link-graph-session-schema.js";
import { projectLanguageTagSchema } from "../core/project-language.js";
import {
  workspaceBatchApplyInputSchema,
  workspaceBatchApplyOutputSchema,
  workspaceUploadAbortInputSchema,
  workspaceUploadAbortOutputSchema,
  workspaceUploadChunkInputSchema,
  workspaceUploadChunkOutputSchema,
  workspaceUploadCompleteInputSchema,
  workspaceUploadCompleteOutputSchema,
  workspaceUploadStartInputSchema,
  workspaceUploadStartOutputSchema,
} from "../workspace/file-operation-contracts.js";

export const toolErrorOutputSchema = z.object({
  error_code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
}).strict();

export function toolOutputSchema<T extends z.ZodType>(successSchema: T) {
  return z.union([successSchema, toolErrorOutputSchema]);
}

export const agentInstructionsInputSchema = z.object({}).strict();
export const agentInstructionsOutputSchema = z.object({
  version: z.literal(ABCM_AGENT_INSTRUCTIONS_VERSION),
  contentType: z.literal("text/markdown; charset=utf-8"),
  checksum: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  content: z.string().min(1),
}).strict();

const workspaceId = z.string().min(1);
const path = z.string();
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const workspaceCreateInputSchema = z.object({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  name: z.string().min(1).max(160).optional(),
  language: projectLanguageTagSchema,
}).strict();
export const workspaceCreateOutputSchema = z.object({ id: z.string() }).strict();

export const workspaceGetArchitecturePolicyInputSchema = architecturePolicyTargetSchema;
export const workspaceGetArchitecturePolicyOutputSchema = architecturePolicyResolutionSchema;
export const workspaceSetArchitecturePolicyInputSchema = architecturePolicyTargetSchema.extend({
  enforcement: architecturePolicyInputSchema.shape.enforcement,
  architecture: architecturePolicyInputSchema.shape.architecture,
  ifMatch: checksum.optional(),
  ifNoneMatch: z.literal("*").optional(),
}).strict();
export const workspaceSetArchitecturePolicyOutputSchema = architecturePolicyRecordSchema;
export const workspaceDeleteArchitecturePolicyInputSchema = architecturePolicyTargetSchema.extend({ ifMatch: checksum.optional() }).strict();
export const workspaceDeleteArchitecturePolicyOutputSchema = z.object({ deleted: z.literal(true) }).strict();
export const workspaceListArchitecturePoliciesInputSchema = z.object({ workspaceId }).strict();
export const workspaceListArchitecturePoliciesOutputSchema = z.object({ policies: z.array(architecturePolicyRecordSchema) }).strict();
export const workspaceCheckArchitectureComplianceInputSchema = architecturePolicyTargetSchema;
export const workspaceCheckArchitectureComplianceOutputSchema = architectureComplianceSchema;

export const fileEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: z.enum(["file", "directory"]),
  size: z.number().nonnegative(),
  modifiedAt: z.string(),
  checksum: checksum.optional(),
}).strict();

export const workspaceListFilesInputSchema = z.object({
  workspaceId,
  path: path.default(""),
  recursive: z.boolean().default(false),
}).strict();
export const workspaceListFilesOutputSchema = z.object({ entries: z.array(fileEntrySchema) }).strict();

export const workspaceReadFileInputSchema = z.object({ workspaceId, path: path.min(1) }).strict();
export const workspaceReadFileOutputSchema = z.object({
  entry: fileEntrySchema.extend({ checksum }),
  contentType: z.string().min(1),
  encoding: z.literal("base64"),
  content: z.string(),
}).strict();

export const workspaceWriteFileInputSchema = z.object({
  workspaceId,
  path: path.min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  ifMatch: z.string().optional(),
  ifNoneMatch: z.literal("*").optional(),
}).strict();
export const workspaceWriteFileOutputSchema = z.object({ entry: fileEntrySchema.extend({ checksum }) }).strict();

export const workspaceDeleteFileInputSchema = z.object({ workspaceId, path: path.min(1), ifMatch: z.string().optional() }).strict();
export const workspaceDeleteFileOutputSchema = z.object({ deleted: z.literal(true) }).strict();

export const workspaceMoveFileInputSchema = z.object({
  workspaceId,
  from: path.min(1),
  to: path.min(1),
  overwrite: z.boolean().default(false),
  ifMatch: z.string().optional(),
}).strict();
export const workspaceMoveFileOutputSchema = workspaceWriteFileOutputSchema;

export const workspaceCreateDirectoryInputSchema = z.object({ workspaceId, path: path.min(1) }).strict();
export const workspaceCreateDirectoryOutputSchema = z.object({ entry: fileEntrySchema }).strict();

export const workspaceDeleteDirectoryInputSchema = z.object({
  workspaceId,
  path: path.min(1),
  recursive: z.literal(true),
}).strict();
export const workspaceDeleteDirectoryOutputSchema = z.object({ deleted: z.literal(true) }).strict();

export const workspaceMoveDirectoryInputSchema = z.object({
  workspaceId,
  from: path.min(1),
  to: path.min(1),
}).strict();
export const workspaceMoveDirectoryOutputSchema = workspaceCreateDirectoryOutputSchema;

const scopeNodeSchema = z.object({
  scopeId: z.string(),
  kind: z.enum(["workflow", "project", "service", "feature"]),
  name: z.string(),
  aliases: z.array(z.string()),
  relativePath: z.string(),
  parentScopeId: z.string().optional(),
  rank: z.number().int().nonnegative(),
  status: z.enum(["valid", "invalid"]),
  readiness: z.enum(["ready", "warning"]),
}).strict();
const mapDiagnosticSchema = z.object({
  code: z.string(),
  severity: z.enum(["branch_error", "scope_error", "warning"]),
  path: z.string(),
  message: z.string(),
  scopeId: z.string().optional(),
}).strict();
export const scopeMapScanInputSchema = z.object({ workspaceId }).strict();
export const scopeMapScanOutputSchema = z.object({
  revision: z.object({
    revision: checksum,
    digest: checksum,
    createdAt: z.string(),
    nodes: z.array(scopeNodeSchema),
    relations: z.array(z.object({
      fromId: z.string(),
      toId: z.string(),
      relationType: z.string(),
      source: z.string(),
      status: z.enum(["resolved", "unresolved_optional", "unresolved_required"]),
    }).strict()),
    diagnostics: z.array(mapDiagnosticSchema),
    resourceSummary: z.object({
      indexedFiles: z.number().int().nonnegative(),
      documents: z.number().int().nonnegative(),
      executableResources: z.number().int().nonnegative(),
    }).strict(),
    linkGraphSummary: z.object({
      policyVersion: z.literal("v1"),
      digest: checksum,
      nodes: z.number().int().nonnegative(),
      edges: z.number().int().nonnegative(),
      resolved: z.number().int().nonnegative(),
      broken: z.number().int().nonnegative(),
      ambiguous: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
}).strict();

export const domainLanguageInputSchema = z.object({
  anchor: z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1) }).strict(),
  roleId: z.string().min(1).optional(),
  projection: z.literal("agent").optional(),
}).strict();
export const domainLanguageOutputSchema = z.object({
  bootstrapId: z.string(),
  bootstrapDigest: checksum,
  anchor: z.object({ workspaceId: z.string(), projectId: z.string() }).strict(),
  roleId: z.string().optional(),
  projection: z.literal("agent"),
  mapRevision: checksum,
  sourceConventions: z.array(z.object({ scopeId: z.string(), relativePath: z.string(), checksum }).strict()),
  effectiveLanguage: z.object({
    domains: z.array(z.unknown()),
    concepts: z.array(z.unknown()),
    aliases: z.array(z.unknown()),
    homonyms: z.array(z.unknown()),
    namingRules: z.record(z.string(), z.string()),
  }).strict(),
  readiness: z.literal("ready"),
  createdAt: z.string(),
  expiresAt: z.string(),
}).strict();

const affectedScopeDetailSchema = z.object({
  scopeId: z.string(),
  origin: z.enum(["primary", "explicit", "relation"]),
  depth: z.number().int().nonnegative(),
  viaScopeId: z.string().optional(),
  relationType: z.string().optional(),
}).strict();
const contextBudgetAllocationSchema = z.object({
  bucketId: z.string(),
  requestedTokens: z.number().int().nonnegative(),
  reservedTokens: z.number().int().nonnegative(),
  consumedTokens: z.number().int().nonnegative(),
  selectedTokens: z.number().int().nonnegative(),
  omittedTokens: z.number().int().nonnegative(),
}).strict();

export const contextBuildInputSchema = buildTaskContextSchema;
const contextBuildCacheMetadataSchema = z.object({
  state: z.enum(["hit", "miss", "stale"]),
  policyVersion: z.literal("context-build-cache/v1"),
  projectionPolicyVersion: z.literal("document-projection/v1"),
  keyDigest: checksum,
  workspaceSnapshotDigest: checksum,
  principalAccessDigest: checksum,
}).strict();
const contextSelectionStageSchema = z.enum(["mandatory", "relevant", "background_fallback"]);
const contextOmissionSchema = z.object({
  documentId: z.string(),
  reason: z.enum(["access_denied", "budget_exceeded", "lifecycle_excluded", "selector_mismatch"]),
  selectionStage: contextSelectionStageSchema,
  selectionReasons: z.array(z.string()),
}).strict();
export const contextBuildOutputSchema = z.object({
  contextBundleId: z.string(),
  bundleDigest: checksum,
  mapRevision: checksum,
  mapDigest: checksum,
  domainLanguageBootstrapId: z.string(),
  domainLanguageBootstrapDigest: checksum,
  roleId: z.string(),
  taskType: z.string(),
  budgetProfile: z.string(),
  contextMode: z.enum(["focused", "balanced"]),
  budget: z.object({ softLimitTokens: z.number().int().nonnegative(), hardLimitTokens: z.number().int().positive() }).strict(),
  primaryTargetScope: z.string(),
  affectedScopes: z.array(z.string()),
  affectedScopeDetails: z.array(affectedScopeDetailSchema),
  multiScopePolicyDigest: checksum,
  budgetAllocation: z.array(contextBudgetAllocationSchema),
  resolvedScopePath: z.record(z.string(), z.unknown()),
  skillConnectionReasons: z.record(z.string(), z.array(z.string())),
  connectedSkills: z.array(z.unknown()),
  selectedDocuments: z.array(z.unknown()),
  selectionReasons: z.record(z.string(), z.array(z.string())),
  warnings: z.array(z.object({ code: z.string(), subjectId: z.string().optional() }).strict()),
  conflicts: z.array(z.never()),
  omissions: z.array(contextOmissionSchema),
  tokenEstimate: z.number().int().nonnegative(),
  contextFingerprintLocation: z.string(),
  cache: contextBuildCacheMetadataSchema,
}).strict();
export const contextLinkGraphFinalizeOutputSchema = z.object({
  bundle: contextBuildOutputSchema,
  receipt: contextLinkGraphRetrievalReceiptSchema,
}).strict();
export const contextLinkPackageBuildOutputSchema = z.object({
  bundle: contextBuildOutputSchema,
  package: contextLinkPackageViewSchema,
  members: z.array(contextLinkPackageMemberDispositionSchema),
}).strict();

const contextPreviewDocumentSchema = z.object({
  documentId: z.string(),
  scopeId: z.string(),
  relativePath: z.string(),
  checksum,
  mandatory: z.boolean(),
  selectionStage: contextSelectionStageSchema,
  effectivePriority: z.number().int().nonnegative(),
  selectionReasons: z.array(z.string()),
  projection: z.object({
    mode: z.enum(["full", "section", "summary", "metadata", "reference"]),
    authoritative: z.boolean(),
    sourceDocumentId: z.string(),
    sourceChecksum: checksum,
  }).strict(),
  tokenEstimate: z.number().int().nonnegative(),
}).strict();
export const contextPreviewOutputSchema = z.object({
  previewDigest: checksum,
  selectionPolicyVersion: z.literal("context-selection/v4"),
  workspaceId: z.string().min(1),
  mapRevision: checksum,
  mapDigest: checksum,
  primaryTargetScope: z.string(),
  affectedScopes: z.array(z.string()),
  contextMode: z.enum(["focused", "balanced"]),
  budgetProfile: z.string(),
  budget: z.object({ softLimitTokens: z.number().int().nonnegative(), hardLimitTokens: z.number().int().positive() }).strict(),
  budgetAllocation: z.array(contextBudgetAllocationSchema),
  selectedDocuments: z.array(contextPreviewDocumentSchema),
  omissions: z.array(contextOmissionSchema),
  warnings: z.array(z.object({ code: z.string(), subjectId: z.string().optional() }).strict()),
  tokenEstimate: z.number().int().nonnegative(),
  fallbackModes: z.tuple([z.literal("direct-search"), z.literal("explicit-documents"), z.literal("bounded-resource-read")]),
  cache: contextBuildCacheMetadataSchema,
}).strict();

const documentationOperationSchema = z.object({
  operation: z.enum(["create", "update", "move", "delete", "unchanged", "conflict"]),
  sourcePath: z.string(),
  targetPath: z.string(),
  previousSourcePath: z.string().optional(),
  previousTargetPath: z.string().optional(),
  sourceChecksum: checksum.optional(),
  targetChecksum: checksum.optional(),
  conflictCode: z.enum([
    "SOURCE_TARGET_CONFLICT",
    "DOCUMENTATION_MAPPING_AMBIGUOUS",
    "DOCUMENTATION_RECONCILIATION_REQUIRED",
    "DOCUMENTATION_RECONCILIATION_STALE",
  ]).optional(),
  candidateTargetPaths: z.array(z.string()).optional(),
  reconciliationDisposition: z.literal("adopt-existing").optional(),
}).strict();
export const documentationPreviewInputSchema = z.object({ workspaceId, sourceId: z.string().min(1) }).strict();
export const documentationPreviewOutputSchema = z.object({
  importId: z.string(),
  sourceId: z.string(),
  workspaceId: z.string(),
  snapshotDigest: checksum,
  createdAt: z.string(),
  operations: z.array(documentationOperationSchema),
}).strict();

export const documentationApplyInputSchema = z.object({ importId: z.string().min(1) }).strict();
export const documentationSyncInputSchema = z.object({ sourceId: z.string().min(1) }).strict();
export const documentationCutoverInputSchema = z.object({
  sourceId: z.string().min(1),
  operatorApproved: z.literal(true),
  expectedSnapshotDigest: checksum,
}).strict();
export const documentationSyncOutputSchema = z.object({
  syncRunId: z.string(),
  sourceId: z.string(),
  workspaceId: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  status: z.literal("succeeded"),
  mapRevision: checksum,
}).strict();
export const documentationCutoverOutputSchema = z.object({
  cutoverId: z.string(),
  sourceId: z.string(),
  workspaceId: z.string(),
  snapshotDigest: checksum,
  documentCount: z.number().int().nonnegative(),
  cutoverAt: z.string(),
  status: z.enum(["committed", "completed"]),
  mapRevision: checksum.optional(),
  storageMode: z.literal("managed"),
}).strict();

export const ABCM_MCP_TOOL_SCHEMAS = {
  "agent_instructions.get": { input: agentInstructionsInputSchema, output: agentInstructionsOutputSchema },
  "workspace.create": { input: workspaceCreateInputSchema, output: workspaceCreateOutputSchema },
  "workspace.list_files": { input: workspaceListFilesInputSchema, output: workspaceListFilesOutputSchema },
  "workspace.read_file": { input: workspaceReadFileInputSchema, output: workspaceReadFileOutputSchema },
  "workspace.write_file": { input: workspaceWriteFileInputSchema, output: workspaceWriteFileOutputSchema },
  "workspace.delete_file": { input: workspaceDeleteFileInputSchema, output: workspaceDeleteFileOutputSchema },
  "workspace.upload_start": { input: workspaceUploadStartInputSchema, output: workspaceUploadStartOutputSchema },
  "workspace.upload_chunk": { input: workspaceUploadChunkInputSchema, output: workspaceUploadChunkOutputSchema },
  "workspace.upload_complete": { input: workspaceUploadCompleteInputSchema, output: workspaceUploadCompleteOutputSchema },
  "workspace.upload_abort": { input: workspaceUploadAbortInputSchema, output: workspaceUploadAbortOutputSchema },
  "workspace.batch_apply": { input: workspaceBatchApplyInputSchema, output: workspaceBatchApplyOutputSchema },
  "workspace.move_file": { input: workspaceMoveFileInputSchema, output: workspaceMoveFileOutputSchema },
  "workspace.create_directory": { input: workspaceCreateDirectoryInputSchema, output: workspaceCreateDirectoryOutputSchema },
  "workspace.move_directory": { input: workspaceMoveDirectoryInputSchema, output: workspaceMoveDirectoryOutputSchema },
  "workspace.delete_directory": { input: workspaceDeleteDirectoryInputSchema, output: workspaceDeleteDirectoryOutputSchema },
  "scope_map.scan": { input: scopeMapScanInputSchema, output: scopeMapScanOutputSchema },
  "context.get_domain_language": { input: domainLanguageInputSchema, output: domainLanguageOutputSchema },
  "context.build_task_context": { input: contextBuildInputSchema, output: contextBuildOutputSchema },
  "context.preview_task_context": { input: contextBuildInputSchema, output: contextPreviewOutputSchema },
  "context.build_task_context_v4": { input: contextBuildInputSchema, output: contextBuildOutputSchema },
  "context.preview_task_context_v4": { input: contextBuildInputSchema, output: contextPreviewOutputSchema },
  "context.start_link_graph_session": { input: contextLinkGraphStartInputSchema, output: contextLinkGraphSessionOutputSchema },
  "context.get_link_graph_session": { input: contextLinkGraphGetInputSchema, output: contextLinkGraphSessionOutputSchema },
  "context.step_link_graph_session": { input: contextLinkGraphStepInputSchema, output: contextLinkGraphSessionOutputSchema },
  "context.issue_link_graph_ticket": { input: contextLinkGraphFinalizeInputSchema, output: contextLinkGraphSessionOutputSchema },
  "context.finalize_link_graph_session": { input: contextLinkGraphFinalizeInputSchema, output: contextLinkGraphFinalizeOutputSchema },
  "context.list_link_packages": { input: contextLinkPackageListInputSchema, output: contextLinkPackageListOutputSchema },
  "context.get_link_package": { input: contextLinkPackageGetInputSchema, output: contextLinkPackageViewSchema },
  "context.build_from_link_package": { input: contextLinkPackageBuildInputSchema, output: contextLinkPackageBuildOutputSchema },
  "artifact.preview_amendment": { input: artifactAmendmentPreviewInputSchema, output: artifactAmendmentPreviewOutputSchema },
  "artifact.accept_amendment": { input: artifactAmendmentAcceptInputSchema, output: artifactAmendmentReceiptSchema },
  "artifact.get_lineage": { input: artifactLineageGetInputSchema, output: artifactLineageOutputSchema },
  "documentation_source.preview": { input: documentationPreviewInputSchema, output: documentationPreviewOutputSchema },
  "documentation_source.apply": { input: documentationApplyInputSchema, output: documentationSyncOutputSchema },
  "documentation_source.sync": { input: documentationSyncInputSchema, output: documentationSyncOutputSchema },
  "documentation_source.cutover": { input: documentationCutoverInputSchema, output: documentationCutoverOutputSchema },
} as const;
