import { McpServer } from "@modelcontextprotocol/server";

import { getAbcmAgentInstructions } from "../agent-instructions/agent-instructions.js";
import type { ArchitecturePolicyService } from "../architecture/architecture-policy-service.js";

import { AbcmError } from "../core/errors.js";
import { createOperationDeadline } from "../core/operation.js";
import { normalizeBuildTaskContextInput } from "../context/schema.js";
import type { ContextBuilder } from "../context/context-builder.js";
import type { ContextLinkGraphSessionService } from "../context/link-graph-session.js";
import type { ContextLinkPackageService } from "../context/link-package.js";
import type { ArtifactAmendmentService } from "../artifacts/amendment-service.js";
import {
  ABCM_MCP_CONTRACT_VERSION,
  ABCM_MCP_PROTOCOL_VERSIONS,
  ABCM_SERVER_INFO,
  ABCM_SPEC_VERSION,
} from "../core/server-info.js";
import type { DomainLanguageService } from "../domain-language/domain-language-service.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type { DirectoryDocumentationSyncService } from "../documentation/directory-documentation-sync-service.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { ScopeMapAccess } from "../scope-map/types.js";
import type { WorkspaceBatchService } from "../workspace/batch-service.js";
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
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type { WorkspaceProvisioningService } from "../workspace/provisioning-service.js";
import type { WorkspaceUploadService } from "../workspace/upload-service.js";
import { McpResourceCatalog, toMcpProtocolError } from "./resource-catalog.js";
import {
  agentInstructionsInputSchema,
  agentInstructionsOutputSchema,
  contextBuildInputSchema,
  contextBuildOutputSchema,
  contextPreviewOutputSchema,
  contextLinkGraphFinalizeInputSchema,
  contextLinkGraphFinalizeOutputSchema,
  contextLinkGraphGetInputSchema,
  contextLinkGraphSessionOutputSchema,
  contextLinkGraphStartInputSchema,
  contextLinkGraphStepInputSchema,
  contextLinkPackageBuildInputSchema,
  contextLinkPackageBuildOutputSchema,
  contextLinkPackageGetInputSchema,
  contextLinkPackageListInputSchema,
  contextLinkPackageListOutputSchema,
  contextLinkPackageViewSchema,
  artifactAmendmentAcceptInputSchema,
  artifactAmendmentPreviewInputSchema,
  artifactAmendmentPreviewOutputSchema,
  artifactAmendmentReceiptSchema,
  artifactLineageGetInputSchema,
  artifactLineageOutputSchema,
  documentationApplyInputSchema,
  documentationPreviewInputSchema,
  documentationPreviewOutputSchema,
  documentationCutoverInputSchema,
  documentationCutoverOutputSchema,
  documentationSyncInputSchema,
  documentationSyncOutputSchema,
  domainLanguageInputSchema,
  domainLanguageOutputSchema,
  scopeMapScanInputSchema,
  scopeMapScanOutputSchema,
  workspaceCreateInputSchema,
  workspaceCreateOutputSchema,
  workspaceCheckArchitectureComplianceInputSchema,
  workspaceCheckArchitectureComplianceOutputSchema,
  workspaceDeleteArchitecturePolicyInputSchema,
  workspaceDeleteArchitecturePolicyOutputSchema,
  workspaceGetArchitecturePolicyInputSchema,
  workspaceGetArchitecturePolicyOutputSchema,
  workspaceListArchitecturePoliciesInputSchema,
  workspaceListArchitecturePoliciesOutputSchema,
  workspaceSetArchitecturePolicyInputSchema,
  workspaceSetArchitecturePolicyOutputSchema,
  workspaceCreateDirectoryInputSchema,
  workspaceCreateDirectoryOutputSchema,
  workspaceDeleteDirectoryInputSchema,
  workspaceDeleteDirectoryOutputSchema,
  workspaceDeleteFileInputSchema,
  workspaceDeleteFileOutputSchema,
  workspaceListFilesInputSchema,
  workspaceListFilesOutputSchema,
  workspaceMoveDirectoryInputSchema,
  workspaceMoveDirectoryOutputSchema,
  workspaceMoveFileInputSchema,
  workspaceMoveFileOutputSchema,
  workspaceReadFileInputSchema,
  workspaceReadFileOutputSchema,
  workspaceWriteFileInputSchema,
  workspaceWriteFileOutputSchema,
  toolOutputSchema,
} from "./tool-schemas.js";

