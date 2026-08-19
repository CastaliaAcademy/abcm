export { createAbcmRuntime } from "./app/create-runtime.js";
export {
  ABCM_AGENT_INSTRUCTIONS,
  ABCM_AGENT_INSTRUCTIONS_CHECKSUM,
  ABCM_AGENT_INSTRUCTIONS_CONTENT_TYPE,
  ABCM_AGENT_INSTRUCTIONS_VERSION,
  getAbcmAgentInstructions,
} from "./agent-instructions/agent-instructions.js";
export { CONTEXT_SELECTION_POLICY_VERSION, ContextBuilder } from "./context/context-builder.js";
export {
  CONTEXT_BUILD_CACHE_POLICY_VERSION,
  DOCUMENT_PROJECTION_POLICY_VERSION,
  MemoryContextBuildCacheCatalog,
  contextBuildCacheMetadata,
  createContextBuildCacheIdentity,
} from "./context/context-build-cache.js";
export type { ContextBuildCacheCatalog, ContextBuildCacheEntry, ContextBuildCacheIdentity } from "./context/context-build-cache.js";
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
  ContextBudgetAllocation,
  ContextBudgetProfile,
  ContextBuilderOptions,
  ContextBuildCacheMetadata,
  ContextBundle,
  ContextExecutionBinding,
  ExplicitDocumentReference,
  ContextFingerprint,
  ContextFingerprintCatalog,
  ContextFingerprintCatalogRecord,
  ContextFingerprintDocument,
  ContextFingerprintStore,
  ContextOmission,
  ContextSelectionPreview,
  DocumentProjectionMode,
  MaterializedDocumentProjection,
  SelectedContextDocument,
  SelectionReason,
} from "./context/types.js";
export type { AbcmRuntimeOptions } from "./app/create-runtime.js";
export { SqliteScopeMapStore } from "./derived-store/sqlite-scope-map-store.js";
export { SqliteWorkspaceMapStore } from "./derived-store/sqlite-workspace-map-store.js";
export {
  contextEfficiencyManifestSchema,
  contextEfficiencyPriorityOrder,
  retrievalRunReceiptSchema,
} from "./evaluation/context-efficiency-contracts.js";
export type {
  ContextEfficiencyFallbackMode,
  ContextEfficiencyManifest,
  RetrievalRunReceipt,
} from "./evaluation/context-efficiency-contracts.js";
export { evaluateContextEfficiency } from "./evaluation/context-efficiency-evaluator.js";
export type { ContextEfficiencyReport, ContextEfficiencyVariantResult } from "./evaluation/context-efficiency-evaluator.js";
export {
  contextOutcomeDigest,
  contextOutcomeReceiptSchema,
  contextOutcomeSubmissionSchema,
  createContextOutcomeReceipt,
} from "./evaluation/context-outcome-receipt.js";
export { ContextOutcomeService } from "./evaluation/context-outcome-service.js";
export type {
  ContextOutcomeCatalog,
  ContextOutcomeReceipt,
  ContextOutcomeSubmission,
} from "./evaluation/context-outcome-receipt.js";
export {
  contextFeedbackProposalSchema,
  contextFeedbackSubmissionSchema,
  createContextFeedbackProposal,
} from "./evaluation/context-feedback.js";
export { ContextFeedbackService } from "./evaluation/context-feedback-service.js";
export type {
  ContextFeedbackCatalog,
  ContextFeedbackProposal,
  ContextFeedbackProposalInput,
  ContextFeedbackSubmission,
} from "./evaluation/context-feedback.js";
export { runDirectSearchBaseline } from "./evaluation/direct-search-baseline.js";
export type { DirectSearchBaselineRequest, DirectSearchBaselineResult } from "./evaluation/direct-search-baseline.js";
export {
  ContextBusinessEvalRunner,
  InMemoryBusinessEvaluationCatalog,
  businessEvaluationInputSchema,
  businessEvaluationListRequestSchema,
  businessEvaluationReceiptSchema,
  businessEvaluationRunRequestSchema,
  businessFixtureCatalogSchema,
  businessScenarioDatasetSchema,
  businessVariantObservationSchema,
  contextBusinessVariants,
} from "./evaluation/context-business-eval-runner.js";
export type {
  BusinessEvaluationCatalog,
  BusinessEvaluationInput,
  BusinessEvaluationReceipt,
  BusinessEvaluationRunRequest,
  BusinessFixtureCatalog,
  BusinessScenarioDataset,
  BusinessVariant,
  BusinessVariantExecutionRequest,
  BusinessVariantExecutor,
  BusinessVariantObservation,
} from "./evaluation/context-business-eval-runner.js";
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
export { DEFAULT_MULTI_SCOPE_CONTEXT_POLICY, ScopePathResolver } from "./domain-language/scope-path-resolver.js";
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
  AffectedScopeDetail,
  AffectedScopeOrigin,
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
  MultiScopeContextPolicy,
  NormalizedTaskIntent,
  ResolvedScopePath,
  ResolveTaskPathRequest,
  ResolverPass,
  ScopePathResolverOptions,
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
export { WorkspaceBatchService } from "./workspace/batch-service.js";
export type { WorkspaceBatchServiceOptions } from "./workspace/batch-service.js";
export * from "./workspace/file-operation-contracts.js";
export { WorkspaceFileService } from "./workspace/file-service.js";
export { WorkspaceMutationCoordinator } from "./workspace/mutation-coordinator.js";
export { discoverManagedWorkspaces, WorkspaceProvisioningService } from "./workspace/provisioning-service.js";
export type { WorkspaceProvisioningDependencies } from "./workspace/provisioning-service.js";
export { WorkspaceRegistry } from "./workspace/registry.js";
export { SafeWorkspacePath } from "./workspace/safe-path.js";
export { WorkspaceUploadService } from "./workspace/upload-service.js";
export type { CompletedWorkspaceUpload, WorkspaceUploadServiceOptions } from "./workspace/upload-service.js";
export type {
  DeleteDirectoryOptions,
  DeletePreconditions,
  FileEntry,
  MoveOptions,
  ReadFileResult,
  WorkspaceDefinition,
  WritePreconditions,
} from "./workspace/types.js";
