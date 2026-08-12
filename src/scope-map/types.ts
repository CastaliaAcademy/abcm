export type ScopeKind = "workflow" | "project" | "service" | "feature";
export type ScopeStatus = "valid" | "invalid";

export interface ScopeNode {
  scopeId: string;
  kind: ScopeKind;
  name: string;
  aliases: readonly string[];
  relativePath: string;
  parentScopeId?: string;
  rank: number;
  status: ScopeStatus;
  readiness: "ready" | "warning";
}

export interface ScopeRelation {
  fromId: string;
  toId: string;
  relationType: "parent-child";
}

export interface MapDiagnostic {
  code:
    | "SCOPE_HIERARCHY_INVALID"
    | "SCOPE_MANIFEST_INVALID"
    | "SCOPE_ID_DUPLICATE"
    | "DOMAIN_LANGUAGE_CONFIGURATION_INVALID"
    | "DOCUMENT_ID_DUPLICATE";
  severity: "branch_error" | "scope_error" | "warning";
  path: string;
  message: string;
  scopeId?: string;
}

export type FileClassification =
  | "scope_manifest"
  | "configuration"
  | "domain_language"
  | "agent_definition"
  | "context_document"
  | "executable_resource";

export interface FileRecord {
  scopeId: string;
  relativePath: string;
  size: number;
  mtime: number;
  checksum: string;
  parseStatus: "parsed" | "not_applicable" | "invalid";
  classification: FileClassification;
  storageMode: "managed" | "mirror";
  sourceId?: string;
}

export interface DocumentRecord {
  documentId: string;
  kind: string;
  title: string;
  scopeId: string;
  relativePath: string;
  checksum: string;
  lifecycle: string;
  requiredSelectors: readonly string[];
  roleSelectors: readonly string[];
  taskSelectors: readonly string[];
  links: readonly string[];
  contextPolicy: string;
  storageMode: "managed" | "mirror";
}

export interface ExecutableResourceRecord {
  resourceId: string;
  scopeId: string;
  relativePath: string;
  language: string;
  checksum: string;
  activationStatus: "required";
  permissionsProfile: "executable_resource.read";
}

export interface MapRevision {
  revision: string;
  digest: string;
  createdAt: string;
  nodes: readonly ScopeNode[];
  relations: readonly ScopeRelation[];
  files: readonly FileRecord[];
  documents: readonly DocumentRecord[];
  executableResources: readonly ExecutableResourceRecord[];
  diagnostics: readonly MapDiagnostic[];
}

export interface ScopeMapProjection {
  mapRevision: string;
  digest: string;
  view: "agent" | "admin";
  nodes: readonly ScopeNode[];
  relations: readonly ScopeRelation[];
  warnings: readonly MapDiagnostic[];
  resourceSummary: {
    indexedFiles: number;
    documents: number;
    executableResources: number;
  };
  resolverEntrypoints: readonly ["context.get_domain_language", "context.build_task_context"];
}

export interface MapRevisionSummary {
  revision: string;
  digest: string;
  createdAt: string;
  nodes: readonly ScopeNode[];
  relations: readonly ScopeRelation[];
  diagnostics: readonly MapDiagnostic[];
  resourceSummary: ScopeMapProjection["resourceSummary"];
}
