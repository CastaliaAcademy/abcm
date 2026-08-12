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
export type {
  DocumentRecord,
  ExecutableResourceRecord,
  FileClassification,
  FileRecord,
  MapDiagnostic,
  MapRevision,
  MapRevisionSummary,
  ScopeMapProjection,
  ScopeNode,
} from "./scope-map/types.js";
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
