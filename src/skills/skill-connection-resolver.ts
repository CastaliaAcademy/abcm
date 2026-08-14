import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { AbcmError } from "../core/errors.js";
import { throwIfAborted } from "../core/operation.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { AbcmPermission, MapRevision, ScopeNode, SkillDescriptor } from "../scope-map/types.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type {
  ConnectedSkillRecord,
  ResolveSkillConnectionsRequest,
  SkillConnectionReason,
  SkillConnectionResult,
  SkillContextRequirement,
  SkillMatchEvidence,
} from "./types.js";

interface Candidate {
  descriptor: SkillDescriptor;
  reasons: Set<SkillConnectionReason>;
  evidence: SkillMatchEvidence[];
  descriptionScore: number;
}

function tokens(value: string): Set<string> {
  return new Set(value.toLocaleLowerCase("en-US").split(/[^a-z0-9.-]+/).filter(Boolean));
}

function checksum(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export class SkillConnectionResolver {
  readonly #registry: WorkspaceRegistry;
  readonly #scopeMap: ScopeMapService;

  constructor(registry: WorkspaceRegistry, scopeMap: ScopeMapService) {
    this.#registry = registry;
    this.#scopeMap = scopeMap;
  }

  async resolve(request: ResolveSkillConnectionsRequest, principal: ContextPrincipal, signal?: AbortSignal): Promise<SkillConnectionResult> {
    throwIfAborted(signal);
    const revision = this.#scopeMap.getActiveRevision(request.workspaceId);
    if (revision.revision !== request.path.mapRevision) {
      throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_STALE", "Resolved scope path is not pinned to the active map revision.");
    }
    const catalog = revision.skills.filter(skill => {
      const owner = revision.nodes.find(node => node.scopeId === skill.sourceScopeId);
      return owner !== undefined && owner.status === "valid" && skill.lifecycle === "active" &&
        this.#hasPermission(principal, owner, "scope.discover") && this.#hasPermission(principal, owner, "scope.read_metadata") &&
        this.#hasPermission(principal, owner, "context.build") &&
        (skill.compatibility === "" || /ABCM|Agent Skills/i.test(skill.compatibility)) &&
        (skill.roles.length === 0 || skill.roles.includes(request.roleId)) &&
        (skill.taskTypes.length === 0 || skill.taskTypes.includes(request.taskType));
    });
    for (const skill of catalog) {
      throwIfAborted(signal);
      if (skill.strategy === "global" && revision.nodes.find(node => node.scopeId === skill.sourceScopeId)?.kind !== "workflow") {
        throw new AbcmError("GLOBAL_SKILL_MUST_BE_WORKFLOW_OWNED", `Global skill '${skill.skillId}' is not workflow-owned.`);
      }
    }
    const candidates = new Map<string, Candidate[]>();
    const candidate = (descriptor: SkillDescriptor): Candidate => {
      const entries = candidates.get(descriptor.skillId) ?? [];
      let current = entries.find(entry => entry.descriptor.sourceScopeId === descriptor.sourceScopeId);
      if (current === undefined) {
        current = { descriptor, reasons: new Set(), evidence: [], descriptionScore: 0 };
        entries.push(current);
        candidates.set(descriptor.skillId, entries);
      }
      return current;
    };
    const exactLinks = new Set(request.explicitSkillLinks ?? []);
    const manualIds = new Set(request.requestedSkillIds ?? []);
    for (const descriptor of catalog) {
      throwIfAborted(signal);
      const current = candidate(descriptor);
      if (descriptor.strategy === "global") this.#add(current, "global_workspace_baseline", { field: "global", value: "workspace", score: 1 });
      if (descriptor.strategy === "scope" && this.#scopeApplies(revision, descriptor.sourceScopeId, request.path)) {
        this.#add(current, "scope_owner_or_descendant", { field: "scope", value: descriptor.sourceScopeId, score: 1 });
      }
      if (descriptor.strategy === "by-link" && exactLinks.has(`abcm://skill/${descriptor.skillId}`)) {
        this.#add(current, "explicit_skill_link", { field: "explicit_link", value: descriptor.skillId, score: 100 });
      }
      if (descriptor.strategy === "manual" && manualIds.has(descriptor.skillId)) {
        this.#add(current, "manual_request", { field: "manual", value: descriptor.skillId, score: 100 });
      }
      if (descriptor.strategy === "by-description") this.#descriptionEvidence(current, request);
    }
    for (const link of exactLinks) {
      const id = /^abcm:\/\/skill\/([^/?#]+)$/.exec(link)?.[1];
      if (id === undefined || !catalog.some(skill => skill.skillId === id && skill.strategy === "by-link")) {
        throw new AbcmError("REQUIRED_SKILL_LINK_UNRESOLVED", `Required skill link '${link}' did not resolve.`, { link });
      }
    }
    const descriptionCandidates = [...candidates.values()].flat().filter(item => item.descriptor.strategy === "by-description" && item.descriptionScore >= 2);
    descriptionCandidates.sort((left, right) => right.descriptionScore - left.descriptionScore || left.descriptor.skillId.localeCompare(right.descriptor.skillId));
    if (descriptionCandidates[0] !== undefined && descriptionCandidates[1] !== undefined && descriptionCandidates[0].descriptionScore === descriptionCandidates[1].descriptionScore && descriptionCandidates[0].descriptor.skillId !== descriptionCandidates[1].descriptor.skillId) {
      throw new AbcmError("SKILL_CONNECTION_AMBIGUOUS", "Description-matched skills are not sufficiently separated.", {
        candidates: [descriptionCandidates[0].descriptor.skillId, descriptionCandidates[1].descriptor.skillId].sort(),
        score: descriptionCandidates[0].descriptionScore,
      });
    }
    if (descriptionCandidates[0] !== undefined) descriptionCandidates[0].reasons.add("description_match");

    const selected: Candidate[] = [];
    for (const entries of candidates.values()) {
      const connected = entries.filter(entry => entry.reasons.size > 0);
      if (connected.length === 0) continue;
      connected.sort((left, right) => this.#scopeRank(revision, right.descriptor.sourceScopeId) - this.#scopeRank(revision, left.descriptor.sourceScopeId));
      const winner = connected[0]!;
      for (const alternate of connected.slice(1)) for (const reason of alternate.reasons) winner.reasons.add(reason);
      selected.push(winner);
    }
    selected.sort((left, right) => left.descriptor.skillId.localeCompare(right.descriptor.skillId));
    const workspace = this.#registry.get(request.workspaceId);
    const connectedSkills: ConnectedSkillRecord[] = [];
    const requirements: SkillContextRequirement[] = [];
    for (const item of selected) {
      throwIfAborted(signal);
      const bytes = new Uint8Array(await readFile(join(workspace.root, item.descriptor.relativePath)));
      throwIfAborted(signal);
      if (checksum(bytes) !== item.descriptor.checksum) throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_STALE", `Skill '${item.descriptor.skillId}' changed after map publication.`);
      connectedSkills.push({
        skillId: item.descriptor.skillId,
        skillDigest: item.descriptor.checksum,
        sourceScopeId: item.descriptor.sourceScopeId,
        strategy: item.descriptor.strategy,
        connectionReasons: [...item.reasons].sort(),
        matchEvidence: item.evidence.sort((left, right) => right.score - left.score || left.value.localeCompare(right.value)),
        body: new TextDecoder().decode(bytes),
        ...(item.reasons.has("manual_request") && request.approvalId !== undefined ? { approvalId: request.approvalId } : {}),
      });
      for (const value of item.descriptor.requiredKinds) requirements.push({ sourceSkillId: item.descriptor.skillId, kind: "document_kind", value });
      for (const value of item.descriptor.requiredTags) requirements.push({ sourceSkillId: item.descriptor.skillId, kind: "tag", value });
      for (const value of item.descriptor.requiredLinks) requirements.push({ sourceSkillId: item.descriptor.skillId, kind: "explicit_link", value });
    }
    requirements.sort((left, right) => `${left.sourceSkillId}/${left.kind}/${left.value}`.localeCompare(`${right.sourceSkillId}/${right.kind}/${right.value}`));
    return {
      connectedSkills,
      contextRequirements: requirements,
      diagnostics: catalog.flatMap(skill => skill.warnings.map(code => ({ code, skillId: skill.skillId }))).sort((left, right) => `${left.skillId}/${left.code}`.localeCompare(`${right.skillId}/${right.code}`)),
    };
  }

  #add(candidate: Candidate, reason: SkillConnectionReason, evidence: SkillMatchEvidence): void {
    candidate.reasons.add(reason); candidate.evidence.push(evidence);
  }

  #descriptionEvidence(candidate: Candidate, request: ResolveSkillConnectionsRequest): void {
    const skill = candidate.descriptor;
    const intentTokens = tokens(`${request.intent.normalizedGoal} ${request.intent.keywords.join(" ")} ${request.intent.canonicalTerms.join(" ")}`);
    const fields: Array<[SkillMatchEvidence["field"], readonly string[], number]> = [
      ["name", [skill.name], 3], ["description", [skill.description], 1], ["role", skill.roles, 2],
      ["task_type", skill.taskTypes, 3], ["domain", skill.domains, 3], ["tag", skill.tags, 1],
    ];
    for (const [field, values, score] of fields) for (const value of values) {
      const matched = field === "role" ? value === request.roleId : field === "task_type" ? value === request.taskType :
        field === "domain" ? request.intent.canonicalDomains.includes(value) : [...tokens(value)].some(token => intentTokens.has(token));
      if (matched) { candidate.descriptionScore += score; candidate.evidence.push({ field, value, score }); }
    }
  }

  #scopeApplies(revision: MapRevision, ownerId: string, path: ResolveSkillConnectionsRequest["path"]): boolean {
    const targets = new Set([path.primaryTargetScopeId, ...path.affectedScopeIds]);
    return [...targets].some(target => this.#isAncestor(revision, ownerId, target));
  }

  #isAncestor(revision: MapRevision, ancestorId: string, targetId: string): boolean {
    const byId = new Map(revision.nodes.map(node => [node.scopeId, node])); let current: ScopeNode | undefined = byId.get(targetId);
    while (current !== undefined) { if (current.scopeId === ancestorId) return true; current = current.parentScopeId === undefined ? undefined : byId.get(current.parentScopeId); }
    return false;
  }

  #scopeRank(revision: MapRevision, scopeId: string): number { return revision.nodes.find(node => node.scopeId === scopeId)?.rank ?? -1; }
  #hasPermission(principal: ContextPrincipal, node: ScopeNode, permission: AbcmPermission): boolean {
    if (principal.access.workspacePermissions.includes(permission)) return true;
    const grants = principal.access.scopeGrants; if (grants?.[node.scopeId]?.includes(permission) === true) return true;
    return node.aliases.some(alias => grants?.[alias]?.includes(permission) === true);
  }
}
