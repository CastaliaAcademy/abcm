import { createAbcmMcpHttpHandler } from "../mcp/create-http-handler.js";
import { createAbcmMcpServer } from "../mcp/create-server.js";
import { createAbcmRestHandler } from "../rest/create-rest-handler.js";
import { requireStaticBearerToken } from "../rest/static-bearer-auth.js";
import { ScopeMapService } from "../scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../workspace/file-service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { WorkspaceDefinition } from "../workspace/types.js";

export interface AbcmRuntimeOptions {
  bearerToken?: string;
  mcpHttpEnabled?: boolean;
  mcpEndpointPath?: string;
  mcpAllowedHostnames?: string[];
  mcpAllowedOrigins?: string[];
}

export function createAbcmRuntime(workspace: WorkspaceDefinition, options: AbcmRuntimeOptions = {}) {
  const registry = new WorkspaceRegistry([workspace]);
  const scopeMap = new ScopeMapService(registry);
  const files = new WorkspaceFileService(registry, { onMutation: async () => void (await scopeMap.scan(workspace.id)) });
  const baseRestHandler = createAbcmRestHandler({ files, scopeMap });
  const mcp =
    options.mcpHttpEnabled === false
      ? undefined
      : createAbcmMcpHttpHandler(
          { files, scopeMap, defaultWorkspaceId: workspace.id },
          {
            ...(options.mcpEndpointPath === undefined ? {} : { endpointPath: options.mcpEndpointPath }),
            ...(options.mcpAllowedHostnames === undefined ? {} : { allowedHostnames: options.mcpAllowedHostnames }),
            ...(options.mcpAllowedOrigins === undefined ? {} : { allowedOrigins: options.mcpAllowedOrigins }),
          },
        );
  const restHandler =
    options.bearerToken === undefined ? baseRestHandler : requireStaticBearerToken(baseRestHandler, options.bearerToken);
  const mcpHandler =
    mcp === undefined
      ? async () => Response.json({ code: "FILE_NOT_FOUND", detail: "HTTP endpoint was not found." }, { status: 404 })
      : options.bearerToken === undefined
        ? mcp.fetch
        : requireStaticBearerToken(mcp.fetch, options.bearerToken);
  const mcpEndpointPath = options.mcpEndpointPath ?? "/mcp";

  return {
    registry,
    files,
    scopeMap,
    restHandler,
    mcpHandler,
    httpHandler: (request: Request) =>
      new URL(request.url).pathname === mcpEndpointPath ? mcpHandler(request) : restHandler(request),
    createMcpServer: () => createAbcmMcpServer({ files, scopeMap, defaultWorkspaceId: workspace.id }),
    close: async () => void (await mcp?.close()),
  };
}
