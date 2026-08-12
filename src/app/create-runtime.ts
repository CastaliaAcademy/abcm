import { createAbcmMcpHttpHandler } from "../mcp/create-http-handler.js";
import { createAbcmMcpServer } from "../mcp/create-server.js";
import { SqliteWorkspaceMapStore } from "../derived-store/sqlite-workspace-map-store.js";
import type { ScopeMapStore, SqliteWorkspaceMapStoreOptions } from "../derived-store/types.js";
import { createAbcmRestHandler } from "../rest/create-rest-handler.js";
import { requireStaticBearerToken } from "../rest/static-bearer-auth.js";
import { ScopeMapService } from "../scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../workspace/file-service.js";
import { WorkspaceProvisioningService } from "../workspace/provisioning-service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { WorkspaceDefinition } from "../workspace/types.js";

export interface AbcmRuntimeOptions {
  bearerToken?: string;
  mcpHttpEnabled?: boolean;
  mcpEndpointPath?: string;
  mcpAllowedHostnames?: string[];
  mcpAllowedOrigins?: string[];
  workspaceStoreRoot?: string;
  scopeMapStore?: ScopeMapStore;
  sqliteDerivedStoreEnabled?: boolean;
  sqliteDerivedStoreOptions?: SqliteWorkspaceMapStoreOptions;
}

export function createAbcmRuntime(
  workspaceInput: WorkspaceDefinition | readonly WorkspaceDefinition[],
  options: AbcmRuntimeOptions = {},
) {
  const workspaces = Array.isArray(workspaceInput) ? workspaceInput : [workspaceInput];
  if (workspaces.length === 0) throw new Error("At least one workspace definition is required.");
  const defaultWorkspace = workspaces[0]!;
  const registry = new WorkspaceRegistry(workspaces);
  if (options.scopeMapStore !== undefined && options.sqliteDerivedStoreEnabled === true) {
    throw new Error("scopeMapStore and sqliteDerivedStoreEnabled cannot be configured together.");
  }
  const ownedScopeMapStore =
    options.sqliteDerivedStoreEnabled === true
      ? new SqliteWorkspaceMapStore(registry, options.sqliteDerivedStoreOptions)
      : undefined;
  const scopeMapStore = options.scopeMapStore ?? ownedScopeMapStore;
  const scopeMap = new ScopeMapService(registry, scopeMapStore);
  const files = new WorkspaceFileService(registry, {
    onMutation: async workspaceId => void (await scopeMap.scan(workspaceId)),
  });
  const workspaceProvisioning =
    options.workspaceStoreRoot === undefined
      ? undefined
      : new WorkspaceProvisioningService({ registry, files, scopeMap, storeRoot: options.workspaceStoreRoot });
  const baseRestHandler = createAbcmRestHandler({
    files,
    scopeMap,
    ...(workspaceProvisioning === undefined ? {} : { workspaces: workspaceProvisioning }),
  });
  const mcp =
    options.mcpHttpEnabled === false
      ? undefined
      : createAbcmMcpHttpHandler(
          { files, scopeMap, defaultWorkspaceId: defaultWorkspace.id },
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
    workspaceProvisioning,
    restHandler,
    mcpHandler,
    httpHandler: (request: Request) =>
      new URL(request.url).pathname === mcpEndpointPath ? mcpHandler(request) : restHandler(request),
    createMcpServer: () => createAbcmMcpServer({ files, scopeMap, defaultWorkspaceId: defaultWorkspace.id }),
    close: async () => {
      try {
        await mcp?.close();
      } finally {
        ownedScopeMapStore?.close();
      }
    },
  };
}
