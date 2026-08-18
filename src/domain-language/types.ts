import type { ScopeMapAccess } from "../scope-map/types.js";

export interface ContextPrincipal {
  principalId: string;
  access: ScopeMapAccess;
}

export interface ContextAnchor {
  workspaceId: string;
  projectId: string;
}

export interface DomainLanguageBootstrapRequest {
  anchor: ContextAnchor;
  roleId?: string;
  projection?: "agent";
}

export interface DomainDefinition {
  id: string;
  name?: string;
  description?: string;
  locked: boolean;
}

export interface ConceptDefinition {
  id: string;
  domainId: string;
  scopeId?: string;
  term: string;
  definition?: string;
  locked: boolean;
}

export interface DomainAlias {
  term: string;
  canonicalTerm: string;
  deprecated: boolean;
}

export interface DomainHomonym {
  term: string;
  canonicalTerms: readonly string[];
}

export interface EffectiveDomainLanguage {
  domains: readonly DomainDefinition[];
  concepts: readonly ConceptDefinition[];
  aliases: readonly DomainAlias[];
  homonyms: readonly DomainHomonym[];
  namingRules: Readonly<Record<string, string>>;
}

export interface DomainLanguageSource {
  scopeId: string;
  relativePath: string;
  checksum: string;
}

export interface DomainLanguageBootstrap {
  bootstrapId: string;
  bootstrapDigest: string;
  anchor: ContextAnchor;
  roleId?: string;
  projection: "agent";
  mapRevision: string;
  sourceConventions: readonly DomainLanguageSource[];
  effectiveLanguage: EffectiveDomainLanguage;
  readiness: "ready";
  createdAt: string;
  expiresAt: string;
}

export interface ResolveTaskPathRequest {
  domainLanguageBootstrapId: string;
  goal: string;
  canonicalDomains?: readonly string[];
  canonicalTerms?: readonly string[];
  keywords?: readonly string[];
  targetHints?: readonly string[];
  exactScopeIds?: readonly string[];
  explicitLinks?: readonly string[];
  artifacts?: readonly string[];
  repositoryPaths?: readonly string[];
}

export interface NormalizedTaskIntent {
  originalGoal: string;
  normalizedGoal: string;
  canonicalDomains: readonly string[];
  canonicalTerms: readonly string[];
  keywords: readonly string[];
  targetHints: readonly string[];
  exactScopeIds: readonly string[];
  explicitLinks: readonly string[];
  artifacts: readonly string[];
  repositoryPaths: readonly string[];
}

export interface ScopeResolutionEvidence {
  tier: "exact" | "artifact" | "repository_path" | "canonical_language" | "relation" | "keyword";
  value: string;
  score: number;
}

export interface ResolverPass {
  pass: 1 | 2;
  targetScopeId: string;
  score: number;
  evidence: readonly ScopeResolutionEvidence[];
}

export type AffectedScopeOrigin = "primary" | "explicit" | "relation";

export interface AffectedScopeDetail {
  scopeId: string;
  origin: AffectedScopeOrigin;
  depth: number;
  viaScopeId?: string;
  relationType?: string;
}

export interface MultiScopeContextPolicy {
  version: string;
  maxExplicitScopes: number;
  maxAffectedScopes: number;
  maxRelationDepth: number;
  relationDirection: "outgoing";
  allowedRelationTypes: readonly string[];
  optionalBudgetAllocation: "deterministic-round-robin";
}

export interface ScopePathResolverOptions {
  multiScopePolicy?: MultiScopeContextPolicy;
}

export interface ResolvedScopePath {
  mapRevision: string;
  bootstrapId: string;
  primaryTargetScopeId: string;
  scopeIds: readonly string[];
  affectedScopeIds: readonly string[];
  affectedScopeDetails: readonly AffectedScopeDetail[];
  multiScopePolicyDigest: string;
  normalizedIntent: NormalizedTaskIntent;
  effectiveDomainLanguage: EffectiveDomainLanguage;
  domainLanguageSources: readonly DomainLanguageSource[];
  resolverTrace: {
    candidateCount: number;
    filteredByAccess: number;
    passes: readonly ResolverPass[];
  };
}
