import type { AffectedScopeDetail, ResolvedScopePath } from "../domain-language/types.js";
import type { ConnectedSkillRecord, SkillConnectionReason } from "../skills/types.js";

export type SelectionReason =
  | "required_applicable"
  | "operator_controlled_applicable"
  | "role_required"
  | "task_type_required"
  | "explicit_link"
  | "path_exact"
  | "path_prefix"
  | "skill_required"
  | "link_package_optional"
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

export type ExplicitDocumentReference =
  | { selector: "document-id"; documentId: string; expectedKind?: string | undefined }
  | { selector: "uri"; uri: string; expectedKind?: string | undefined }
  | { selector: "repository-file"; path: string; expectedKind?: string | undefined }
  | { selector: "repository-directory"; path: string; recursive?: boolean | undefined; expectedKind?: string | undefined }
  | { selector: "repository-prefix"; prefix: string; expectedKind?: string | undefined };

export interface BuildTaskContextRequest {
  domainLanguageBootstrapId: string;
  roleId: string;
  taskType: string;
  goal: string;
  canonicalDomains?: readonly string[];
  canonicalTerms?: readonly string[];
  keywords?: readonly string[];
  targetHints?: readonly string[];
  exactScopeIds?: readonly string[];
  explicitLinks?: readonly string[];
  artifacts?: readonly string[];
  repositoryPaths?: readonly string[];
  budgetProfile?: string;
  requestedSkillIds?: readonly string[];
  explicitDocumentLinks?: readonly string[];
  explicitDocuments?: readonly ExplicitDocumentReference[];
  /** Internal consumer-side binding supplied only after a tag-derived LinkPackage has been validated. */
  linkPackageDocuments?: readonly { documentId: string; mandatory: boolean }[];
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
  reason: "access_denied" | "budget_exceeded" | "lifecycle_excluded" | "selector_mismatch";
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

export interface ContextBudgetAllocation {
  bucketId: string;
  requestedTokens: number;
  reservedTokens: number;
  consumedTokens: number;
  selectedTokens: number;
  omittedTokens: number;
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
  affectedScopeDetails: readonly AffectedScopeDetail[];
  multiScopePolicyDigest: string;
  budgetAllocation: readonly ContextBudgetAllocation[];
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
  affectedScopeDetails: readonly AffectedScopeDetail[];
  multiScopePolicyDigest: string;
  budgetAllocation: readonly ContextBudgetAllocation[];
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
  cache: ContextBuildCacheMetadata;
}

export interface ContextBuildCacheMetadata {
  state: "hit" | "miss" | "stale";
  policyVersion: "context-build-cache/v1";
  projectionPolicyVersion: "document-projection/v1";
  keyDigest: string;
  workspaceSnapshotDigest: string;
  principalAccessDigest: string;
}

export interface ContextSelectionPreview {
  previewDigest: string;
  selectionPolicyVersion: "context-selection/v3";
  workspaceId: string;
  mapRevision: string;
  mapDigest: string;
  primaryTargetScope: string;
  affectedScopes: readonly string[];
  budgetProfile: string;
  budget: ContextBudgetProfile;
  budgetAllocation: readonly ContextBudgetAllocation[];
  selectedDocuments: readonly ContextFingerprintDocument[];
  omissions: readonly ContextOmission[];
  warnings: readonly { code: string; subjectId?: string }[];
  tokenEstimate: number;
  fallbackModes: readonly ["direct-search", "explicit-documents", "bounded-resource-read"];
  cache: ContextBuildCacheMetadata;
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
