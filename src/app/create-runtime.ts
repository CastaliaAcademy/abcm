import { resolve } from "node:path";

import { createAbcmMcpHttpHandler } from "../mcp/create-http-handler.js";
import { createAbcmMcpServer } from "../mcp/create-server.js";
import { ContextBuilder } from "../context/context-builder.js";
import type { ContextBuildCacheCatalog } from "../context/context-build-cache.js";
import type { AbcmObservability } from "../core/observability.js";
import { DirectoryContextFingerprintStore } from "../context/directory-context-fingerprint-store.js";
import type { ContextBuilderOptions, ContextFingerprintCatalog } from "../context/types.js";
import type { ContextOutcomeCatalog } from "../evaluation/context-outcome-receipt.js";
import { ContextOutcomeService } from "../evaluation/context-outcome-service.js";
import type { ContextFeedbackCatalog } from "../evaluation/context-feedback.js";
import { ContextFeedbackService } from "../evaluation/context-feedback-service.js";
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
import { WorkspaceBatchService } from "../workspace/batch-service.js";
import { WorkspaceFileService } from "../workspace/file-service.js";
import { WorkspaceMutationCoordinator } from "../workspace/mutation-coordinator.js";
import { ObsidianSyncService, type ObsidianSyncServiceOptions } from "../sync/obsidian-sync-service.js";
import { WorkspaceProvisioningService } from "../workspace/provisioning-service.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { MutationAuthorizer, WorkspaceDefinition } from "../workspace/types.js";
import { WorkspaceUploadService } from "../workspace/upload-service.js";

export interface AbcmRuntimeOptions {
  bearerToken?: string;
  mcpHttpEnabled?: boolean;
  mcpEndpointPath?: string;
  mcpAllowedHostnames?: string[];
  mcpAllowedOrigins?: string[];
  mcpOperationTimeoutMs?: number;
  restLimits?: AbcmRestLimitOptions;
  workspaceStoreRoot?: string;
  fileOperations?: {
    stateRoot: string;
    maxUploadBytes?: number;
    maxChunkBytes?: number;
    uploadTtlMs?: number;
    maxBatchBytes?: number;
  };
  scopeMapStore?: ScopeMapStore;
  sqliteDerivedStoreEnabled?: boolean;
  sqliteDerivedStoreOptions?: SqliteWorkspaceMapStoreOptions;
  documentationSources?: readonly DirectoryDocumentationSourceDefinition[];
  scopeMapReconcile?: ScopeMapReconcileOptions;
  scopeMapAccess?: ScopeMapAccess;
  contextPrincipal?: ContextPrincipal;
  domainLanguage?: DomainLanguageServiceOptions;
  context?: ContextBuilderOptions;
  observability?: AbcmObservability;
  contextFingerprintCatalog?: ContextFingerprintCatalog;
  contextOutcomeCatalog?: ContextOutcomeCatalog;
  contextBuildCacheCatalog?: ContextBuildCacheCatalog;
  contextFeedbackCatalog?: ContextFeedbackCatalog;
  obsidianSync?: Omit<ObsidianSyncServiceOptions, "observability">;
}

