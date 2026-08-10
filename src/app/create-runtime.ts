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
  mcpEndpointPath?: string;
  mcpAllowedHostnames?: string[];
  mcpAllowedOrigins?: string[];
}

export function createAbcmRuntime(workspace: WorkspaceDefinition, options: AbcmRuntimeOptions = {}) {
  const registry = new WorkspaceRegistry([workspace]);
  const scopeMap = new ScopeMapService(registry);
  const files = new WorkspaceFileService(registry, { onMutation: async () => void (await scopeMap.scan(workspace.id)) });
  const baseRestHandler = createAbcmRestHandler({ files, scopeMap });
  const mcp = createAbcmMcpHttpHandler(
    { files, scopeMap, defaultWorkspaceId: workspace.id },
    {
      ...(options.mcpEndpointPath === undefined ? {} : { endpointPath: options.mcpEndpointPath }),
      ...(options.mcpAllowedHostnames === undefined ? {} : { allowedHostnames: options.mcpAllowedHostnames }),
      ...(options.mcpAllowedOrigins === undefined ? {} : { allowedOrigins: options.mcpAllowedOrigins }),
    },
  );
  const baseMcpHandler = mcp.fetch;
  const restHandler =
    options.bearerToken === undefined ? baseRestHandler : requireStaticBearerToken(baseRestHandler, options.bearerToken);
  const mcpHandler =
    options.bearerToken === undefined ? baseMcpHandler : requireStaticBearerToken(baseMcpHandler, options.bearerToken);
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
    close: mcp.close,
  };
}
