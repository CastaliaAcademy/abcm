import { z } from "zod/v4";

import { projectLanguageTagSchema } from "../core/project-language.js";

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
  workspaceCreateDirectoryInputSchema,
  workspaceMoveFileInputSchema,
} from "../mcp/tool-schemas.js";

export const workspaceRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
  name: z.string().min(1).max(160).optional(),
  language: projectLanguageTagSchema,
}).strict();
export const workspaceRegistrationOutputSchema = z.object({ id: z.string() }).strict();

export const restMoveFileInputSchema = workspaceMoveFileInputSchema.omit({ workspaceId: true });
export const restCreateDirectoryInputSchema = workspaceCreateDirectoryInputSchema.omit({ workspaceId: true });
export const restDocumentationPreviewInputSchema = documentationPreviewInputSchema.omit({ workspaceId: true });
export const restDocumentationCutoverInputSchema = documentationCutoverInputSchema.omit({ sourceId: true });

export const REST_SHARED_SCHEMAS = {
  FileEntry: fileEntrySchema,
  WorkspaceRegistration: workspaceRegistrationSchema,
  WorkspaceRegistrationResult: workspaceRegistrationOutputSchema,
  MoveFileRequest: restMoveFileInputSchema,
  CreateDirectoryRequest: restCreateDirectoryInputSchema,
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
