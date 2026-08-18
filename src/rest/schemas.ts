import { z } from "zod/v4";

import { OBSIDIAN_SYNC_REST_SCHEMAS } from "../sync/rest-schemas.js";
import {
  workspaceBatchApplyRequestSchema,
  workspaceBatchApplyOutputSchema,
  workspaceUploadChunkOutputSchema,
  workspaceUploadCompleteOutputSchema,
  workspaceUploadStartInputSchema,
  workspaceUploadStartOutputSchema,
} from "../workspace/file-operation-contracts.js";

import {
  contextBuildInputSchema,
  contextBuildOutputSchema,
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
  DocumentationPreviewRequest: restDocumentationPreviewInputSchema,
  DocumentationPreviewResult: documentationPreviewOutputSchema,
  DocumentationSyncResult: documentationSyncOutputSchema,
  DocumentationCutoverRequest: restDocumentationCutoverInputSchema,
  DocumentationCutoverResult: documentationCutoverOutputSchema,
  ScopeMapScanResult: scopeMapScanOutputSchema.shape.revision,
} as const;