export function createAbcmRuntime(
  workspaceInput: WorkspaceDefinition | readonly WorkspaceDefinition[],
  options: AbcmRuntimeOptions = {},
) {
  const workspaces = Array.isArray(workspaceInput) ? workspaceInput : [workspaceInput];
  if (workspaces.length === 0) throw new Error("At least one workspace definition is required.");
  if (options.obsidianSync !== undefined && options.bearerToken === undefined) {
    throw new Error("Obsidian synchronization requires an administrative bearer token.");
  }
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
  const scopeMap = new ScopeMapService(registry, scopeMapStore, documentationState, {
    ...(options.observability === undefined ? {} : { observability: options.observability }),
  });
  const domainLanguage = new DomainLanguageService(registry, scopeMap, options.domainLanguage);
  const scopePathResolver = new ScopePathResolver(domainLanguage, scopeMap, options.observability);
  const skillConnectionResolver = new SkillConnectionResolver(registry, scopeMap);
  const scopeMapReconciler = new ScopeMapReconcileCoordinator(registry, scopeMap, options.scopeMapReconcile);
  let documentation: DirectoryDocumentationSyncService | undefined;
  let obsidianSync: ObsidianSyncService | undefined;
  const mutationCoordinator = new WorkspaceMutationCoordinator(options.fileOperations === undefined
    ? {}
    : { databasePath: resolve(options.fileOperations.stateRoot, "mutation-lock.sqlite") });
  const authorizeMutation: MutationAuthorizer = async (workspaceId, paths, operation) => {
    await documentation?.authorizeMutation(workspaceId, paths);
    await scopeMap.authorizeArtifactMutation(workspaceId, paths, operation);
  };
  const files = new WorkspaceFileService(registry, {
    onMutation: async (workspaceId, changedPaths) => {
      await scopeMapReconciler.requestMutation(workspaceId, changedPaths);
      await obsidianSync?.captureWorkspaceMutation(workspaceId, changedPaths);
    },
    authorizeMutation,
    mutationCoordinator,
    ...(options.observability === undefined ? {} : { observability: options.observability }),
  });
  const uploads = options.fileOperations === undefined
    ? undefined
    : new WorkspaceUploadService(registry, {
        stateRoot: options.fileOperations.stateRoot,
        ...(options.fileOperations.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.fileOperations.maxUploadBytes }),
        ...(options.fileOperations.maxChunkBytes === undefined ? {} : { maxChunkBytes: options.fileOperations.maxChunkBytes }),
        ...(options.fileOperations.uploadTtlMs === undefined ? {} : { uploadTtlMs: options.fileOperations.uploadTtlMs }),
      });
  const batches = uploads === undefined || options.fileOperations === undefined
    ? undefined
    : new WorkspaceBatchService(registry, uploads, scopeMap, {
        stateRoot: options.fileOperations.stateRoot,
        mutationCoordinator,
        authorizeMutation,
        ...(options.fileOperations.maxBatchBytes === undefined ? {} : { maxBatchBytes: options.fileOperations.maxBatchBytes }),
        onCommitted: async (workspaceId, changedPaths) => {
          await obsidianSync?.captureWorkspaceMutation(workspaceId, changedPaths);
        },
      });
  if (options.obsidianSync !== undefined) {
    obsidianSync = new ObsidianSyncService(registry, files, {
      ...options.obsidianSync,
      ...(options.documentationSources === undefined ? {} : { reservedReadOnlyMappings: options.documentationSources.map(source => ({ workspaceId: source.workspaceId, targetBasePath: source.targetBasePath })) }),
      ...(options.observability === undefined ? {} : { observability: options.observability }),
    });
  }
  const contextFingerprintCatalog = options.contextFingerprintCatalog ?? ownedScopeMapStore;
  const contextOutcomeCatalog = options.contextOutcomeCatalog ?? ownedScopeMapStore;
  const contextBuildCacheCatalog = options.contextBuildCacheCatalog ?? ownedScopeMapStore;
  const contextFeedbackCatalog = options.contextFeedbackCatalog ?? ownedScopeMapStore;
  const contextOutcomes = contextOutcomeCatalog !== undefined && contextFingerprintCatalog !== undefined && options.contextPrincipal !== undefined
    ? new ContextOutcomeService(contextOutcomeCatalog, contextFingerprintCatalog, options.contextPrincipal)
    : undefined;
  const contextFeedback = contextFeedbackCatalog !== undefined && contextFingerprintCatalog !== undefined && options.contextPrincipal !== undefined
    ? new ContextFeedbackService(contextFeedbackCatalog, contextFingerprintCatalog, options.contextPrincipal)
    : undefined;
  const contextFingerprintStore = new DirectoryContextFingerprintStore(registry, contextFingerprintCatalog);
  const contextBuilder = new ContextBuilder({
    files,
    scopeMap,
    domainLanguage,
    scopePathResolver,
    skillConnectionResolver,
    fingerprintStore: contextFingerprintStore,
    ...(contextBuildCacheCatalog === undefined ? {} : { cache: contextBuildCacheCatalog }),
    ...(options.context === undefined ? {} : { options: options.context }),
    ...(options.observability === undefined ? {} : { observability: options.observability }),
  });
  if (documentationState !== undefined && options.documentationSources !== undefined) {
    documentation = new DirectoryDocumentationSyncService({
      registry,
      files,
      scopeMap,
      state: documentationState,
      sources: options.documentationSources,
      ...(options.observability === undefined ? {} : { observability: options.observability }),
    });
  }
  const workspaceProvisioning =
    options.workspaceStoreRoot === undefined
      ? undefined
      : new WorkspaceProvisioningService({ registry, files, scopeMap, storeRoot: options.workspaceStoreRoot });
  const baseRestHandler = createAbcmRestHandler(
    {
      files,
      ...(uploads === undefined ? {} : { uploads }),
      ...(batches === undefined ? {} : { batches }),
      scopeMap,
      domainLanguage,
      contextBuilder,
      ...(contextOutcomes === undefined ? {} : { contextOutcomes }),
      ...(contextFeedback === undefined ? {} : { contextFeedback }),
      ...(options.contextPrincipal === undefined ? {} : { contextPrincipal: options.contextPrincipal }),
      ...(options.scopeMapAccess === undefined ? {} : { scopeMapAccess: options.scopeMapAccess }),
      ...(documentation === undefined ? {} : { documentation }),
      ...(workspaceProvisioning === undefined ? {} : { workspaces: workspaceProvisioning }),
      ...(obsidianSync === undefined ? {} : { obsidianSync }),
    },
    options.restLimits,
  );
  const mcp =
    options.mcpHttpEnabled === false
      ? undefined
      : createAbcmMcpHttpHandler(
          {
            files,
            ...(uploads === undefined ? {} : { uploads }),
            ...(batches === undefined ? {} : { batches }),
            scopeMap,
            defaultWorkspaceId: defaultWorkspace.id,
            domainLanguage,
            contextBuilder,
            ...(contextOutcomes === undefined ? {} : { contextOutcomes }),
            ...(contextFeedback === undefined ? {} : { contextFeedback }),
            ...(options.contextPrincipal === undefined ? {} : { contextPrincipal: options.contextPrincipal }),
            ...(options.scopeMapAccess === undefined ? {} : { scopeMapAccess: options.scopeMapAccess }),
            ...(options.mcpOperationTimeoutMs === undefined ? {} : { mcpOperationTimeoutMs: options.mcpOperationTimeoutMs }),
            ...(documentation === undefined ? {} : { documentation }),
            ...(workspaceProvisioning === undefined ? {} : { workspaces: workspaceProvisioning }),
          },
          {
            ...(options.mcpEndpointPath === undefined ? {} : { endpointPath: options.mcpEndpointPath }),
            ...(options.mcpAllowedHostnames === undefined ? {} : { allowedHostnames: options.mcpAllowedHostnames }),
            ...(options.mcpAllowedOrigins === undefined ? {} : { allowedOrigins: options.mcpAllowedOrigins }),
          },
        );
  const staticRestHandler = options.bearerToken === undefined
    ? baseRestHandler
    : requireStaticBearerToken(baseRestHandler, options.bearerToken, options.observability);
  const restHandler = async (request: Request) => {
    if (obsidianSync !== undefined && options.bearerToken !== undefined) {
      const pathname = new URL(request.url).pathname;
      const usesDeviceAuthentication = pathname === "/v1/obsidian/pairings/redeem"
        || /^\/v1\/workspaces\/[^/]+\/projects\/[^/]+\/sync\//.test(pathname);
      if (usesDeviceAuthentication) return baseRestHandler(request);
    }
    return staticRestHandler(request);
  };
  const mcpHandler =
    mcp === undefined
      ? async () => Response.json({ code: "FILE_NOT_FOUND", detail: "HTTP endpoint was not found." }, { status: 404 })
      : options.bearerToken === undefined
        ? mcp.fetch
        : requireStaticBearerToken(mcp.fetch, options.bearerToken, options.observability);
  const mcpEndpointPath = options.mcpEndpointPath ?? "/mcp";

  return {
    registry,
    files,
    uploads,
    batches,
    ready: Promise.all([
      uploads?.ready ?? Promise.resolve(),
      batches?.ready ?? Promise.resolve(),
    ]).then(() => undefined),
    scopeMap,
    domainLanguage,
    scopePathResolver,
    skillConnectionResolver,
    contextBuilder,
    contextFingerprintStore,
    contextFingerprintCatalog,
    contextOutcomeCatalog,
    contextOutcomes,
    contextBuildCacheCatalog,
    contextFeedbackCatalog,
    contextFeedback,
    scopeMapReconciler,
    workspaceProvisioning,
    documentation,
    obsidianSync,
    restHandler,
    mcpHandler,
    httpHandler: (request: Request) =>
      new URL(request.url).pathname === mcpEndpointPath ? mcpHandler(request) : restHandler(request),
    createMcpServer: () =>
      createAbcmMcpServer({
        files,
        ...(uploads === undefined ? {} : { uploads }),
        ...(batches === undefined ? {} : { batches }),
        scopeMap,
        defaultWorkspaceId: defaultWorkspace.id,
        domainLanguage,
        contextBuilder,
        ...(contextOutcomes === undefined ? {} : { contextOutcomes }),
        ...(contextFeedback === undefined ? {} : { contextFeedback }),
        ...(options.contextPrincipal === undefined ? {} : { contextPrincipal: options.contextPrincipal }),
        ...(options.scopeMapAccess === undefined ? {} : { scopeMapAccess: options.scopeMapAccess }),
        ...(options.mcpOperationTimeoutMs === undefined ? {} : { mcpOperationTimeoutMs: options.mcpOperationTimeoutMs }),
        ...(documentation === undefined ? {} : { documentation }),
        ...(workspaceProvisioning === undefined ? {} : { workspaces: workspaceProvisioning }),
      }),
    close: async () => {
      try {
        await mcp?.close();
      } finally {
        try {
          await scopeMapReconciler.close();
        } finally {
          try {
            obsidianSync?.close();
          } finally {
            try {
              ownedScopeMapStore?.close();
            } finally {
              mutationCoordinator.close();
            }
          }
        }
      }
    },
  };
}
