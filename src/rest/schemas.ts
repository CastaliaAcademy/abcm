import { z } from "zod/v4";

import {
  architectureComplianceSchema,
  architecturePolicyInputSchema,
  architecturePolicyRecordSchema,
  architecturePolicyResolutionSchema,
} from "../architecture/architecture-policy-service.js";
import { OBSIDIAN_SYNC_REST_SCHEMAS } from "../sync/rest-schemas.js";
import {
  contextLinkGraphSessionOutputSchema,
  contextLinkGraphRetrievalReceiptSchema,
  contextLinkGraphStartInputSchema,
  restContextLinkGraphFinalizeInputSchema,
  restContextLinkGraphStepInputSchema,
} from "../context/link-graph-session-schema.js";
import {
  workspaceBatchApplyRequestSchema,
  workspaceBatchApplyOutputSchema,
  workspaceUploadChunkOutputSchema,
  workspaceUploadCompleteOutputSchema,
  workspaceUploadStartInputSchema,
  workspaceUploadStartOutputSchema,
} from "../workspace/file-operation-contracts.js";
import {
  contextLinkPackageBuildInputSchema,
  contextLinkPackageGetInputSchema,
  contextLinkPackageListOutputSchema,
  contextLinkPackageViewSchema,
} from "../context/link-package-schema.js";
import {
  artifactAmendmentAcceptInputSchema,
  artifactAmendmentApprovalIssueInputSchema,
  artifactAmendmentApprovalReceiptSchema,
  artifactAmendmentPreviewInputSchema,
  artifactAmendmentPreviewOutputSchema,
  artifactAmendmentReceiptSchema,
  artifactLineageOutputSchema,
} from "../artifacts/amendment-schema.js";

import {
  contextBuildInputSchema,
  contextBuildOutputSchema,
  contextPreviewOutputSchema,
  documentationPreviewInputSchema,
  documentationPreviewOutputSchema,
  documentationCutoverInputSchema,
  documentationCutoverOutputSchema,
  documentationSyncOutputSchema,
  domainLanguageInputSchema,
  domainLanguageOutputSchema,
  fileEntrySchema,
  scopeMapScanOutputSchema,
  workspaceCreateInputSchema,
  workspaceCreateOutputSchema,
  workspaceCreateDirectoryInputSchema,
  workspaceMoveDirectoryInputSchema,
  workspaceMoveFileInputSchema,
} from "../mcp/tool-schemas.js";

export const workspaceRegistrationSchema = workspaceCreateInputSchema;
export const workspaceRegistrationOutputSchema = workspaceCreateOutputSchema;
export const architecturePolicyListOutputSchema = z.object({ policies: z.array(architecturePolicyRecordSchema) }).strict();

export const restMoveFileInputSchema = workspaceMoveFileInputSchema.omit({ workspaceId: true });
export const restCreateDirectoryInputSchema = workspaceCreateDirectoryInputSchema.omit({ workspaceId: true });
export const restMoveDirectoryInputSchema = workspaceMoveDirectoryInputSchema.omit({ workspaceId: true });
export const restWorkspaceUploadStartInputSchema = workspaceUploadStartInputSchema.omit({ workspaceId: true });
export const restWorkspaceBatchApplyInputSchema = workspaceBatchApplyRequestSchema;
export const restDocumentationPreviewInputSchema = documentationPreviewInputSchema.omit({ workspaceId: true });
export const restDocumentationCutoverInputSchema = documentationCutoverInputSchema.omit({ sourceId: true });

export const REST_SHARED_SCHEMAS = {
  ...OBSIDIAN_SYNC_REST_SCHEMAS,
  FileEntry: fileEntrySchema,
  WorkspaceRegistration: workspaceRegistrationSchema,
  WorkspaceRegistrationResult: workspaceRegistrationOutputSchema,
  ArchitecturePolicyInput: architecturePolicyInputSchema,
  ArchitecturePolicyRecord: architecturePolicyRecordSchema,
  ArchitecturePolicyResolution: architecturePolicyResolutionSchema,
  ArchitecturePolicyListResult: architecturePolicyListOutputSchema,
  ArchitectureCompliance: architectureComplianceSchema,
  MoveFileRequest: restMoveFileInputSchema,
  CreateDirectoryRequest: restCreateDirectoryInputSchema,
  MoveDirectoryRequest: restMoveDirectoryInputSchema,
  WorkspaceUploadStartRequest: restWorkspaceUploadStartInputSchema,
  WorkspaceUploadStartResult: workspaceUploadStartOutputSchema,
  WorkspaceUploadChunkResult: workspaceUploadChunkOutputSchema,
  WorkspaceUploadCompleteResult: workspaceUploadCompleteOutputSchema,
  WorkspaceBatchApplyRequest: restWorkspaceBatchApplyInputSchema,
  WorkspaceBatchApplyResult: workspaceBatchApplyOutputSchema,
  DomainLanguageRequest: domainLanguageInputSchema,
  DomainLanguageResult: domainLanguageOutputSchema,
  BuildTaskContextRequest: contextBuildInputSchema,
  BuildTaskContextResult: contextBuildOutputSchema,
  PreviewTaskContextResult: contextPreviewOutputSchema,
  ContextLinkGraphStartRequest: contextLinkGraphStartInputSchema,
  ContextLinkGraphSessionResult: contextLinkGraphSessionOutputSchema,
  ContextLinkGraphStepRequest: restContextLinkGraphStepInputSchema,
  ContextLinkGraphFinalizeRequest: restContextLinkGraphFinalizeInputSchema,
  ContextLinkGraphFinalizeResult: z.object({
    bundle: contextBuildOutputSchema,
    receipt: contextLinkGraphRetrievalReceiptSchema,
  }).strict(),
  ContextLinkPackageGetRequest: contextLinkPackageGetInputSchema,
  ContextLinkPackage: contextLinkPackageViewSchema,
  ContextLinkPackageListResult: contextLinkPackageListOutputSchema,
  ContextLinkPackageBuildRequest: contextLinkPackageBuildInputSchema,
  ContextLinkPackageBuildResult: z.object({ bundle: contextBuildOutputSchema, package: contextLinkPackageViewSchema }).strict(),
  ArtifactAmendmentPreviewRequest: artifactAmendmentPreviewInputSchema,
  ArtifactAmendmentPreview: artifactAmendmentPreviewOutputSchema,
  ArtifactAmendmentAcceptRequest: artifactAmendmentAcceptInputSchema,
  ArtifactAmendmentApprovalIssueRequest: artifactAmendmentApprovalIssueInputSchema,
  ArtifactAmendmentApprovalReceipt: artifactAmendmentApprovalReceiptSchema,
  ArtifactAmendmentReceipt: artifactAmendmentReceiptSchema,
  ArtifactLineage: artifactLineageOutputSchema,
  DocumentationPreviewRequest: restDocumentationPreviewInputSchema,
  DocumentationPreviewResult: documentationPreviewOutputSchema,
  DocumentationSyncResult: documentationSyncOutputSchema,
  DocumentationCutoverRequest: restDocumentationCutoverInputSchema,
  DocumentationCutoverResult: documentationCutoverOutputSchema,
  ScopeMapScanResult: scopeMapScanOutputSchema.shape.revision,
} as const;
