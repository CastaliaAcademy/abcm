export { createAbcmRuntime } from "./app/create-runtime.js";
export {
  ABCM_AGENT_INSTRUCTIONS,
  ABCM_AGENT_INSTRUCTIONS_CHECKSUM,
  ABCM_AGENT_INSTRUCTIONS_CONTENT_TYPE,
  ABCM_AGENT_INSTRUCTIONS_VERSION,
  getAbcmAgentInstructions,
} from "./agent-instructions/agent-instructions.js";
export { ContextBuilder } from "./context/context-builder.js";
export { DirectoryContextFingerprintStore } from "./context/directory-context-fingerprint-store.js";
export { emitAudit, emitMetric, InMemoryAbcmObservability, observeOperation } from "./core/observability.js";
export type {
  AbcmAuditEvent,
  AbcmMetricName,
  AbcmMetricPoint,
  AbcmObservability,
  AbcmOperation,
  AbcmOperationOutcome,
  ObserveOperationOptions,
} from "./core/observability.js";
export { buildTaskContextSchema, normalizeBuildTaskContextInput } from "./context/schema.js";
export type {
  BuildTaskContextRequest,
  ContextBundleCatalogRecord,
  ContextBudgetProfile,
  ContextBuilderOptions,
  ContextBundle,
  ContextExecutionBinding,
  ContextFingerprint,
  ContextFingerprintCatalog,
  ContextFingerprintCatalogRecord,
  ContextFingerprintDocument,
  ContextFingerprintStore,
  ContextOmission,
  DocumentProjectionMode,
  MaterializedDocumentProjection,
  SelectedContextDocument,
  SelectionReason,
} from "./context/types.js";
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
export {
  ABCM_MCP_CONTRACT_VERSION,
  ABCM_MCP_PROTOCOL_VERSIONS,
  ABCM_SERVER_INFO,
  ABCM_SPEC_VERSION,
} from "./core/server-info.js";
export { DomainLanguageService } from "./domain-language/domain-language-service.js";
export { ScopePathResolver } from "./domain-language/scope-path-resolver.js";
export { SkillConnectionResolver } from "./skills/skill-connection-resolver.js";
export type {
  ConnectedSkillRecord,
  ResolveSkillConnectionsRequest,
  SkillConnectionReason,
  SkillConnectionResult,
  SkillContextRequirement,
  SkillMatchEvidence,
} from "./skills/types.js";
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
  NormalizedTaskIntent,
  ResolvedScopePath,
  ResolveTaskPathRequest,
  ResolverPass,
  ScopeResolutionEvidence,
} from "./domain-language/types.js";
export { parseDocumentationSources } from "./documentation/config.js";
export { DirectoryDocumentationSyncService } from "./documentation/directory-documentation-sync-service.js";
export type {
  DirectoryDocumentationSourceDefinition,
  DocumentationImportOperation,
  DocumentationImportPlan,
  DocumentationCutoverRecord,
  DocumentationCutoverResult,
  DocumentationSourceState,
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
export { ABCM_MCP_TOOL_SCHEMAS } from "./mcp/tool-schemas.js";
export { createAbcmRestHandler } from "./rest/create-rest-handler.js";
export type { AbcmRestDependencies, AbcmRestOptions } from "./rest/create-rest-handler.js";
export { createAbcmOpenApiDocument } from "./rest/openapi.js";
export { REST_SHARED_SCHEMAS } from "./rest/schemas.js";
export { DEFAULT_REST_LIMITS, parseRestLimitEnvironment, resolveRestLimitOptions } from "./rest/config.js";
export type { AbcmRestLimitOptions, ResolvedAbcmRestLimitOptions } from "./rest/config.js";
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
  SkillConnectionStrategy,
  SkillDescriptor,
} from "./scope-map/types.js";
export type { ScopeMapServiceOptions } from "./scope-map/scope-map-service.js";
export * from "./sync/contracts.js";
export { ObsidianSyncService } from "./sync/obsidian-sync-service.js";
export type { ObsidianSyncServiceOptions } from "./sync/obsidian-sync-service.js";
export { SqliteObsidianDeviceStore } from "./sync/sqlite-device-store.js";
export type { DeviceAuthenticationScope, ObsidianDevicePrincipal, ObsidianProjectScope, SqliteObsidianDeviceStoreOptions } from "./sync/sqlite-device-store.js";
export { SqliteSyncJournal, syncJournalMutationSchema } from "./sync/sqlite-sync-journal.js";
export type { SqliteSyncJournalOptions, SyncJournalChanges, SyncJournalMutation, SyncJournalObject, SyncJournalRecordResult, SyncJournalTombstone } from "./sync/sqlite-sync-journal.js";
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
