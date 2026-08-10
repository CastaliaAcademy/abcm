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
  code: "SCOPE_HIERARCHY_INVALID" | "SCOPE_MANIFEST_INVALID" | "SCOPE_ID_DUPLICATE" | "DOMAIN_LANGUAGE_CONFIGURATION_INVALID";
  severity: "branch_error" | "scope_error" | "warning";
  path: string;
  message: string;
  scopeId?: string;
}

export interface MapRevision {
  revision: string;
  digest: string;
  createdAt: string;
  nodes: readonly ScopeNode[];
  relations: readonly ScopeRelation[];
  diagnostics: readonly MapDiagnostic[];
}

export interface ScopeMapProjection {
  mapRevision: string;
  digest: string;
  view: "agent" | "admin";
  nodes: readonly ScopeNode[];
  relations: readonly ScopeRelation[];
  warnings: readonly MapDiagnostic[];
  resolverEntrypoints: readonly ["context.get_domain_language", "context.build_task_context"];
}
