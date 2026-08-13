import { createHash } from "node:crypto";

import { AbcmError } from "../core/errors.js";
import { observeOperation, type AbcmObservability } from "../core/observability.js";
import { throwIfAborted } from "../core/operation.js";
import type { DomainLanguageService } from "../domain-language/domain-language-service.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type { ScopePathResolver } from "../domain-language/scope-path-resolver.js";
import type { DocumentRecord, MapRevision, ScopeNode } from "../scope-map/types.js";
import type { SkillConnectionResolver } from "../skills/skill-connection-resolver.js";
import type { SkillContextRequirement } from "../skills/types.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type {
  BuildTaskContextRequest,
  ContextBudgetProfile,
  ContextBuilderOptions,
  ContextBundle,
  ContextFingerprint,
  ContextFingerprintDocument,
  ContextFingerprintStore,
  ContextOmission,
  DocumentProjectionMode,
  MaterializedDocumentProjection,
  SelectedContextDocument,
  SelectionReason,
} from "./types.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";

const PRIORITY: readonly SelectionReason[] = [
  "required_applicable", "operator_controlled_applicable", "role_required", "task_type_required", "explicit_link",
  "skill_required", "target_scope", "related_scope", "domain_or_entity_match", "semantic_or_keyword_match", "optional_background",
];
const DEFAULT_BUDGETS: Readonly<Record<string, ContextBudgetProfile>> = {
  default: { softLimitTokens: 8_000, hardLimitTokens: 12_000 },
  compact: { softLimitTokens: 2_000, hardLimitTokens: 4_000 },
  expanded: { softLimitTokens: 24_000, hardLimitTokens: 32_000 },
};

interface Candidate {
  document: DocumentRecord;
  reasons: Set<SelectionReason>;
  mandatory: boolean;
}

