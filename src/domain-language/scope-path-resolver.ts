import { posix } from "node:path";

import { AbcmError } from "../core/errors.js";
import { throwIfAborted } from "../core/operation.js";
import { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { AbcmPermission, MapRevision, ScopeNode } from "../scope-map/types.js";
import { DomainLanguageService } from "./domain-language-service.js";
import type {
  ContextPrincipal,
  DomainLanguageBootstrap,
  EffectiveDomainLanguage,
  NormalizedTaskIntent,
  ResolvedScopePath,
  ResolveTaskPathRequest,
  ResolverPass,
  ScopeResolutionEvidence,
} from "./types.js";

interface Candidate {
  node: ScopeNode;
  evidence: ScopeResolutionEvidence[];
  score: number;
}

const SCORE = {
  exact: 1_000,
  artifact: 900,
  repository_path: 800,
  canonical_language: 600,
  relation: 400,
  keyword: 100,
} as const;

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].sort();
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[_\s]+/g, "-");
}

export class ScopePathResolver {
  readonly #domainLanguage: DomainLanguageService;
  readonly #scopeMap: ScopeMapService;

  constructor(domainLanguage: DomainLanguageService, scopeMap: ScopeMapService) {
    this.#domainLanguage = domainLanguage;
    this.#scopeMap = scopeMap;
  }

