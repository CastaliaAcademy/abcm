import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { AbcmError } from "../core/errors.js";
import { buildTaskContextSchema, normalizeBuildTaskContextInput } from "../context/schema.js";
import type { ContextBuilder } from "../context/context-builder.js";
import { ABCM_SERVER_INFO } from "../core/server-info.js";
import type { DomainLanguageService } from "../domain-language/domain-language-service.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type { DirectoryDocumentationSyncService } from "../documentation/directory-documentation-sync-service.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { ScopeMapAccess } from "../scope-map/types.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";

export interface AbcmMcpDependencies {
  files: WorkspaceFileService;
  scopeMap: ScopeMapService;
  defaultWorkspaceId: string;
  scopeMapAccess?: ScopeMapAccess;
  domainLanguage?: DomainLanguageService;
  contextPrincipal?: ContextPrincipal;
  contextBuilder?: ContextBuilder;
  documentation?: DirectoryDocumentationSyncService;
}

function success(structuredContent: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
}

async function toolResult(action: () => Promise<Record<string, unknown>>) {
  try {
    return success(await action());
  } catch (error) {
    if (error instanceof AbcmError) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify({ code: error.code, message: error.message, details: error.details }) }],
      };
    }
    throw error;
  }
}

/** Creates an unconnected ABCM MCP server and optionally registers workspace capabilities. */
export function createAbcmMcpServer(dependencies?: AbcmMcpDependencies): McpServer {
  const server = new McpServer(ABCM_SERVER_INFO);
  if (!dependencies) return server;
  const workspaceId = z.string().min(1);
  const path = z.string();

  server.registerTool(
    "workspace.list_files",
    {
      title: "List workspace files",
      description: "List allowed project files without exposing reserved service paths.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ workspaceId, path: path.default(""), recursive: z.boolean().default(false) }),
    },
    async input => toolResult(async () => ({ entries: await dependencies.files.list(input.workspaceId, input.path, input.recursive) })),
  );
  server.registerTool(
    "workspace.read_file",
    {
      title: "Read workspace file",
      description: "Read one allowed project file and return exact base64 bytes plus metadata.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ workspaceId, path: path.min(1) }),
    },
    async input =>
      toolResult(async () => {
        const result = await dependencies.files.read(input.workspaceId, input.path);
        return {
          entry: result.entry,
          contentType: result.contentType,
          encoding: "base64",
          content: Buffer.from(result.content).toString("base64"),
        };
      }),
  );
  server.registerTool(
    "workspace.write_file",
    {
      title: "Write workspace file",
      description: "Atomically create or replace an allowed project file with checksum preconditions.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        workspaceId,
        path: path.min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        ifMatch: z.string().optional(),
        ifNoneMatch: z.literal("*").optional(),
      }),
    },
    async input =>
      toolResult(async () => {
        const content =
          input.encoding === "base64"
            ? new Uint8Array(Buffer.from(input.content, "base64"))
            : new TextEncoder().encode(input.content);
        const entry = await dependencies.files.write(input.workspaceId, input.path, content, {
          ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
          ...(input.ifNoneMatch === undefined ? {} : { ifNoneMatch: input.ifNoneMatch }),
        });
        return { entry };
      }),
  );
  server.registerTool(
    "workspace.delete_file",
    {
      title: "Delete workspace file",
      description: "Delete one regular project file with an optional checksum precondition.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ workspaceId, path: path.min(1), ifMatch: z.string().optional() }),
    },
    async input =>
      toolResult(async () => {
        await dependencies.files.delete(input.workspaceId, input.path, input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch });
        return { deleted: true };
      }),
  );
  server.registerTool(
    "workspace.move_file",
    {
      title: "Move workspace file",
      description: "Move one regular project file without overwriting by default.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        workspaceId,
        from: path.min(1),
        to: path.min(1),
        overwrite: z.boolean().default(false),
        ifMatch: z.string().optional(),
      }),
    },
    async input =>
      toolResult(async () => ({
        entry: await dependencies.files.move(input.workspaceId, input.from, input.to, {
          overwrite: input.overwrite,
          ...(input.ifMatch === undefined ? {} : { ifMatch: input.ifMatch }),
        }),
      })),
  );
  server.registerTool(
    "workspace.create_directory",
    {
      title: "Create workspace directory",
      description: "Create an allowed project directory and missing parent directories.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ workspaceId, path: path.min(1) }),
    },
    async input => toolResult(async () => ({ entry: await dependencies.files.createDirectory(input.workspaceId, input.path) })),
  );
  server.registerTool(
    "scope_map.scan",
    {
      title: "Scan ScopeMap",
      description: "Build an immutable in-memory ScopeMap revision from the registered workspace.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: z.object({ workspaceId }),
    },
    async input =>
      toolResult(async () => ({ revision: dependencies.scopeMap.summarize(await dependencies.scopeMap.scan(input.workspaceId)) })),
  );
  if (dependencies.domainLanguage !== undefined && dependencies.contextPrincipal !== undefined) {
    server.registerTool(
      "context.get_domain_language",
      {
        title: "Get domain language bootstrap",
        description: "Build a principal-bound workflow-plus-project domain-language bootstrap before path resolution.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: z.object({
          anchor: z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1) }).strict(),
          roleId: z.string().min(1).optional(),
          projection: z.literal("agent").optional(),
        }).strict(),
      },
      async input => toolResult(async () => ({ ...(await dependencies.domainLanguage!.createBootstrap({
        anchor: input.anchor,
        ...(input.roleId === undefined ? {} : { roleId: input.roleId }),
        ...(input.projection === undefined ? {} : { projection: input.projection }),
      }, dependencies.contextPrincipal!)) })),
    );
  }
  if (dependencies.contextBuilder !== undefined && dependencies.contextPrincipal !== undefined) {
    server.registerTool(
      "context.build_task_context",
      {
        title: "Build task context",
        description: "Resolve a task path and return one immutable, bounded, reproducible context bundle.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: buildTaskContextSchema,
      },
      async input => toolResult(async () => ({ ...(await dependencies.contextBuilder!.build(
        normalizeBuildTaskContextInput(input),
        dependencies.contextPrincipal!,
      )) })),
    );
  }
  if (dependencies.documentation !== undefined) {
    server.registerTool(
      "documentation_source.preview",
      {
        title: "Preview documentation source synchronization",
        description: "Compare one server-configured documentation directory with its read-only workspace mirror.",
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: z.object({ workspaceId, sourceId: z.string().min(1) }).strict(),
      },
      async input => toolResult(async () => ({ ...(await dependencies.documentation!.preview(input.workspaceId, input.sourceId)) })),
    );
    server.registerTool(
      "documentation_source.apply",
      {
        title: "Apply documentation synchronization preview",
        description: "Apply a checksum-pinned preview to the workspace mirror and rebuild ScopeMap.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        inputSchema: z.object({ importId: z.string().min(1) }).strict(),
      },
      async input => toolResult(async () => ({ ...(await dependencies.documentation!.apply(input.importId)) })),
    );
    server.registerTool(
      "documentation_source.sync",
      {
        title: "Synchronize documentation source",
        description: "Preview and immediately apply one server-configured documentation directory.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        inputSchema: z.object({ sourceId: z.string().min(1) }).strict(),
      },
      async input => toolResult(async () => ({ ...(await dependencies.documentation!.sync(input.sourceId)) })),
    );
  }
  server.registerResource(
    "scope-map",
    "abcm://map",
    { title: "ABCM agent ScopeMap", description: "Bounded agent projection of the default workspace.", mimeType: "application/json" },
    async uri => {
      try {
        dependencies.scopeMap.getProjection(
          dependencies.defaultWorkspaceId,
          { view: "agent" },
          dependencies.scopeMapAccess,
        );
      } catch (error) {
        if (!(error instanceof AbcmError) || error.code !== "MAP_NOT_BUILT") throw error;
        await dependencies.scopeMap.scan(dependencies.defaultWorkspaceId);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              dependencies.scopeMap.getProjection(
                dependencies.defaultWorkspaceId,
                { view: "agent" },
                dependencies.scopeMapAccess,
              ),
            ),
          },
        ],
      };
    },
  );
  return server;
}