export interface ContextBuilderDependencies {
  files: WorkspaceFileService;
  scopeMap: ScopeMapService;
  domainLanguage: DomainLanguageService;
  scopePathResolver: ScopePathResolver;
  skillConnectionResolver: SkillConnectionResolver;
  fingerprintStore: ContextFingerprintStore;
  options?: ContextBuilderOptions;
  observability?: AbcmObservability;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function tokens(content: string): number {
  return Math.ceil(new TextEncoder().encode(content).byteLength / 4);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

function summary(content: string): string {
  const source = stripFrontmatter(content);
  const paragraph = source.split(/\r?\n\s*\r?\n/).map(part => part.trim()).find(part => part !== "" && !part.startsWith("#")) ?? source.trim();
  return paragraph.slice(0, 512);
}

function section(content: string): string {
  const source = stripFrontmatter(content);
  const match = /(^|\n)(#{1,6}\s+[^\n]+\n[\s\S]*?)(?=\n#{1,6}\s+|$)/.exec(source);
  return (match?.[2] ?? source.split(/\r?\n\s*\r?\n/)[0] ?? "").trim();
}

function projectionMode(document: DocumentRecord, roleId: string): DocumentProjectionMode {
  if (document.projectionPolicy !== undefined) return document.projectionPolicy;
  if (roleId.includes("quality-gate") || roleId.includes("reviewer")) return "section";
  return "full";
}

function projection(document: DocumentRecord, body: string, roleId: string): MaterializedDocumentProjection {
  const mode = projectionMode(document, roleId);
  const base = { mode, authoritative: mode === "full" || mode === "section", sourceDocumentId: document.documentId, sourceChecksum: document.checksum };
  if (mode === "full") return { ...base, content: body };
  if (mode === "section") return { ...base, content: section(body) };
  if (mode === "summary") return { ...base, authoritative: false, content: summary(body) };
  return { ...base, authoritative: false };
}

function documentId(link: string): string | undefined {
  return /^abcm:\/\/(?:artifact|document|plan|architecture)\/([^/?#]+)$/.exec(link)?.[1];
}

function hasDocumentAccess(principal: ContextPrincipal, node: ScopeNode): boolean {
  if (principal.access.workspacePermissions.includes("document.read")) return true;
  if (principal.access.scopeGrants?.[node.scopeId]?.includes("document.read") === true) return true;
  return node.aliases.some(alias => principal.access.scopeGrants?.[alias]?.includes("document.read") === true);
}

export class ContextBuilder {
  readonly #dependencies: ContextBuilderDependencies;
  readonly #budgets: Readonly<Record<string, ContextBudgetProfile>>;
  readonly #defaultBudget: string;

  constructor(dependencies: ContextBuilderDependencies) {
    this.#dependencies = dependencies;
    this.#budgets = { ...DEFAULT_BUDGETS, ...(dependencies.options?.budgetProfiles ?? {}) };
    this.#defaultBudget = dependencies.options?.defaultBudgetProfile ?? "default";
    for (const [name, budget] of Object.entries(this.#budgets)) {
      if (!Number.isSafeInteger(budget.softLimitTokens) || !Number.isSafeInteger(budget.hardLimitTokens) || budget.softLimitTokens < 0 || budget.hardLimitTokens <= 0 || budget.softLimitTokens > budget.hardLimitTokens) {
        throw new Error(`Context budget profile '${name}' is invalid.`);
      }
    }
    if (this.#budgets[this.#defaultBudget] === undefined) throw new Error("Default context budget profile is not configured.");
  }

  async build(request: BuildTaskContextRequest, principal: ContextPrincipal, signal?: AbortSignal): Promise<ContextBundle> {
    return observeOperation(this.#dependencies.observability, {
      operation: "context.build",
      principalId: principal.principalId,
      durationMetric: "abcm_context_build_duration_ms",
      successMetrics: result => {
        const bundle = result as ContextBundle;
        return [
          { name: "abcm_context_bundle_tokens", value: bundle.tokenEstimate, unit: "tokens", operation: "context.build", outcome: "success" },
          { name: "abcm_context_bundle_omissions", value: bundle.omissions.length, unit: "count", operation: "context.build", outcome: "success" },
        ];
      },
    }, () => this.#build(request, principal, signal));
  }

  async #build(request: BuildTaskContextRequest, principal: ContextPrincipal, signal?: AbortSignal): Promise<ContextBundle> {
    throwIfAborted(signal);
    if (!principal.access.workspacePermissions.includes("context.build") && !Object.values(principal.access.scopeGrants ?? {}).some(grants => grants.includes("context.build"))) {
      throw new AbcmError("ACCESS_DENIED", "Context build permission is required.");
    }
    const bootstrap = this.#dependencies.domainLanguage.validateBootstrap(request.domainLanguageBootstrapId, principal);
    if (bootstrap.roleId !== undefined && bootstrap.roleId !== request.roleId) {
      throw new AbcmError("CONTEXT_CONFIGURATION_INVALID", "Domain-language bootstrap role does not match the context build role.");
    }
    const revision = this.#dependencies.scopeMap.getActiveRevision(bootstrap.anchor.workspaceId);
    if (revision.revision !== bootstrap.mapRevision) throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_STALE", "Context build MapRevision changed after bootstrap creation.");
    const budgetName = request.budgetProfile ?? this.#defaultBudget;
    const budget = this.#budgets[budgetName];
    if (budget === undefined) throw new AbcmError("CONTEXT_CONFIGURATION_INVALID", `Unknown context budget profile '${budgetName}'.`);
    const path = await this.#dependencies.scopePathResolver.resolve({
      domainLanguageBootstrapId: request.domainLanguageBootstrapId,
      goal: request.goal,
      ...(request.canonicalDomains === undefined ? {} : { canonicalDomains: request.canonicalDomains }),
      ...(request.canonicalTerms === undefined ? {} : { canonicalTerms: request.canonicalTerms }),
      ...(request.keywords === undefined ? {} : { keywords: request.keywords }),
      ...(request.targetHints === undefined ? {} : { targetHints: request.targetHints }),
      ...(request.explicitLinks === undefined ? {} : { explicitLinks: request.explicitLinks }),
      ...(request.artifacts === undefined ? {} : { artifacts: request.artifacts }),
      ...(request.repositoryPaths === undefined ? {} : { repositoryPaths: request.repositoryPaths }),
    }, principal, signal);
    throwIfAborted(signal);
    const skills = await this.#dependencies.skillConnectionResolver.resolve({
      workspaceId: bootstrap.anchor.workspaceId,
      path,
      intent: path.normalizedIntent,
      roleId: request.roleId,
      taskType: request.taskType,
      ...(request.explicitLinks === undefined ? {} : { explicitSkillLinks: request.explicitLinks.filter(link => link.startsWith("abcm://skill/")) }),
      ...(request.requestedSkillIds === undefined ? {} : { requestedSkillIds: request.requestedSkillIds }),
      ...(request.approvalId === undefined ? {} : { approvalId: request.approvalId }),
    }, principal, signal);
    throwIfAborted(signal);
    const { candidates, omissions: lifecycleOmissions } = this.#collect(
      revision,
      bootstrap.anchor.projectId,
      path.scopeIds,
      path.affectedScopeIds,
      request,
      path.normalizedIntent.canonicalDomains,
      path.normalizedIntent.canonicalTerms,
      skills.contextRequirements,
    );
    const materialized: SelectedContextDocument[] = [];
    const omissions: ContextOmission[] = [...lifecycleOmissions];
    const nodes = new Map(revision.nodes.map(node => [node.scopeId, node]));
    const ordered = [...candidates.values()].sort((left, right) => Number(right.mandatory) - Number(left.mandatory) || this.#priority(left) - this.#priority(right) || left.document.documentId.localeCompare(right.document.documentId));
    for (const candidate of ordered) {
      throwIfAborted(signal);
      const node = nodes.get(candidate.document.scopeId);
      const reasons = this.#reasons(candidate);
      if (node === undefined || !hasDocumentAccess(principal, node)) {
        if (candidate.mandatory) throw new AbcmError("REQUIRED_CONTEXT_ACCESS_DENIED", `Mandatory document '${candidate.document.documentId}' is not readable.`, { documentId: candidate.document.documentId });
        omissions.push({ documentId: candidate.document.documentId, reason: "access_denied", selectionReasons: reasons });
        continue;
      }
      let source;
      try {
        source = await this.#dependencies.files.read(bootstrap.anchor.workspaceId, candidate.document.relativePath, signal);
      } catch (error) {
        if (candidate.mandatory && error instanceof AbcmError && error.code === "FILE_TOO_LARGE") {
          throw new AbcmError("REQUIRED_CONTEXT_EXCEEDS_LIMIT", `Mandatory document '${candidate.document.documentId}' exceeds the materialization limit.`, { documentId: candidate.document.documentId });
        }
        throw error;
      }
      if (source.entry.checksum !== candidate.document.checksum) throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_STALE", `Document '${candidate.document.documentId}' changed after map publication.`);
      const projected = projection(candidate.document, new TextDecoder().decode(source.content), request.roleId);
      const estimate = projected.content === undefined ? 0 : tokens(projected.content);
      materialized.push({
        documentId: candidate.document.documentId,
        kind: candidate.document.kind,
        title: candidate.document.title,
        scopeId: candidate.document.scopeId,
        relativePath: candidate.document.relativePath,
        checksum: candidate.document.checksum,
        mandatory: candidate.mandatory,
        effectivePriority: this.#priority(candidate),
        selectionReasons: reasons,
        projection: projected,
        tokenEstimate: estimate,
      });
    }
    const skillTokens = skills.connectedSkills.reduce((sum, skill) => sum + tokens(skill.body), 0);
    const mandatoryTokens = skillTokens + materialized.filter(item => item.mandatory).reduce((sum, item) => sum + item.tokenEstimate, 0);
    if (mandatoryTokens > budget.hardLimitTokens) {
      throw new AbcmError("REQUIRED_CONTEXT_EXCEEDS_LIMIT", "Mandatory context exceeds the hard token limit.", {
        hardLimitTokens: budget.hardLimitTokens,
        mandatoryTokens,
        documentIds: materialized.filter(item => item.mandatory).map(item => item.documentId),
      });
    }
    const selected: SelectedContextDocument[] = [];
    let tokenEstimate = skillTokens;
    for (const item of materialized) {
      if (!item.mandatory && tokenEstimate + item.tokenEstimate > budget.softLimitTokens) {
        omissions.push({ documentId: item.documentId, reason: "budget_exceeded", selectionReasons: item.selectionReasons });
        continue;
      }
      selected.push(item); tokenEstimate += item.tokenEstimate;
    }
    const orderedOmissions = omissions.sort((left, right) => left.documentId.localeCompare(right.documentId) || left.reason.localeCompare(right.reason));
    const digestInput = {
      mapRevision: revision.revision,
      mapDigest: revision.digest,
      domainLanguageBootstrapDigest: bootstrap.bootstrapDigest,
      domainLanguageSources: path.domainLanguageSources,
      roleId: request.roleId,
      taskType: request.taskType,
      budgetProfile: budgetName,
      budget,
      resolvedScopePath: path,
      connectedSkills: skills.connectedSkills,
      selectedDocuments: selected,
      omissions: orderedOmissions,
    };
    const bundleDigest = digest(digestInput);
    const contextBundleId = `context-${bundleDigest.slice("sha256:".length, "sha256:".length + 24)}`;
    const fingerprintIdentityDigest = digest({ bundleDigest, principalId: principal.principalId });
    const fingerprintId = `fingerprint-${fingerprintIdentityDigest.slice("sha256:".length, "sha256:".length + 24)}`;
    const fingerprintDocuments: ContextFingerprintDocument[] = selected.map(item => ({
      documentId: item.documentId, scopeId: item.scopeId, relativePath: item.relativePath, checksum: item.checksum,
      mandatory: item.mandatory, effectivePriority: item.effectivePriority, selectionReasons: item.selectionReasons,
      projection: { mode: item.projection.mode, authoritative: item.projection.authoritative, sourceDocumentId: item.projection.sourceDocumentId, sourceChecksum: item.projection.sourceChecksum },
      tokenEstimate: item.tokenEstimate,
    }));
    const fingerprint: ContextFingerprint = {
      fingerprintId,
      workspaceId: bootstrap.anchor.workspaceId,
      principalId: principal.principalId,
      mapRevision: revision.revision,
      mapDigest: revision.digest,
      domainLanguageBootstrapId: bootstrap.bootstrapId,
      domainLanguageBootstrapDigest: bootstrap.bootstrapDigest,
      domainLanguageSources: path.domainLanguageSources,
      configurationDigests: [digest({ budgetProfile: budgetName, budget })],
      roleId: request.roleId,
      taskType: request.taskType,
      primaryTargetScope: path.primaryTargetScopeId,
      affectedScopes: path.affectedScopeIds,
      connectedSkills: skills.connectedSkills.map(skill => ({
        skillId: skill.skillId, skillDigest: skill.skillDigest, strategy: skill.strategy,
        connectionReasons: skill.connectionReasons, ...(skill.approvalId === undefined ? {} : { approvalId: skill.approvalId }),
      })),
      budgetProfile: budgetName,
      budget,
      bundleDigest,
      tokenEstimate,
      selectedDocuments: fingerprintDocuments,
    };
    throwIfAborted(signal);
    const contextFingerprintLocation = await this.#dependencies.fingerprintStore.write(bootstrap.anchor.workspaceId, request.execution, fingerprint);
    return deepFreeze({
      contextBundleId,
      bundleDigest,
      mapRevision: revision.revision,
      mapDigest: revision.digest,
      domainLanguageBootstrapId: bootstrap.bootstrapId,
      domainLanguageBootstrapDigest: bootstrap.bootstrapDigest,
      roleId: request.roleId,
      taskType: request.taskType,
      budgetProfile: budgetName,
      budget,
      primaryTargetScope: path.primaryTargetScopeId,
      affectedScopes: path.affectedScopeIds,
      resolvedScopePath: path,
      skillConnectionReasons: Object.fromEntries(skills.connectedSkills.map(skill => [skill.skillId, skill.connectionReasons])),
      connectedSkills: skills.connectedSkills,
      selectedDocuments: selected,
      selectionReasons: Object.fromEntries(selected.map(item => [item.documentId, item.selectionReasons])),
      warnings: skills.diagnostics.map(item => ({ code: item.code, subjectId: item.skillId })),
      conflicts: [],
      omissions: orderedOmissions,
      tokenEstimate,
      contextFingerprintLocation,
    });
  }

  #collect(
    revision: MapRevision,
    projectId: string,
    pathScopeIds: readonly string[],
    affectedScopeIds: readonly string[],
    request: BuildTaskContextRequest,
    canonicalDomains: readonly string[],
    canonicalTerms: readonly string[],
    requirements: readonly SkillContextRequirement[],
  ) {
    const candidates = new Map<string, Candidate>();
    const omissions: ContextOmission[] = [];
    const pathScopes = new Set(pathScopeIds);
    const affected = new Set(affectedScopeIds);
    const explicitLinks = [...(request.explicitDocumentLinks ?? []), ...(request.explicitLinks ?? []).filter(link => !link.startsWith("abcm://skill/") && documentId(link) !== undefined)];
    const explicitIds = new Set<string>();
    for (const link of explicitLinks) {
      const id = documentId(link);
      if (id === undefined || !revision.documents.some(document => document.documentId === id)) {
        throw new AbcmError("CONTEXT_CONFIGURATION_INVALID", `Required document link '${link}' did not resolve.`, { link });
      }
      explicitIds.add(id);
    }
    for (const requirement of requirements.filter(item => item.kind === "explicit_link")) {
      const id = documentId(requirement.value);
      if (id === undefined || !revision.documents.some(document => document.documentId === id)) {
        throw new AbcmError("CONTEXT_CONFIGURATION_INVALID", `Skill-required document link '${requirement.value}' did not resolve.`, { link: requirement.value, skillId: requirement.sourceSkillId });
      }
      explicitIds.add(id);
    }
    const requiredKinds = new Set(requirements.filter(item => item.kind === "document_kind").map(item => item.value));
    const requiredTags = new Set(requirements.filter(item => item.kind === "tag").map(item => item.value));
    const nodeById = new Map(revision.nodes.map(node => [node.scopeId, node]));
    const inProject = (scopeId: string): boolean => {
      let node = nodeById.get(scopeId);
      while (node !== undefined) {
        if (node.scopeId === projectId) return true;
        node = node.parentScopeId === undefined ? undefined : nodeById.get(node.parentScopeId);
      }
      return false;
    };
    const keywordSet = new Set((request.keywords ?? []).map(value => value.toLocaleLowerCase("en-US")));
    const canonicalSet = new Set([...canonicalDomains, ...canonicalTerms]);
    for (const document of revision.documents) {
      const reasons = new Set<SelectionReason>();
      const explicitlyLinked = explicitIds.has(document.documentId);
      const applicableBoundary = pathScopes.has(document.scopeId) || affected.has(document.scopeId) || inProject(document.scopeId);
      if (!applicableBoundary && !explicitlyLinked) continue;
      if (document.requiredSelectors.includes("always")) reasons.add("required_applicable");
      if (document.contextPolicy === "operator" || document.contextPolicy === "operator-controlled") reasons.add("operator_controlled_applicable");
      if (document.requiredSelectors.includes(request.roleId)) reasons.add("role_required");
      if (document.requiredSelectors.includes(request.taskType)) reasons.add("task_type_required");
      if (document.taskSelectors.includes(request.taskType)) reasons.add("task_type_required");
      if (explicitlyLinked) reasons.add("explicit_link");
      if (requiredKinds.has(document.kind) || (document.tags ?? []).some(tag => requiredTags.has(tag))) reasons.add("skill_required");
      const mandatory = [...reasons].some(reason => PRIORITY.indexOf(reason) <= PRIORITY.indexOf("skill_required"));
      if (document.lifecycle === "deleted" || document.lifecycle === "archived" || document.lifecycle === "superseded") {
        if (mandatory) omissions.push({ documentId: document.documentId, reason: "lifecycle_excluded", selectionReasons: [...reasons].sort((left, right) => PRIORITY.indexOf(left) - PRIORITY.indexOf(right)) });
        continue;
      }
      if (!mandatory) {
        if (document.contextPolicy === "explicit-only") continue;
        if (document.roleSelectors.length > 0 && !document.roleSelectors.includes(request.roleId)) continue;
        if (document.taskSelectors.length > 0 && !document.taskSelectors.includes(request.taskType)) continue;
        if (pathScopes.has(document.scopeId)) reasons.add("target_scope");
        else if (affected.has(document.scopeId)) reasons.add("related_scope");
        else if (inProject(document.scopeId) && document.domain !== undefined && canonicalSet.has(document.domain)) reasons.add("domain_or_entity_match");
        else {
          const metadataTokens = new Set(`${document.documentId} ${document.kind} ${document.title} ${(document.tags ?? []).join(" ")}`.toLocaleLowerCase("en-US").split(/[^a-z0-9.-]+/).filter(Boolean));
          if (inProject(document.scopeId) && [...keywordSet].some(keyword => metadataTokens.has(keyword))) reasons.add("semantic_or_keyword_match");
          else continue;
        }
      }
      candidates.set(document.documentId, { document, reasons, mandatory });
    }
    return { candidates, omissions };
  }

  #priority(candidate: Candidate): number {
    return Math.min(...[...candidate.reasons].map(reason => PRIORITY.indexOf(reason)));
  }

  #reasons(candidate: Candidate): SelectionReason[] {
    return [...candidate.reasons].sort((left, right) => PRIORITY.indexOf(left) - PRIORITY.indexOf(right));
  }
}
