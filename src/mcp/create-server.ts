import { McpServer } from "@modelcontextprotocol/server";

import { getAbcmAgentInstructions } from "../agent-instructions/agent-instructions.js";

import { AbcmError } from "../core/errors.js";
import { createOperationDeadline } from "../core/operation.js";
import { normalizeBuildTaskContextInput } from "../context/schema.js";
import type { ContextBuilder } from "../context/context-builder.js";
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
  workspaceCreateDirectoryInputSchema,
  workspaceCreateDirectoryOutputSchema,
  workspaceDeleteFileInputSchema,
  workspaceDeleteFileOutputSchema,
  workspaceListFilesInputSchema,
  workspaceListFilesOutputSchema,
  workspaceMoveFileInputSchema,
  workspaceMoveFileOutputSchema,
  workspaceReadFileInputSchema,
  workspaceReadFileOutputSchema,
  workspaceWriteFileInputSchema,
  workspaceWriteFileOutputSchema,
} from "./tool-schemas.js";

export interface AbcmMcpDependencies {
  files: WorkspaceFileService;
  uploads?: WorkspaceUploadService;
  batches?: WorkspaceBatchService;
  scopeMap: ScopeMapService;
  defaultWorkspaceId: string;
  scopeMapAccess?: ScopeMapAccess;
  domainLanguage?: DomainLanguageService;
  contextPrincipal?: ContextPrincipal;
  contextBuilder?: ContextBuilder;
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
  if (error instanceof AbcmError) {
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify({ code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }) }],
    };
  }
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify({ code: "INTERNAL_ERROR", message: "An unexpected server error occurred." }) }],
  };
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
          toolErrors: { encoding: "isError-json", version: "1" },
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
      outputSchema: agentInstructionsOutputSchema,
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
        outputSchema: workspaceCreateOutputSchema,
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
      outputSchema: workspaceListFilesOutputSchema,
    },
    async (input, context) => toolResult(async signal => ({ entries: await dependencies.files.list(input.workspaceId, input.path, input.recursive, signal) }), context.mcpReq.signal, operationTimeoutMs),
  );
  server.registerTool(
    "workspace.read_file",
    {
      title: "Read workspace file",
      description: "Read one allowed project file and return exact base64 bytes plus metadata.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: workspaceReadFileInputSchema,
      outputSchema: workspaceReadFileOutputSchema,
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
      outputSchema: workspaceWriteFileOutputSchema,
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
      outputSchema: workspaceDeleteFileOutputSchema,
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
        outputSchema: workspaceUploadStartOutputSchema,
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
        outputSchema: workspaceUploadChunkOutputSchema,
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
        outputSchema: workspaceUploadCompleteOutputSchema,
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
        outputSchema: workspaceUploadAbortOutputSchema,
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
        outputSchema: workspaceBatchApplyOutputSchema,
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
      outputSchema: workspaceMoveFileOutputSchema,
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
      outputSchema: workspaceCreateDirectoryOutputSchema,
    },
    async (input, context) => toolResult(async signal => ({ entry: await dependencies.files.createDirectory(input.workspaceId, input.path, signal) }), context.mcpReq.signal, operationTimeoutMs),
  );
  server.registerTool(
    "scope_map.scan",
    {
      title: "Scan ScopeMap",
      description: "Build an immutable in-memory ScopeMap revision from the registered workspace.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: scopeMapScanInputSchema,
      outputSchema: scopeMapScanOutputSchema,
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
        outputSchema: domainLanguageOutputSchema,
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
      "context.build_task_context",
      {
        title: "Build task context",
        description: "Resolve a task path and return one immutable, bounded, reproducible context bundle.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: contextBuildInputSchema,
        outputSchema: contextBuildOutputSchema,
      },
      async (input, context) => toolResult(async signal => ({ ...(await dependencies.contextBuilder!.build(
        normalizeBuildTaskContextInput(input),
        dependencies.contextPrincipal!,
        signal,
      )) }), context.mcpReq.signal, operationTimeoutMs),
    );
  }
  if (dependencies.documentation !== undefined) {
    server.registerTool(
      "documentation_source.preview",
      {
        title: "Preview documentation source synchronization",
        description: "Compare one server-configured documentation directory with its read-only workspace mirror.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: documentationPreviewInputSchema,
        outputSchema: documentationPreviewOutputSchema,
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
        outputSchema: documentationSyncOutputSchema,
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
        outputSchema: documentationSyncOutputSchema,
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
        outputSchema: documentationCutoverOutputSchema,
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
