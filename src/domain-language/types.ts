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
