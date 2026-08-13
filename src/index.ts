export { createAbcmRuntime } from "./app/create-runtime.js";
export type { AbcmRuntimeOptions } from "./app/create-runtime.js";
export { SqliteScopeMapStore } from "./derived-store/sqlite-scope-map-store.js";
export { SqliteWorkspaceMapStore } from "./derived-store/sqlite-workspace-map-store.js";
export type {
  RuntimeOwnerHandle,
  ScanLeaseHandle,
  ScopeMapStore,
  SqliteScopeMapStoreOptions,
  SqliteWorkspaceMapStoreOptions,
} from "./derived-store/types.js";
export { AbcmError } from "./core/errors.js";
export { ABCM_SERVER_INFO, ABCM_SPEC_VERSION } from "./core/server-info.js";
export { DomainLanguageService } from "./domain-language/domain-language-service.js";
export type { DomainLanguageServiceOptions } from "./domain-language/domain-language-service.js";
export { parseContextPrincipalEnvironment } from "./domain-language/context-principal-config.js";
export type {
  ConceptDefinition,
  ContextAnchor,
  ContextPrincipal,
  DomainAlias,
  DomainDefinition,
  DomainHomonym,
  DomainLanguageBootstrap,
  DomainLanguageBootstrapRequest,
  DomainLanguageSource,
  EffectiveDomainLanguage,
} from "./domain-language/types.js";
export { parseDocumentationSources } from "./documentation/config.js";
export { DirectoryDocumentationSyncService } from "./documentation/directory-documentation-sync-service.js";
export type {
  DirectoryDocumentationSourceDefinition,
  DocumentationImportOperation,
  DocumentationImportPlan,
  DocumentationStateStore,
  DocumentationSyncResult,
  DocumentProvenanceRecord,
  SyncRunRecord,
  TombstoneRecord,
} from "./documentation/types.js";
export { createAbcmMcpHttpHandler } from "./mcp/create-http-handler.js";
export type { AbcmMcpHttpHandler, AbcmMcpHttpOptions } from "./mcp/create-http-handler.js";
export { createAbcmMcpServer } from "./mcp/create-server.js";
export type { AbcmMcpDependencies } from "./mcp/create-server.js";
export { createAbcmRestHandler } from "./rest/create-rest-handler.js";
export type { AbcmRestDependencies, AbcmRestOptions } from "./rest/create-rest-handler.js";
export { requireStaticBearerToken } from "./rest/static-bearer-auth.js";
export { ScopeMapService } from "./scope-map/scope-map-service.js";
export {
  DEFAULT_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS,
  DEFAULT_SCOPE_MAP_RECONCILE_DEBOUNCE_MS,
  parseScopeMapReconcileEnvironment,
} from "./scope-map/reconcile-config.js";
export { ScopeMapReconcileCoordinator } from "./scope-map/reconcile-coordinator.js";
export type { ScopeMapReconcileOptions, ScopeMapScanner } from "./scope-map/reconcile-coordinator.js";
export type {
  AbcmPermission,
  DocumentRecord,
  ExecutableResourceRecord,
  FileClassification,
  FileRecord,
  MapDiagnostic,
  MapRevision,
  MapRevisionSummary,
  ScopeMapProjection,
  ScopeMapProjectionNode,
  ScopeMapProjectionQuery,
  ScopeMapAccess,
  ScopeMapPermission,
  ScopeMapChanged,
  ScopeMapChangedListener,
  ScopeRelation,
  ScopeNode,
} from "./scope-map/types.js";
export type { ScopeMapServiceOptions } from "./scope-map/scope-map-service.js";
export { WorkspaceFileService } from "./workspace/file-service.js";
export { discoverManagedWorkspaces, WorkspaceProvisioningService } from "./workspace/provisioning-service.js";
export type { WorkspaceProvisioningDependencies } from "./workspace/provisioning-service.js";
export { WorkspaceRegistry } from "./workspace/registry.js";
export { SafeWorkspacePath } from "./workspace/safe-path.js";
export type {
  DeletePreconditions,
  FileEntry,
  MoveOptions,
  ReadFileResult,
  WorkspaceDefinition,
  WritePreconditions,
} from "./workspace/types.js";