  async resolve(request: ResolveTaskPathRequest, principal: ContextPrincipal, signal?: AbortSignal): Promise<ResolvedScopePath> {
    throwIfAborted(signal);
    const bootstrap = this.#domainLanguage.validateBootstrap(request.domainLanguageBootstrapId, principal);
    const revision = this.#scopeMap.getActiveRevision(bootstrap.anchor.workspaceId);
    const firstIntent = this.#normalizeIntent(request, bootstrap.effectiveLanguage);
    const universe = this.#candidateUniverse(revision, bootstrap, principal);
    const first = this.#select(revision, universe.nodes, firstIntent, 1, bootstrap.effectiveLanguage);
    const firstLocal = await this.#domainLanguage.buildEffectiveLanguageForPath(bootstrap.bootstrapId, first.node.scopeId, principal, signal);
    throwIfAborted(signal);
    const localIntent = this.#normalizeIntent(request, firstLocal.effectiveLanguage);
    const passes: ResolverPass[] = [this.#pass(1, first)];
    let selected = first;
    let effective = firstLocal;
    if (JSON.stringify(localIntent) !== JSON.stringify(firstIntent)) {
      selected = this.#select(revision, universe.nodes, localIntent, 2, firstLocal.effectiveLanguage);
      passes.push(this.#pass(2, selected));
      const secondLocal = await this.#domainLanguage.buildEffectiveLanguageForPath(bootstrap.bootstrapId, selected.node.scopeId, principal, signal);
      throwIfAborted(signal);
      const secondIntent = this.#normalizeIntent(request, secondLocal.effectiveLanguage);
      if (JSON.stringify(secondIntent) !== JSON.stringify(localIntent)) {
        throw new AbcmError("PATH_RESOLUTION_NOT_CONVERGED", "Local domain language changed target meaning after the bounded second pass.");
      }
      effective = secondLocal;
    }
    const scopeIds = this.#physicalPath(revision, selected.node.scopeId);
    const affectedScopeIds = this.#affectedScopes(revision, selected.node.scopeId, principal);
    return {
      mapRevision: revision.revision,
      bootstrapId: bootstrap.bootstrapId,
      primaryTargetScopeId: selected.node.scopeId,
      scopeIds,
      affectedScopeIds,
      normalizedIntent: localIntent,
      effectiveDomainLanguage: effective.effectiveLanguage,
      domainLanguageSources: effective.sources,
      resolverTrace: {
        candidateCount: universe.nodes.length,
        filteredByAccess: universe.filteredByAccess,
        passes,
      },
    };
  }

  #normalizeIntent(request: ResolveTaskPathRequest, language: EffectiveDomainLanguage): NormalizedTaskIntent {
    const domains = new Set(language.domains.map(domain => domain.id));
    const concepts = new Set(language.concepts.map(concept => concept.id));
    const aliases = new Map(language.aliases.map(alias => [normalized(alias.term), alias.canonicalTerm]));
    const homonyms = new Map(language.homonyms.map(homonym => [normalized(homonym.term), homonym.canonicalTerms]));
    const canonicalDomains = unique(request.canonicalDomains);
    for (const domain of canonicalDomains) {
      if (!domains.has(domain)) throw new AbcmError("UNKNOWN_DOMAIN", `Unknown canonical domain '${domain}'.`, { domain });
    }
    const explicitTerms = unique(request.canonicalTerms);
    const goalWords = new Set(request.goal.toLocaleLowerCase("en-US").split(/[^a-z0-9.-]+/).filter(Boolean).map(normalized));
    const inferredTerms = [...aliases.entries()].filter(([term]) => goalWords.has(term)).map(([, canonical]) => canonical);
    const canonicalTerms = [...new Set([...explicitTerms, ...inferredTerms])].sort().map(term => {
      if (concepts.has(term)) return term;
      const key = normalized(term);
      const homonym = homonyms.get(key);
      if (homonym !== undefined && homonym.length > 1) {
        throw new AbcmError("AMBIGUOUS_DOMAIN_TERM", `Domain term '${term}' is ambiguous.`, { term, candidates: homonym });
      }
      const resolved = aliases.get(key) ?? homonym?.[0];
      if (resolved === undefined || !concepts.has(resolved)) {
        throw new AbcmError("UNKNOWN_DOMAIN_TERM", `Unknown canonical domain term '${term}'.`, { term });
      }
      return resolved;
    });
    return {
      originalGoal: request.goal,
      normalizedGoal: request.goal.trim().replace(/\s+/g, " "),
      canonicalDomains: [...new Set(canonicalDomains)].sort(),
      canonicalTerms: [...new Set(canonicalTerms)].sort(),
      keywords: unique(request.keywords).map(normalized),
      targetHints: unique(request.targetHints).map(normalized),
      explicitLinks: unique(request.explicitLinks),
      artifacts: unique(request.artifacts),
      repositoryPaths: unique(request.repositoryPaths).map(path => posix.normalize(path.replaceAll("\\", "/"))),
    };
  }

  #candidateUniverse(revision: MapRevision, bootstrap: DomainLanguageBootstrap, principal: ContextPrincipal) {
    const project = revision.nodes.find(node => node.scopeId === bootstrap.anchor.projectId)!;
    const descendants = revision.nodes.filter(node => node.status === "valid" && this.#isDescendantOrSelf(revision, node, project.scopeId));
    const nodes = descendants.filter(node => this.#hasPermission(principal, node, "scope.discover") && this.#hasPermission(principal, node, "scope.read_metadata"));
    if (nodes.length === 0) throw new AbcmError("ACCESS_DENIED", "No accessible path-resolution candidates exist.");
    return { nodes, filteredByAccess: descendants.length - nodes.length };
  }

  #select(
    revision: MapRevision,
    nodes: readonly ScopeNode[],
    intent: NormalizedTaskIntent,
    pass: 1 | 2,
    language?: EffectiveDomainLanguage,
  ): Candidate {
    const candidates = nodes.map(node => this.#score(revision, node, intent, language)).sort((left, right) =>
      right.score - left.score || right.node.rank - left.node.rank || left.node.scopeId.localeCompare(right.node.scopeId),
    );
    const winner = candidates[0];
    if (winner === undefined || winner.score === 0) {
      throw new AbcmError("TARGET_SCOPE_INVALID", "No eligible target scope matched the normalized task intent.");
    }
    const second = candidates[1];
    if (second !== undefined && second.score === winner.score && second.node.rank === winner.node.rank) {
      throw new AbcmError("TARGET_SCOPE_AMBIGUOUS", "Target scope candidates are not sufficiently separated.", {
        pass,
        candidates: [winner.node.scopeId, second.node.scopeId].sort(),
        score: winner.score,
      });
    }
    return winner;
  }

  #score(revision: MapRevision, node: ScopeNode, intent: NormalizedTaskIntent, language?: EffectiveDomainLanguage): Candidate {
    const evidence: ScopeResolutionEvidence[] = [];
    const identifiers = new Set([node.scopeId, node.name, ...node.aliases].map(normalized));
    const add = (tier: ScopeResolutionEvidence["tier"], value: string, score: number) => evidence.push({ tier, value, score });
    for (const hint of intent.targetHints) if (identifiers.has(hint)) add("exact", hint, SCORE.exact);
    for (const link of intent.explicitLinks) {
      const id = /^abcm:\/\/scope\/([^/?#]+)$/.exec(link)?.[1];
      if (id !== undefined && identifiers.has(normalized(id))) add("exact", link, SCORE.exact);
    }
    for (const artifact of intent.artifacts) {
      const id = /^abcm:\/\/(?:artifact|plan|architecture)\/([^/?#]+)$/.exec(artifact)?.[1] ?? artifact;
      if (revision.documents.some(document => document.documentId === id && document.scopeId === node.scopeId)) add("artifact", artifact, SCORE.artifact);
    }
    for (const path of intent.repositoryPaths) {
      if (node.relativePath !== "" && (path === node.relativePath || path.startsWith(`${node.relativePath}/`))) {
        add("repository_path", path, SCORE.repository_path + node.rank);
      }
    }
    for (const term of [...intent.canonicalDomains, ...intent.canonicalTerms]) {
      const routedScopeId = language?.concepts.find(concept => concept.id === term)?.scopeId;
      if (routedScopeId === node.scopeId) add("canonical_language", term, SCORE.canonical_language + 200);
      const pieces = term.split(/[.-]/).map(normalized);
      if (pieces.some(piece => identifiers.has(piece))) add("canonical_language", term, SCORE.canonical_language);
    }
    for (const relation of revision.relations) {
      if (relation.status !== "resolved") continue;
      if (relation.toId === node.scopeId && intent.explicitLinks.some(link => link.endsWith(`/${relation.fromId}`))) {
        add("relation", relation.fromId, SCORE.relation);
      }
    }
    const goalTokens = new Set(`${intent.normalizedGoal} ${intent.keywords.join(" ")}`.toLocaleLowerCase("en-US").split(/[^a-z0-9.-]+/).filter(Boolean).map(normalized));
    for (const identifier of identifiers) if (goalTokens.has(identifier)) add("keyword", identifier, SCORE.keyword);
    evidence.sort((left, right) => right.score - left.score || left.value.localeCompare(right.value));
    return { node, evidence, score: evidence.reduce((sum, item) => sum + item.score, 0) };
  }

  #pass(pass: 1 | 2, candidate: Candidate): ResolverPass {
    return { pass, targetScopeId: candidate.node.scopeId, score: candidate.score, evidence: candidate.evidence };
  }

  #physicalPath(revision: MapRevision, targetId: string): string[] {
    const byId = new Map(revision.nodes.map(node => [node.scopeId, node]));
    const result: string[] = [];
    let current = byId.get(targetId);
    while (current !== undefined) {
      result.unshift(current.scopeId);
      current = current.parentScopeId === undefined ? undefined : byId.get(current.parentScopeId);
    }
    return result;
  }

  #affectedScopes(revision: MapRevision, targetId: string, principal: ContextPrincipal): string[] {
    const ids = new Set([targetId]);
    for (const relation of revision.relations) {
      if (relation.status !== "resolved" || relation.relationType === "parent-child") continue;
      if (relation.fromId === targetId) ids.add(relation.toId);
      if (relation.toId === targetId) ids.add(relation.fromId);
    }
    return [...ids].filter(id => {
      const node = revision.nodes.find(candidate => candidate.scopeId === id);
      return node !== undefined && this.#hasPermission(principal, node, "scope.discover");
    }).sort();
  }

  #isDescendantOrSelf(revision: MapRevision, node: ScopeNode, ancestorId: string): boolean {
    const byId = new Map(revision.nodes.map(candidate => [candidate.scopeId, candidate]));
    let current: ScopeNode | undefined = node;
    while (current !== undefined) {
      if (current.scopeId === ancestorId) return true;
      current = current.parentScopeId === undefined ? undefined : byId.get(current.parentScopeId);
    }
    return false;
  }

  #hasPermission(principal: ContextPrincipal, node: ScopeNode, permission: AbcmPermission): boolean {
    if (principal.access.workspacePermissions.includes(permission)) return true;
    const grants = principal.access.scopeGrants;
    if (grants?.[node.scopeId]?.includes(permission) === true) return true;
    return node.aliases.some(alias => grants?.[alias]?.includes(permission) === true);
  }
}
