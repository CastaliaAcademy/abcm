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

export type AbcmPermission =
  | "scope.discover"
  | "scope.read_metadata"
  | "scope_map.read_full"
  | "context.build"
  | "document.read"
  | "executable_resource.read";

export type ScopeMapPermission = Extract<
  AbcmPermission,
  "scope.discover" | "scope.read_metadata" | "scope_map.read_full"
>;

export interface ScopeMapAccess {
  workspacePermissions: readonly AbcmPermission[];
  scopeGrants?: Readonly<Record<string, readonly AbcmPermission[]>>;
}

export interface ScopeMapProjectionQuery {
  view?: "agent" | "admin";
  rootScopeId?: string;
  depth?: number;
  includeInvalid?: boolean;
}

export interface ScopeMapProjectionNode {
  scopeId: string;
  kind: ScopeKind;
  name: string;
  relativePath: string;
  parentScopeId?: string;
  rank: number;
  status: ScopeStatus;
  readiness: "ready" | "warning";
  pathOnly: boolean;
  directChildScopeIds: readonly string[];
  relationSummary: {
    inbound: number;
    outbound: number;
    unresolved: number;
  };
}

export interface ScopeRelation {
  fromId: string;
  toId: string;
  relationType: string;
  source: string;
  status: "resolved" | "unresolved_optional" | "unresolved_required";
}

export interface MapDiagnostic {
  code:
    | "SCOPE_HIERARCHY_INVALID"
    | "SCOPE_MANIFEST_INVALID"
    | "SCOPE_ID_DUPLICATE"
    | "DOMAIN_LANGUAGE_CONFIGURATION_INVALID"
    | "PROJECT_LANGUAGE_CONFIGURATION_INVALID"
    | "DOCUMENT_ID_DUPLICATE"
    | "RELATIONS_CONFIGURATION_INVALID"
    | "EXPLICIT_LINK_INVALID"
    | "EXPLICIT_LINK_UNRESOLVED"
    | "FILE_TOO_LARGE"
    | "ARTIFACT_PLACEMENT_INVALID";
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
  tags?: readonly string[];
  domain?: string;
  worker?: string | null;
  links: readonly string[];
  contextPolicy: string;
  projectionPolicy?: "full" | "section" | "summary" | "metadata" | "reference";
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

export type SkillConnectionStrategy = "global" | "scope" | "by-link" | "by-description" | "manual";

export interface SkillDescriptor {
  skillId: string;
  name: string;
  description: string;
  sourceScopeId: string;
  relativePath: string;
  checksum: string;
  compatibility: string;
  strategy: SkillConnectionStrategy;
  lifecycle: string;
  roles: readonly string[];
  taskTypes: readonly string[];
  domains: readonly string[];
  tags: readonly string[];
  requiredKinds: readonly string[];
  requiredTags: readonly string[];
  requiredLinks: readonly string[];
  warnings: readonly ("SKILL_CONTEXT_STRATEGY_DEPRECATED" | "SKILL_CONTEXT_BASE_REMOVED")[];
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
  skills: readonly SkillDescriptor[];
  diagnostics: readonly MapDiagnostic[];
}

export interface ScopeMapProjection {
  mapRevision: string;
  digest: string;
  view: "agent" | "admin";
  rootScopeId: string;
  depth: number | null;
  includeInvalid: boolean;
  nodes: readonly ScopeMapProjectionNode[];
  relations: readonly ScopeRelation[];
  warnings: readonly MapDiagnostic[];
  resourceSummary: {
    indexedFiles: number;
    documents: number;
    executableResources: number;
  };
  admin?: {
    scanCreatedAt: string;
    diagnosticsSummary: {
      branchErrors: number;
      scopeErrors: number;
      warnings: number;
    };
    fileClassificationCounts: Readonly<Record<FileClassification, number>>;
    documentationSyncSummary: {
      managedDocuments: number;
      mirroredDocuments: number;
      sourceIds: readonly string[];
    };
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

export interface ScopeMapChanged {
  workspaceId: string;
  revision: string;
  digest: string;
  changedScopeIds: readonly string[];
  diagnosticsSummary: {
    branchErrors: number;
    scopeErrors: number;
    warnings: number;
  };
}

export type ScopeMapChangedListener = (event: ScopeMapChanged) => void | Promise<void>;
