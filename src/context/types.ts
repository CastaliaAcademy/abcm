import type { ResolvedScopePath } from "../domain-language/types.js";
import type { ConnectedSkillRecord, SkillConnectionReason } from "../skills/types.js";

export type SelectionReason =
  | "required_applicable"
  | "operator_controlled_applicable"
  | "role_required"
  | "task_type_required"
  | "explicit_link"
  | "skill_required"
  | "target_scope"
  | "related_scope"
  | "domain_or_entity_match"
  | "semantic_or_keyword_match"
  | "optional_background";

export type DocumentProjectionMode = "full" | "section" | "summary" | "metadata" | "reference";

export interface ContextBudgetProfile {
  softLimitTokens: number;
  hardLimitTokens: number;
}

export interface ContextExecutionBinding {
  planId: string;
  runId: string;
  assignmentId?: string;
}

export interface BuildTaskContextRequest {
  domainLanguageBootstrapId: string;
  roleId: string;
  taskType: string;
  goal: string;
  canonicalDomains?: readonly string[];
  canonicalTerms?: readonly string[];
  keywords?: readonly string[];
  targetHints?: readonly string[];
  explicitLinks?: readonly string[];
  artifacts?: readonly string[];
  repositoryPaths?: readonly string[];
  budgetProfile?: string;
  requestedSkillIds?: readonly string[];
  explicitDocumentLinks?: readonly string[];
  approvalId?: string;
  execution?: ContextExecutionBinding;
}

export interface MaterializedDocumentProjection {
  mode: DocumentProjectionMode;
  authoritative: boolean;
  sourceDocumentId: string;
  sourceChecksum: string;
  content?: string;
}

export interface SelectedContextDocument {
  documentId: string;
  kind: string;
  title: string;
  scopeId: string;
  relativePath: string;
  checksum: string;
  mandatory: boolean;
  effectivePriority: number;
  selectionReasons: readonly SelectionReason[];
  projection: MaterializedDocumentProjection;
  tokenEstimate: number;
}

export interface ContextOmission {
  documentId: string;
  reason: "access_denied" | "budget_exceeded" | "lifecycle_excluded";
  selectionReasons: readonly SelectionReason[];
}

export interface ContextFingerprintDocument {
  documentId: string;
  scopeId: string;
  relativePath: string;
  checksum: string;
  mandatory: boolean;
  effectivePriority: number;
  selectionReasons: readonly SelectionReason[];
  projection: Omit<MaterializedDocumentProjection, "content">;
  tokenEstimate: number;
}

export interface ContextFingerprint {
  fingerprintId: string;
  workspaceId: string;
  principalId: string;
  execution?: ContextExecutionBinding;
  mapRevision: string;
  mapDigest: string;
  domainLanguageBootstrapId: string;
  domainLanguageBootstrapDigest: string;
  domainLanguageSources: readonly { scopeId: string; relativePath: string; checksum: string }[];
  configurationDigests: readonly string[];
  roleId: string;
  taskType: string;
  primaryTargetScope: string;
  affectedScopes: readonly string[];
  connectedSkills: readonly {
    skillId: string;
    skillDigest: string;
    strategy: string;
    connectionReasons: readonly SkillConnectionReason[];
    approvalId?: string;
  }[];
  budgetProfile: string;
  budget: ContextBudgetProfile;
  bundleDigest: string;
  tokenEstimate: number;
  selectedDocuments: readonly ContextFingerprintDocument[];
}

export interface ContextBundle {
  contextBundleId: string;
  bundleDigest: string;
  mapRevision: string;
  mapDigest: string;
  domainLanguageBootstrapId: string;
  domainLanguageBootstrapDigest: string;
  roleId: string;
  taskType: string;
  budgetProfile: string;
  budget: ContextBudgetProfile;
  primaryTargetScope: string;
  affectedScopes: readonly string[];
  resolvedScopePath: ResolvedScopePath;
  skillConnectionReasons: Readonly<Record<string, readonly SkillConnectionReason[]>>;
  connectedSkills: readonly ConnectedSkillRecord[];
  selectedDocuments: readonly SelectedContextDocument[];
  selectionReasons: Readonly<Record<string, readonly SelectionReason[]>>;
  warnings: readonly { code: string; subjectId?: string }[];
  conflicts: readonly never[];
  omissions: readonly ContextOmission[];
  tokenEstimate: number;
  contextFingerprintLocation: string;
}

export interface ContextFingerprintStore {
  write(
    workspaceId: string,
    execution: ContextExecutionBinding | undefined,
    fingerprint: ContextFingerprint,
  ): Promise<string>;
}

export interface ContextBundleCatalogRecord {
  workspaceId: string;
  bundleDigest: string;
  mapRevision: string;
  mapDigest: string;
  budgetProfile: string;
  softLimitTokens: number;
  hardLimitTokens: number;
  tokenEstimate: number;
  selectedDocumentCount: number;
}

export interface ContextFingerprintCatalogRecord {
  workspaceId: string;
  fingerprintId: string;
  bundleDigest: string;
  principalId: string;
  location: string;
  fingerprint: ContextFingerprint;
}

export interface ContextFingerprintCatalog {
  recordContextFingerprint(workspaceId: string, location: string, fingerprint: ContextFingerprint): void;
  getContextFingerprint(workspaceId: string, fingerprintId: string): ContextFingerprintCatalogRecord | undefined;
  listContextBundles(workspaceId: string): ContextBundleCatalogRecord[];
}

export interface ContextBuilderOptions {
  budgetProfiles?: Readonly<Record<string, ContextBudgetProfile>>;
  defaultBudgetProfile?: string;
}