export interface AbcmMcpDependencies {
  files: WorkspaceFileService;
  uploads?: WorkspaceUploadService;
  batches?: WorkspaceBatchService;
  scopeMap: ScopeMapService;
  architecturePolicies?: ArchitecturePolicyService;
  defaultWorkspaceId: string;
  scopeMapAccess?: ScopeMapAccess;
  domainLanguage?: DomainLanguageService;
  contextPrincipal?: ContextPrincipal;
  contextBuilder?: ContextBuilder;
  contextLinkGraphSessions?: ContextLinkGraphSessionService;
  contextLinkPackages?: ContextLinkPackageService;
  artifactAmendments?: ArtifactAmendmentService;
  documentation?: DirectoryDocumentationSyncService;
  workspaces?: WorkspaceProvisioningService;
  mcpResourcePageSize?: number;
  mcpOperationTimeoutMs?: number;
}

function success(structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

const DEFAULT_MCP_OPERATION_TIMEOUT_MS = 30_000;

function toolError(error: unknown) {
  const result = (
    errorCode: string,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    isError = false,
  ) => {
    const textPayload = { code: errorCode, message, ...(details === undefined ? {} : { details }) };
    const structuredContent = { error_code: errorCode, message, ...(details === undefined ? {} : { details }) };
    return {
      ...(isError ? { isError: true as const } : {}),
      content: [{ type: "text" as const, text: JSON.stringify(textPayload) }],
      structuredContent,
    };
  };
  if (error instanceof AbcmError) {
    return result(error.code, error.message, error.details);
  }
  return result("INTERNAL_ERROR", "An unexpected server error occurred.", undefined, true);
}

async function toolResult(
  action: (signal: AbortSignal) => Promise<Record<string, unknown>>,
  requestSignal: AbortSignal,
  timeoutMs: number,
) {
  const deadline = createOperationDeadline(requestSignal, timeoutMs);
  try {
    return success(await action(deadline.signal));
  } catch (error) {
    if (deadline.signal.aborted) {
      try {
        deadline.mapAbort(error);
      } catch (mapped) {
        return toolError(mapped);
      }
    }
    return toolError(error);
  } finally {
    deadline.finish();
  }
}

function decodeToolContent(content: string, encoding: "utf8" | "base64"): Uint8Array {
  return encoding === "base64"
    ? new Uint8Array(Buffer.from(content, "base64"))
    : new TextEncoder().encode(content);
}

/** Creates an unconnected ABCM MCP server and optionally registers workspace capabilities. */
export function createAbcmMcpServer(dependencies?: AbcmMcpDependencies): McpServer {
  const operationTimeoutMs = dependencies?.mcpOperationTimeoutMs ?? DEFAULT_MCP_OPERATION_TIMEOUT_MS;
  const server = new McpServer(ABCM_SERVER_INFO, {
    supportedProtocolVersions: [...ABCM_MCP_PROTOCOL_VERSIONS],
    capabilities: {
      experimental: {
        "abcm.dev/contract": {
          contractVersion: ABCM_MCP_CONTRACT_VERSION,
          specificationVersion: ABCM_SPEC_VERSION,
          supportedProtocolVersions: [...ABCM_MCP_PROTOCOL_VERSIONS],
          operationTimeoutMs,
          toolErrors: { encoding: "completed-json+structured", version: "3", structuredField: "error_code" },
        },
      },
    },
    instructions: "Call agent_instructions.get first. Then use context.get_domain_language before resolving a task path and context.build_task_context for bounded task context.",
  });
  server.registerTool(
    "agent_instructions.get",
    {
      title: "Get ABCM agent instructions",
      description: "Read the complete self-contained setup and operating guide for ABCM. Call this before every other ABCM capability when the server version is unknown or changed.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: agentInstructionsInputSchema,
      outputSchema: toolOutputSchema(agentInstructionsOutputSchema),
    },
    async (_input, context) => toolResult(async () => getAbcmAgentInstructions(), context.mcpReq.signal, operationTimeoutMs),
  );
  if (!dependencies) return server;
  if (dependencies.workspaces !== undefined) {
    server.registerTool(
      "workspace.create",
      {
        title: "Create managed workspace",
        description: "Create and register a server-owned workspace with an initial workflow scope, required project language configuration, and inherited domain-language convention.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: workspaceCreateInputSchema,
        outputSchema: toolOutputSchema(workspaceCreateOutputSchema),
      },
      async (input, context) => toolResult(
        async signal => dependencies.workspaces!.create({
          id: input.id,
          language: input.language,
          ...(input.name === undefined ? {} : { name: input.name }),
        }, signal),
        context.mcpReq.signal,
        operationTimeoutMs,
      ),
    );
  }
  server.registerTool(
    "workspace.list_files",
    {
      title: "List workspace files",
      description: "List allowed project files without exposing reserved service paths.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: workspaceListFilesInputSchema,
      outputSchema: toolOutputSchema(workspaceListFilesOutputSchema),
    },
    async (input, context) => toolResult(async signal => ({ entries: await dependencies.files.list(input.workspaceId, input.path, input.recursive, signal) }), context.mcpReq.signal, operationTimeoutMs),
  );
  if (dependencies.architecturePolicies !== undefined) {
    server.registerTool(
      "workspace.get_architecture_policy",
      {
        title: "Get file architecture policy",
        description: "Resolve the configured and effective file architecture policy for a workspace or one project.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: workspaceGetArchitecturePolicyInputSchema,
        outputSchema: toolOutputSchema(workspaceGetArchitecturePolicyOutputSchema),
      },
      async (input, context) => toolResult(
        async signal => ({ ...await dependencies.architecturePolicies!.resolve(input, signal) }),
        context.mcpReq.signal,
        operationTimeoutMs,
      ),
    );
    server.registerTool(
      "workspace.set_architecture_policy",
      {
        title: "Set file architecture policy",
        description: "Create or replace a workspace policy or an independent project override with checksum preconditions.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: workspaceSetArchitecturePolicyInputSchema,
        outputSchema: toolOutputSchema(workspaceSetArchitecturePolicyOutputSchema),
      },
      async (input, context) => toolResult(
        async signal => ({ ...await dependencies.architecturePolicies!.set(
          { workspaceId: input.workspaceId, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) },
          { enforcement: input.enforcement, architecture: input.architecture },
          {
            ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
            ...(input.ifNoneMatch === undefined ? {} : { ifNoneMatch: input.ifNoneMatch }),
          },
          signal,
        ) }),
        context.mcpReq.signal,
        operationTimeoutMs,
      ),
    );
    server.registerTool(
      "workspace.delete_architecture_policy",
      {
        title: "Delete file architecture policy",
        description: "Delete a workspace policy or project override; a deleted project override falls back to its workspace policy.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: workspaceDeleteArchitecturePolicyInputSchema,
        outputSchema: toolOutputSchema(workspaceDeleteArchitecturePolicyOutputSchema),
      },
      async (input, context) => toolResult(async signal => {
        await dependencies.architecturePolicies!.delete(
          { workspaceId: input.workspaceId, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) },
          input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch },
          signal,
        );
        return { deleted: true };
      }, context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "workspace.list_architecture_policies",
      {
        title: "List file architecture policies",
        description: "List independently configured workspace and project file architecture policies in one workspace.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: workspaceListArchitecturePoliciesInputSchema,
        outputSchema: toolOutputSchema(workspaceListArchitecturePoliciesOutputSchema),
      },
      async (input, context) => toolResult(
        async signal => ({ policies: await dependencies.architecturePolicies!.list(input.workspaceId, signal) }),
        context.mcpReq.signal,
        operationTimeoutMs,
      ),
    );
    server.registerTool(
      "workspace.check_architecture_compliance",
      {
        title: "Check file architecture compliance",
        description: "Check a workspace or project against its effective required file architecture without returning document bodies.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: workspaceCheckArchitectureComplianceInputSchema,
        outputSchema: toolOutputSchema(workspaceCheckArchitectureComplianceOutputSchema),
      },
      async (input, context) => toolResult(
        async signal => ({ ...await dependencies.architecturePolicies!.check(input, signal) }),
        context.mcpReq.signal,
        operationTimeoutMs,
      ),
    );
  }
  server.registerTool(
    "workspace.read_file",
    {
      title: "Read workspace file",
      description: "Read one allowed project file and return exact base64 bytes plus metadata.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: workspaceReadFileInputSchema,
      outputSchema: toolOutputSchema(workspaceReadFileOutputSchema),
    },
    async (input, context) =>
      toolResult(async signal => {
        const result = await dependencies.files.read(input.workspaceId, input.path, signal);
        return {
          entry: result.entry,
          contentType: result.contentType,
          encoding: "base64",
          content: Buffer.from(result.content).toString("base64"),
        };
      }, context.mcpReq.signal, operationTimeoutMs),
  );
  server.registerTool(
    "workspace.write_file",
    {
      title: "Write workspace file",
      description: "Atomically create or replace an allowed project file with checksum preconditions.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: workspaceWriteFileInputSchema,
      outputSchema: toolOutputSchema(workspaceWriteFileOutputSchema),
    },
    async (input, context) =>
      toolResult(async signal => {
        const content = decodeToolContent(input.content, input.encoding);
        const entry = await dependencies.files.write(input.workspaceId, input.path, content, {
          ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
          ...(input.ifNoneMatch === undefined ? {} : { ifNoneMatch: input.ifNoneMatch }),
        }, signal);
        return { entry };
      }, context.mcpReq.signal, operationTimeoutMs),
  );
  server.registerTool(
    "workspace.delete_file",
    {
      title: "Delete workspace file",
      description: "Delete one regular project file with an optional checksum precondition.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: workspaceDeleteFileInputSchema,
      outputSchema: toolOutputSchema(workspaceDeleteFileOutputSchema),
    },
    async (input, context) =>
      toolResult(async signal => {
        await dependencies.files.delete(input.workspaceId, input.path, input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }, signal);
        return { deleted: true };
      }, context.mcpReq.signal, operationTimeoutMs),
  );
  if (dependencies.uploads !== undefined) {
    server.registerTool(
      "workspace.upload_start",
      {
        title: "Start workspace file upload",
        description: "Start a durable checksum-bound upload before referencing its bytes from workspace.batch_apply.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: workspaceUploadStartInputSchema,
        outputSchema: toolOutputSchema(workspaceUploadStartOutputSchema),
      },
      async (input, context) => toolResult(signal => dependencies.uploads!.start(input, signal), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "workspace.upload_chunk",
      {
        title: "Append workspace upload chunk",
        description: "Append the next base64-encoded chunk with its decoded-byte checksum; exact retries are idempotent.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: workspaceUploadChunkInputSchema,
        outputSchema: toolOutputSchema(workspaceUploadChunkOutputSchema),
      },
      async (input, context) => toolResult(
        signal => dependencies.uploads!.append(input, decodeToolContent(input.content, input.encoding), signal),
        context.mcpReq.signal,
        operationTimeoutMs,
      ),
    );
    server.registerTool(
      "workspace.upload_complete",
      {
        title: "Complete workspace file upload",
        description: "Verify declared size and checksum, then make the upload immutable and usable by workspace.batch_apply.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: workspaceUploadCompleteInputSchema,
        outputSchema: toolOutputSchema(workspaceUploadCompleteOutputSchema),
      },
      async (input, context) => toolResult(
        signal => dependencies.uploads!.complete(input.workspaceId, input.uploadId, signal),
        context.mcpReq.signal,
        operationTimeoutMs,
      ),
    );
    server.registerTool(
      "workspace.upload_abort",
      {
        title: "Abort workspace file upload",
        description: "Delete one upload session and its staged bytes.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: workspaceUploadAbortInputSchema,
        outputSchema: toolOutputSchema(workspaceUploadAbortOutputSchema),
      },
      async (input, context) => toolResult(async signal => {
        await dependencies.uploads!.abort(input.workspaceId, input.uploadId, signal);
        return { aborted: true };
      }, context.mcpReq.signal, operationTimeoutMs),
    );
  }
  if (dependencies.batches !== undefined) {
    server.registerTool(
      "workspace.batch_apply",
      {
        title: "Atomically apply workspace file operations",
        description: "Validate and atomically apply 1-100 mixed create, update, delete, and move operations using completed upload references.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: workspaceBatchApplyInputSchema,
        outputSchema: toolOutputSchema(workspaceBatchApplyOutputSchema),
      },
      async (input, context) => toolResult(signal => dependencies.batches!.apply(input, signal), context.mcpReq.signal, operationTimeoutMs),
    );
  }
  server.registerTool(
    "workspace.move_file",
    {
      title: "Move workspace file",
      description: "Move one regular project file without overwriting by default.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: workspaceMoveFileInputSchema,
      outputSchema: toolOutputSchema(workspaceMoveFileOutputSchema),
    },
    async (input, context) =>
      toolResult(async signal => ({
        entry: await dependencies.files.move(input.workspaceId, input.from, input.to, {
          overwrite: input.overwrite,
          ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
        }, signal),
      }), context.mcpReq.signal, operationTimeoutMs),
  );
  server.registerTool(
    "workspace.create_directory",
    {
      title: "Create workspace directory",
      description: "Create an allowed project directory and missing parent directories.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: workspaceCreateDirectoryInputSchema,
      outputSchema: toolOutputSchema(workspaceCreateDirectoryOutputSchema),
    },
    async (input, context) => toolResult(async signal => ({ entry: await dependencies.files.createDirectory(input.workspaceId, input.path, signal) }), context.mcpReq.signal, operationTimeoutMs),
  );
  server.registerTool(
    "workspace.move_directory",
    {
      title: "Move workspace directory",
      description: "Move one allowed project directory and all regular-file descendants without overwriting the target.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: workspaceMoveDirectoryInputSchema,
      outputSchema: toolOutputSchema(workspaceMoveDirectoryOutputSchema),
    },
    async (input, context) => toolResult(async signal => ({
      entry: await dependencies.files.moveDirectory(input.workspaceId, input.from, input.to, signal),
    }), context.mcpReq.signal, operationTimeoutMs),
  );
  server.registerTool(
    "workspace.delete_directory",
    {
      title: "Delete workspace directory",
      description: "Recursively delete one allowed project directory after explicit recursive=true confirmation.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: workspaceDeleteDirectoryInputSchema,
      outputSchema: toolOutputSchema(workspaceDeleteDirectoryOutputSchema),
    },
    async (input, context) => toolResult(async signal => {
      await dependencies.files.deleteDirectory(input.workspaceId, input.path, { recursive: input.recursive }, signal);
      return { deleted: true };
    }, context.mcpReq.signal, operationTimeoutMs),
  );
  server.registerTool(
    "scope_map.scan",
    {
      title: "Scan ScopeMap",
      description: "Build an immutable in-memory ScopeMap revision from the registered workspace.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: scopeMapScanInputSchema,
      outputSchema: toolOutputSchema(scopeMapScanOutputSchema),
    },
    async (input, context) =>
      toolResult(async signal => ({ revision: dependencies.scopeMap.summarize(await dependencies.scopeMap.scan(input.workspaceId, signal)) }), context.mcpReq.signal, operationTimeoutMs),
  );
  if (dependencies.domainLanguage !== undefined && dependencies.contextPrincipal !== undefined) {
    server.registerTool(
      "context.get_domain_language",
      {
        title: "Get domain language bootstrap",
        description: "Build a principal-bound workflow-plus-project domain-language bootstrap before path resolution.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: domainLanguageInputSchema,
        outputSchema: toolOutputSchema(domainLanguageOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.domainLanguage!.createBootstrap({
        anchor: input.anchor,
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
        ...(input.projection === undefined ? {} : { projection: input.projection }),
      }, dependencies.contextPrincipal!, signal)) }), context.mcpReq.signal, operationTimeoutMs),
    );
  }
  if (dependencies.contextBuilder !== undefined && dependencies.contextPrincipal !== undefined) {
    server.registerTool(
      "context.preview_task_context",
      {
        title: "Preview task context selection",
        description: "Explain the deterministic document selection, projections, omissions, budget, and fallback modes without persisting a fingerprint or returning document bodies.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: contextBuildInputSchema,
        outputSchema: toolOutputSchema(contextPreviewOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.contextBuilder!.preview(
        normalizeBuildTaskContextInput(input),
        dependencies.contextPrincipal!,
        signal,
      )) }), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "context.build_task_context",
      {
        title: "Build task context",
        description: "Resolve a task path and return one immutable, bounded, reproducible context bundle.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: contextBuildInputSchema,
        outputSchema: toolOutputSchema(contextBuildOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.contextBuilder!.build(
        normalizeBuildTaskContextInput(input),
        dependencies.contextPrincipal!,
        signal,
      )) }), context.mcpReq.signal, operationTimeoutMs),
    );
  }
  if (dependencies.contextLinkGraphSessions !== undefined) {
    server.registerTool(
      "context.start_link_graph_session",
      {
        title: "Start interactive link-graph context session",
        description: "Start a principal-bound, body-free, revision-pinned link-graph session from a normal context preview.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: contextLinkGraphStartInputSchema,
        outputSchema: toolOutputSchema(contextLinkGraphSessionOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.contextLinkGraphSessions!.start({
        workspaceId: input.workspaceId,
        request: normalizeBuildTaskContextInput(input.request),
        ...(input.seedDocumentIds === undefined ? {} : { seedDocumentIds: input.seedDocumentIds }),
      }, signal)) }), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "context.get_link_graph_session",
      {
        title: "Get interactive link-graph context session",
        description: "Reconnect to the current body-free state of a principal-bound link-graph session.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: contextLinkGraphGetInputSchema,
        outputSchema: toolOutputSchema(contextLinkGraphSessionOutputSchema),
      },
      async (input, context) => toolResult(async () => ({ ...dependencies.contextLinkGraphSessions!.get(input.sessionId) }), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "context.step_link_graph_session",
      {
        title: "Apply link-graph context session step",
        description: "Apply one sequenced, digest-checked expand, narrow, confirm, undo, or cancel operation.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: contextLinkGraphStepInputSchema,
        outputSchema: toolOutputSchema(contextLinkGraphSessionOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.contextLinkGraphSessions!.step(input, signal)) }), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "context.issue_link_graph_ticket",
      {
        title: "Issue one-time link-graph WebSocket ticket",
        description: "Issue a new short-lived one-time WebSocket subprotocol ticket for reconnecting to an unchanged graph session.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        inputSchema: contextLinkGraphFinalizeInputSchema,
        outputSchema: toolOutputSchema(contextLinkGraphSessionOutputSchema),
      },
      async (input, context) => toolResult(async () => ({ ...dependencies.contextLinkGraphSessions!.issueWebSocketTicket(input) }), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "context.finalize_link_graph_session",
      {
        title: "Finalize link-graph context session",
        description: "Build an immutable ContextBundle through the standard ContextBuilder with confirmed graph documents as explicit selectors.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: contextLinkGraphFinalizeInputSchema,
        outputSchema: toolOutputSchema(contextLinkGraphFinalizeOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.contextLinkGraphSessions!.finalize(input, signal)) }), context.mcpReq.signal, operationTimeoutMs),
    );
  }
  if (dependencies.contextLinkPackages !== undefined) {
    server.registerTool("context.list_link_packages", {
      title: "List tag-derived link packages",
      description: "List access-filtered virtual packages derived from tags in the active workspace documents.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: contextLinkPackageListInputSchema,
      outputSchema: toolOutputSchema(contextLinkPackageListOutputSchema),
    }, async (input, context) => toolResult(async () => ({ packages: dependencies.contextLinkPackages!.list(input.workspaceId) }), context.mcpReq.signal, operationTimeoutMs));
    server.registerTool("context.get_link_package", {
      title: "Get tag-derived link package",
      description: "Read one access-filtered virtual package derived from an Obsidian-compatible document tag.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: contextLinkPackageGetInputSchema,
      outputSchema: toolOutputSchema(contextLinkPackageViewSchema),
    }, async (input, context) => toolResult(async () => ({ ...dependencies.contextLinkPackages!.get(input.workspaceId, input.packageId) }), context.mcpReq.signal, operationTimeoutMs));
    server.registerTool("context.build_from_link_package", {
      title: "Build context from tag-derived link package",
      description: "Bind a tag package to the same workspace bootstrap, reauthorize every member, and build through ContextBuilder.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: contextLinkPackageBuildInputSchema,
      outputSchema: toolOutputSchema(contextLinkPackageBuildOutputSchema),
    }, async (input, context) => toolResult(async signal => ({ ...(await dependencies.contextLinkPackages!.build({ workspaceId: input.workspaceId, packageId: input.packageId, request: normalizeBuildTaskContextInput(input.request) }, signal)) }), context.mcpReq.signal, operationTimeoutMs));
  }
  if (dependencies.artifactAmendments !== undefined) {
    server.registerTool("artifact.preview_amendment", {
      title: "Preview accepted artifact amendment",
      description: "Validate draft checksum, base accepted bytes, lineage head and MapRevision and return the canonical approval payload digest.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: artifactAmendmentPreviewInputSchema,
      outputSchema: toolOutputSchema(artifactAmendmentPreviewOutputSchema),
    }, async (input, context) => toolResult(async signal => ({ ...(await dependencies.artifactAmendments!.preview(input, signal)) }), context.mcpReq.signal, operationTimeoutMs));
    server.registerTool("artifact.accept_amendment", {
      title: "Accept artifact amendment",
      description: "Create one new immutable lineage head from an approved draft while preserving the previous accepted file byte-for-byte.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: artifactAmendmentAcceptInputSchema,
      outputSchema: toolOutputSchema(artifactAmendmentReceiptSchema),
    }, async (input, context) => toolResult(async signal => ({ ...(await dependencies.artifactAmendments!.accept(input, signal)) }), context.mcpReq.signal, operationTimeoutMs));
    server.registerTool("artifact.get_lineage", {
      title: "Get artifact lineage",
      description: "Resolve the current accepted head and immutable revision chain inside the active MapRevision.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: artifactLineageGetInputSchema,
      outputSchema: toolOutputSchema(artifactLineageOutputSchema),
    }, async (input, context) => toolResult(async () => ({ ...dependencies.artifactAmendments!.getLineage(input.workspaceId, input.lineageId) }), context.mcpReq.signal, operationTimeoutMs));
  }
  if (dependencies.documentation !== undefined) {
    server.registerTool(
      "documentation_source.preview",
      {
        title: "Preview documentation source synchronization",
        description: "Compare one server-configured documentation directory with its read-only workspace mirror.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: documentationPreviewInputSchema,
        outputSchema: toolOutputSchema(documentationPreviewOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.documentation!.preview(input.workspaceId, input.sourceId, signal)) }), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "documentation_source.apply",
      {
        title: "Apply documentation synchronization preview",
        description: "Apply a checksum-pinned preview to the workspace mirror and rebuild ScopeMap.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        inputSchema: documentationApplyInputSchema,
        outputSchema: toolOutputSchema(documentationSyncOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.documentation!.apply(input.importId, signal)) }), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "documentation_source.sync",
      {
        title: "Synchronize documentation source",
        description: "Preview and immediately apply one server-configured documentation directory.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: documentationSyncInputSchema,
        outputSchema: toolOutputSchema(documentationSyncOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.documentation!.sync(input.sourceId, signal)) }), context.mcpReq.signal, operationTimeoutMs),
    );
    server.registerTool(
      "documentation_source.cutover",
      {
        title: "Cut over documentation source to managed storage",
        description: "Run a final sync and atomically disable mirror ownership after operator-approved checksum validation.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: documentationCutoverInputSchema,
        outputSchema: toolOutputSchema(documentationCutoverOutputSchema),
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.documentation!.cutover(
        input.sourceId,
        { operatorApproved: input.operatorApproved, expectedSnapshotDigest: input.expectedSnapshotDigest },
        signal,
      )) }), context.mcpReq.signal, operationTimeoutMs),
    );
  }
  const resources = new McpResourceCatalog({
    files: dependencies.files,
    scopeMap: dependencies.scopeMap,
    workspaceId: dependencies.defaultWorkspaceId,
    ...(dependencies.scopeMapAccess === undefined ? {} : { access: dependencies.scopeMapAccess }),
    ...(dependencies.mcpResourcePageSize === undefined ? {} : { pageSize: dependencies.mcpResourcePageSize }),
    ...(dependencies.mcpOperationTimeoutMs === undefined ? {} : { operationTimeoutMs: dependencies.mcpOperationTimeoutMs }),
  });
  server.server.registerCapabilities({ resources: { listChanged: false, subscribe: false } });
  server.server.setRequestHandler("resources/list", async (request, context) => {
    try {
      return await resources.list(request.params?.cursor, context.mcpReq.signal);
    } catch (error) {
      return toMcpProtocolError(error);
    }
  });
  server.server.setRequestHandler("resources/templates/list", async (request, context) => {
    try {
      return await resources.listTemplates(request.params?.cursor, context.mcpReq.signal);
    } catch (error) {
      return toMcpProtocolError(error);
    }
  });
  server.server.setRequestHandler("resources/read", async (request, context) => {
    try {
      return await resources.read(request.params.uri, context.mcpReq.signal);
    } catch (error) {
      return toMcpProtocolError(error, request.params.uri);
    }
  });
  return server;
}
