export interface DirectoryDocumentationSourceDefinition {
  id: string;
  workspaceId: string;
  root: string;
  targetBasePath: string;
  include?: readonly string[];
  exclude?: readonly string[];
  mapping?: readonly DocumentationMappingRule[];
}

export interface DocumentationMappingRule {
  match: string;
  target: string;
}

export type DocumentationOperationKind = "create" | "update" | "move" | "delete" | "unchanged" | "conflict";

export interface DocumentationImportOperation {
  operation: DocumentationOperationKind;
  sourcePath: string;
  targetPath: string;
  previousSourcePath?: string;
  previousTargetPath?: string;
  sourceChecksum?: string;
  targetChecksum?: string;
  conflictCode?: "SOURCE_TARGET_CONFLICT" | "DOCUMENTATION_MAPPING_AMBIGUOUS";
  candidateTargetPaths?: readonly string[];
}

export interface DocumentationImportPlan {
  importId: string;
  sourceId: string;
  workspaceId: string;
  snapshotDigest: string;
  createdAt: string;
  operations: readonly DocumentationImportOperation[];
}

export interface DocumentationSyncResult {
  syncRunId: string;
  sourceId: string;
  workspaceId: string;
  created: number;
  updated: number;
  moved: number;
  deleted: number;
  conflicts: number;
  status: "succeeded";
  mapRevision: string;
}

export interface DocumentProvenanceRecord {
  workspaceId: string;
  sourceId: string;
  sourcePath: string;
  targetPath: string;
  sourceChecksum: string;
  targetChecksum: string;
  lastSynchronizedAt: string;
  active: boolean;
}

export interface TombstoneRecord {
  resourceId: string;
  workspaceId: string;
  sourceId: string;
  formerPath: string;
  checksum: string;
  deletedAt: string;
  reason: "canonical_source_deleted";
}

export interface SyncRunRecord {
  syncRunId: string;
  workspaceId: string;
  sourceId: string;
  startedAt: string;
  finishedAt: string;
  created: number;
  updated: number;
  moved: number;
  deleted: number;
  conflicts: number;
  status: "succeeded";
}

export interface DocumentationStateCommit {
  source: Omit<DirectoryDocumentationSourceDefinition, "root">;
  run: SyncRunRecord;
  upserts: readonly DocumentProvenanceRecord[];
  retirements?: readonly Pick<DocumentProvenanceRecord, "workspaceId" | "sourceId" | "sourcePath" | "lastSynchronizedAt">[];
  deletions: readonly TombstoneRecord[];
}

export interface DocumentStorageResolution {
  storageMode: "managed" | "mirror";
  sourceId?: string;
}

export interface DocumentationStateStore {
  resolveDocumentStorage(workspaceId: string, targetPath: string): DocumentStorageResolution;
  listDocumentProvenance(workspaceId: string, sourceId: string): DocumentProvenanceRecord[];
  listTombstones(workspaceId: string, sourceId: string): TombstoneRecord[];
  listSyncRuns(workspaceId: string, sourceId: string): SyncRunRecord[];
  commitDocumentationSync(commit: DocumentationStateCommit): void;
}
