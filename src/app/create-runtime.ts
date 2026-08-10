import { createAbcmMcpServer } from "../mcp/create-server.js";
import { createAbcmRestHandler } from "../rest/create-rest-handler.js";
import { requireStaticBearerToken } from "../rest/static-bearer-auth.js";
import { ScopeMapService } from "../scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../workspace/file-service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { WorkspaceDefinition } from "../workspace/types.js";

export interface AbcmRuntimeOptions {
  bearerToken?: string;
}

export function createAbcmRuntime(workspace: WorkspaceDefinition, options: AbcmRuntimeOptions = {}) {
  const registry = new WorkspaceRegistry([workspace]);
  const scopeMap = new ScopeMapService(registry);
  const files = new WorkspaceFileService(registry, { onMutation: async () => void (await scopeMap.scan(workspace.id)) });
  const baseRestHandler = createAbcmRestHandler({ files, scopeMap });
  return {
    registry,
    files,
    scopeMap,
    restHandler:
      options.bearerToken === undefined ? baseRestHandler : requireStaticBearerToken(baseRestHandler, options.bearerToken),
    createMcpServer: () => createAbcmMcpServer({ files, scopeMap, defaultWorkspaceId: workspace.id }),
  };
}
