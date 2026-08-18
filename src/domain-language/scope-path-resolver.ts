import { createHash } from "node:crypto";
import { posix } from "node:path";

import { AbcmError } from "../core/errors.js";
import { observeOperation, type AbcmObservability } from "../core/observability.js";
import { throwIfAborted } from "../core/operation.js";
import { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { AbcmPermission, MapRevision, ScopeNode } from "../scope-map/types.js";
import { DomainLanguageService } from "./domain-language-service.js";
import type {
  AffectedScopeDetail,
  ContextPrincipal,
  DomainLanguageBootstrap,
  EffectiveDomainLanguage,
  MultiScopeContextPolicy,
  NormalizedTaskIntent,
  ResolvedScopePath,
  ResolveTaskPathRequest,
  ResolverPass,
  ScopePathResolverOptions,
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

export const DEFAULT_MULTI_SCOPE_CONTEXT_POLICY: MultiScopeContextPolicy = Object.freeze({
  version: "multi-scope-v1",
  maxExplicitScopes: 8,
  maxAffectedScopes: 16,
  maxRelationDepth: 2,
  relationDirection: "outgoing",
  allowedRelationTypes: Object.freeze(["affects", "depends-on"]),
  optionalBudgetAllocation: "deterministic-round-robin",
});

function unique(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))].sort();
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[_\s]+/g, "-");
}

export class ScopePathResolver {
  readonly #domainLanguage: DomainLanguageService;
  readonly #scopeMap: ScopeMapService;
  readonly #observability: AbcmObservability | undefined;
  readonly #policy: MultiScopeContextPolicy;
  readonly #policyDigest: string;

  constructor(
    domainLanguage: DomainLanguageService,
    scopeMap: ScopeMapService,
    observability?: AbcmObservability,
    options: ScopePathResolverOptions = {},
  ) {
    this.#domainLanguage = domainLanguage;
    this.#scopeMap = scopeMap;
    this.#observability = observability;
    const configured = options.multiScopePolicy ?? DEFAULT_MULTI_SCOPE_CONTEXT_POLICY;
    const allowedRelationTypes = [...new Set(configured.allowedRelationTypes)].sort();
    if (
      configured.version.trim() === "" ||
      !Number.isSafeInteger(configured.maxExplicitScopes) || configured.maxExplicitScopes < 1 ||
      !Number.isSafeInteger(configured.maxAffectedScopes) || configured.maxAffectedScopes < configured.maxExplicitScopes ||
      !Number.isSafeInteger(configured.maxRelationDepth) || configured.maxRelationDepth < 0 || configured.maxRelationDepth > 8 ||
      configured.relationDirection !== "outgoing" ||
      configured.optionalBudgetAllocation !== "deterministic-round-robin" ||
      allowedRelationTypes.length === 0
    ) {
      throw new Error("Multi-scope context policy is invalid.");
    }
    this.#policy = Object.freeze({ ...configured, allowedRelationTypes: Object.freeze(allowedRelationTypes) });
    this.#policyDigest = `sha256:${createHash("sha256").update(JSON.stringify(this.#policy)).digest("hex")}`;
  }

  async resolve(request: ResolveTaskPathRequest, principal: ContextPrincipal, signal?: AbortSignal): Promise<ResolvedScopePath> {
    return observeOperation(this.#observability, {
      operation: "scope_path.resolve",
      principalId: principal.principalId,
      durationMetric: "abcm_scope_path_resolution_duration_ms",
    }, () => this.#resolve(request, principal, signal));
  }

