import { createAbcmMcpHttpHandler } from "../mcp/create-http-handler.js";
import { createAbcmMcpServer } from "../mcp/create-server.js";
import { ContextBuilder } from "../context/context-builder.js";
import { DirectoryContextFingerprintStore } from "../context/directory-context-fingerprint-store.js";
import type { ContextBuilderOptions } from "../context/types.js";
import { SqliteWorkspaceMapStore } from "../derived-store/sqlite-workspace-map-store.js";
import type { ScopeMapStore, SqliteWorkspaceMapStoreOptions } from "../derived-store/types.js";
import { DirectoryDocumentationSyncService } from "../documentation/directory-documentation-sync-service.js";
import type { DirectoryDocumentationSourceDefinition } from "../documentation/types.js";
import { DomainLanguageService, type DomainLanguageServiceOptions } from "../domain-language/domain-language-service.js";
import { ScopePathResolver } from "../domain-language/scope-path-resolver.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import { createAbcmRestHandler } from "../rest/create-rest-handler.js";
import type { AbcmRestLimitOptions } from "../rest/config.js";
import { requireStaticBearerToken } from "../rest/static-bearer-auth.js";
import { ScopeMapReconcileCoordinator, type ScopeMapReconcileOptions } from "../scope-map/reconcile-coordinator.js";
import { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { ScopeMapAccess } from "../scope-map/types.js";
import { SkillConnectionResolver } from "../skills/skill-connection-resolver.js";
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
  mcpOperationTimeoutMs?: number;
  restLimits?: AbcmRestLimitOptions;
  workspaceStoreRoot?: string;
  scopeMapStore?: ScopeMapStore;
  sqliteDerivedStoreEnabled?: boolean;
  sqliteDerivedStoreOptions?: SqliteWorkspaceMapStoreOptions;
  documentationSources?: readonly DirectoryDocumentationSourceDefinition[];
  scopeMapReconcile?: ScopeMapReconcileOptions;
  scopeMapAccess?: ScopeMapAccess;
  contextPrincipal?: ContextPrincipal;
  domainLanguage?: DomainLanguageServiceOptions;
  context?: ContextBuilderOptions;
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
  if ((options.documentationSources?.length ?? 0) > 0 && ownedScopeMapStore === undefined) {
    throw new Error("documentationSources require sqliteDerivedStoreEnabled=true.");
  }
  const scopeMapStore = options.scopeMapStore ?? ownedScopeMapStore;
  const documentationState = (options.documentationSources?.length ?? 0) > 0 ? ownedScopeMapStore : undefined;
  const scopeMap = new ScopeMapService(registry, scopeMapStore, documentationState);
  const domainLanguage = new DomainLanguageService(registry, scopeMap, options.domainLanguage);
  const scopePathResolver = new ScopePathResolver(domainLanguage, scopeMap);
  const skillConnectionResolver = new SkillConnectionResolver(registry, scopeMap);
  const scopeMapReconciler = new ScopeMapReconcileCoordinator(registry, scopeMap, options.scopeMapReconcile);
  let documentation: DirectoryDocumentationSyncService | undefined;
  const files = new WorkspaceFileService(registry, {
    onMutation: async (workspaceId, changedPaths) => void (await scopeMapReconciler.requestMutation(workspaceId, changedPaths)),
    authorizeMutation: async (workspaceId, paths) => documentation?.authorizeMutation(workspaceId, paths),
  });
  const contextFingerprintStore = new DirectoryContextFingerprintStore(registry);
  const contextBuilder = new ContextBuilder({
    files,
    scopeMap,
    domainLanguage,
    scopePathResolver,
    skillConnectionResolver,
    fingerprintStore: contextFingerprintStore,
    ...(options.context === undefined ? {} : { options: options.context }),
  });
  if (documentationState !== undefined && options.documentationSources !== undefined) {
    documentation = new DirectoryDocumentationSyncService({
      registry,
      files,
      scopeMap,
      state: documentationState,
      sources: options.documentationSources,
    });
  }
  const workspaceProvisioning =
    options.workspaceStoreRoot === undefined
      ? undefined
      : new WorkspaceProvisioningService({ registry, files, scopeMap, storeRoot: options.workspaceStoreRoot });
  const baseRestHandler = createAbcmRestHandler(
    {
      files,
      scopeMap,
      domainLanguage,
      contextBuilder,
      ...(options.contextPrincipal === undefined ? {} : { contextPrincipal: options.contextPrincipal }),
      ...(options.scopeMapAccess === undefined ? {} : { scopeMapAccess: options.scopeMapAccess }),
      ...(documentation === undefined ? {} : { documentation }),
      ...(workspaceProvisioning === undefined ? {} : { workspaces: workspaceProvisioning }),
    },
    options.restLimits,
  );
  const mcp =
    options.mcpHttpEnabled === false
      ? undefined
      : createAbcmMcpHttpHandler(
          {
            files,
            scopeMap,
            defaultWorkspaceId: defaultWorkspace.id,
            domainLanguage,
            contextBuilder,
            ...(options.contextPrincipal === undefined ? {} : { contextPrincipal: options.contextPrincipal }),
            ...(options.scopeMapAccess === undefined ? {} : { scopeMapAccess: options.scopeMapAccess }),
            ...(options.mcpOperationTimeoutMs === undefined ? {} : { mcpOperationTimeoutMs: options.mcpOperationTimeoutMs }),
            ...(documentation === undefined ? {} : { documentation }),
          },
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
    domainLanguage,
    scopePathResolver,
    skillConnectionResolver,
    contextBuilder,
    contextFingerprintStore,
    scopeMapReconciler,
    workspaceProvisioning,
    documentation,
    restHandler,
    mcpHandler,
    httpHandler: (request: Request) =>
      new URL(request.url).pathname === mcpEndpointPath ? mcpHandler(request) : restHandler(request),
    createMcpServer: () =>
      createAbcmMcpServer({
        files,
        scopeMap,
        defaultWorkspaceId: defaultWorkspace.id,
        domainLanguage,
        contextBuilder,
        ...(options.contextPrincipal === undefined ? {} : { contextPrincipal: options.contextPrincipal }),
        ...(options.scopeMapAccess === undefined ? {} : { scopeMapAccess: options.scopeMapAccess }),
        ...(options.mcpOperationTimeoutMs === undefined ? {} : { mcpOperationTimeoutMs: options.mcpOperationTimeoutMs }),
        ...(documentation === undefined ? {} : { documentation }),
      }),
    close: async () => {
      try {
        await mcp?.close();
      } finally {
        try {
          await scopeMapReconciler.close();
        } finally {
          ownedScopeMapStore?.close();
        }
      }
    },
  };
}
