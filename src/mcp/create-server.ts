import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";

import { AbcmError } from "../core/errors.js";
import { ABCM_SERVER_INFO } from "../core/server-info.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";

export interface AbcmMcpDependencies {
  files: WorkspaceFileService;
  scopeMap: ScopeMapService;
  defaultWorkspaceId: string;
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
      inputSchema: z.object({ workspaceId, path: path.default(""), recursive: z.boolean().default(false) }),
    },
    async input => toolResult(async () => ({ entries: await dependencies.files.list(input.workspaceId, input.path, input.recursive) })),
  );
  server.registerTool(
    "workspace.read_file",
    {
      title: "Read workspace file",
      description: "Read one allowed project file and return exact base64 bytes plus metadata.",
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
      inputSchema: z.object({ workspaceId, path: path.min(1) }),
    },
    async input => toolResult(async () => ({ entry: await dependencies.files.createDirectory(input.workspaceId, input.path) })),
  );
  server.registerTool(
    "scope_map.scan",
    {
      title: "Scan ScopeMap",
      description: "Build an immutable in-memory ScopeMap revision from the registered workspace.",
      inputSchema: z.object({ workspaceId }),
    },
    async input => toolResult(async () => ({ revision: await dependencies.scopeMap.scan(input.workspaceId) })),
  );
  server.registerResource(
    "scope-map",
    "abcm://map",
    { title: "ABCM agent ScopeMap", description: "Bounded agent projection of the default workspace.", mimeType: "application/json" },
    async uri => {
      try {
        dependencies.scopeMap.getProjection(dependencies.defaultWorkspaceId, "agent");
      } catch (error) {
        if (!(error instanceof AbcmError) || error.code !== "MAP_NOT_BUILT") throw error;
        await dependencies.scopeMap.scan(dependencies.defaultWorkspaceId);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(dependencies.scopeMap.getProjection(dependencies.defaultWorkspaceId, "agent")),
          },
        ],
      };
    },
  );
  return server;
}