  async #resolve(request: ResolveTaskPathRequest, principal: ContextPrincipal, signal?: AbortSignal): Promise<ResolvedScopePath> {
    throwIfAborted(signal);
    const bootstrap = this.#domainLanguage.validateBootstrap(request.domainLanguageBootstrapId, principal);
    const revision = this.#scopeMap.getActiveRevision(bootstrap.anchor.workspaceId);
    const exactScopeIds = this.#canonicalExactScopeIds(request.exactScopeIds);
    const normalizedRequest = exactScopeIds === undefined ? request : { ...request, exactScopeIds };
    const firstIntent = this.#normalizeIntent(normalizedRequest, bootstrap.effectiveLanguage);
    const universe = exactScopeIds === undefined ? this.#candidateUniverse(revision, bootstrap, principal) : undefined;
    const exactScopes = exactScopeIds === undefined ? undefined : this.#resolveExactScopes(revision, bootstrap, exactScopeIds, principal);
    const first = exactScopes === undefined
      ? this.#select(revision, universe!.nodes, firstIntent, 1, bootstrap.effectiveLanguage)
      : {
          node: exactScopes[0]!,
          evidence: [{ tier: "exact" as const, value: exactScopes[0]!.scopeId, score: SCORE.exact }],
          score: SCORE.exact,
        };
    const firstLocal = await this.#domainLanguage.buildEffectiveLanguageForPath(bootstrap.bootstrapId, first.node.scopeId, principal, signal);
    throwIfAborted(signal);
    const localIntent = this.#normalizeIntent(normalizedRequest, firstLocal.effectiveLanguage);
    const passes: ResolverPass[] = [this.#pass(1, first)];
    let selected = first;
    let effective = firstLocal;
    if (exactScopes === undefined && JSON.stringify(localIntent) !== JSON.stringify(firstIntent)) {
      selected = this.#select(revision, universe!.nodes, localIntent, 2, firstLocal.effectiveLanguage);
      passes.push(this.#pass(2, selected));
      const secondLocal = await this.#domainLanguage.buildEffectiveLanguageForPath(bootstrap.bootstrapId, selected.node.scopeId, principal, signal);
      throwIfAborted(signal);
      const secondIntent = this.#normalizeIntent(normalizedRequest, secondLocal.effectiveLanguage);
      if (JSON.stringify(secondIntent) !== JSON.stringify(localIntent)) {
        throw new AbcmError("PATH_RESOLUTION_NOT_CONVERGED", "Local domain language changed target meaning after the bounded second pass.");
      }
      effective = secondLocal;
    }
    const scopeIds = this.#physicalPath(revision, selected.node.scopeId);
    const affectedScopeDetails = this.#affectedScopes(revision, exactScopes ?? [selected.node], principal);
    const affectedScopeIds = affectedScopeDetails.map(detail => detail.scopeId);
    return {
      mapRevision: revision.revision,
      bootstrapId: bootstrap.bootstrapId,
      primaryTargetScopeId: selected.node.scopeId,
      scopeIds,
      affectedScopeIds,
      affectedScopeDetails,
      multiScopePolicyDigest: this.#policyDigest,
      normalizedIntent: localIntent,
      effectiveDomainLanguage: effective.effectiveLanguage,
      domainLanguageSources: effective.sources,
      resolverTrace: {
        candidateCount: universe?.nodes.length ?? exactScopes!.length,
        filteredByAccess: universe?.filteredByAccess ?? 0,
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
      exactScopeIds: [...(request.exactScopeIds ?? [])],
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

  #canonicalExactScopeIds(references: readonly string[] | undefined): string[] | undefined {
    if (references === undefined) return undefined;
    if (references.length < 1 || references.length > this.#policy.maxExplicitScopes) this.#invalidExactScope();
    const result: string[] = [];
    const seen = new Set<string>();
    for (const reference of references) {
      const match = /^(?:abcm:\/\/scope\/)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.exec(reference);
      if (match === null || seen.has(match[1]!)) this.#invalidExactScope();
      seen.add(match[1]!);
      result.push(match[1]!);
    }
    return result;
  }

  #resolveExactScopes(
    revision: MapRevision,
    bootstrap: DomainLanguageBootstrap,
    scopeIds: readonly string[],
    principal: ContextPrincipal,
  ): ScopeNode[] {
    const result: ScopeNode[] = [];
    for (const scopeId of scopeIds) {
      const node = revision.nodes.find(candidate => candidate.scopeId === scopeId);
      if (node === undefined || node.status !== "valid" || !this.#canUseScope(principal, node)) this.#invalidExactScope();
      result.push(node);
    }
    if (!this.#isDescendantOrSelf(revision, result[0]!, bootstrap.anchor.projectId)) this.#invalidExactScope();
    return result;
  }

  #affectedScopes(revision: MapRevision, roots: readonly ScopeNode[], principal: ContextPrincipal): AffectedScopeDetail[] {
    const details: AffectedScopeDetail[] = roots.map((node, index) => ({
      scopeId: node.scopeId,
      origin: index === 0 ? "primary" : "explicit",
      depth: 0,
    }));
    const visited = new Set(details.map(detail => detail.scopeId));
    const queue = details.map(detail => ({ scopeId: detail.scopeId, depth: 0 }));
    const allowed = new Set(this.#policy.allowedRelationTypes);
    for (let index = 0; index < queue.length && details.length < this.#policy.maxAffectedScopes; index += 1) {
      const current = queue[index]!;
      if (current.depth >= this.#policy.maxRelationDepth) continue;
      const relations = revision.relations
        .filter(relation => relation.status === "resolved" && relation.fromId === current.scopeId && allowed.has(relation.relationType))
        .sort((left, right) => left.relationType.localeCompare(right.relationType) || left.toId.localeCompare(right.toId));
      for (const relation of relations) {
        if (details.length >= this.#policy.maxAffectedScopes || visited.has(relation.toId)) continue;
        const node = revision.nodes.find(candidate => candidate.scopeId === relation.toId);
        if (node === undefined || node.status !== "valid" || !this.#canUseScope(principal, node)) continue;
        const detail: AffectedScopeDetail = {
          scopeId: node.scopeId,
          origin: "relation",
          depth: current.depth + 1,
          viaScopeId: current.scopeId,
          relationType: relation.relationType,
        };
        details.push(detail);
        visited.add(node.scopeId);
        queue.push({ scopeId: node.scopeId, depth: detail.depth });
      }
    }
    return details;
  }

  #canUseScope(principal: ContextPrincipal, node: ScopeNode): boolean {
    return (["scope.discover", "scope.read_metadata", "context.build"] as const).every(permission => this.#hasPermission(principal, node, permission));
  }

  #invalidExactScope(): never {
    throw new AbcmError("TARGET_SCOPE_INVALID", "An exact target scope is invalid or unavailable.");
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
