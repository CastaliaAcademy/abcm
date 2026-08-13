import { createHash, randomUUID } from "node:crypto";
import { readFile, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { promisify } from "node:util";

import { z } from "zod/v4";
import { parse } from "yaml";

import { AbcmError } from "../core/errors.js";
import { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { AbcmPermission, MapRevision, ScopeNode } from "../scope-map/types.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type {
  ConceptDefinition,
  ContextPrincipal,
  DomainAlias,
  DomainDefinition,
  DomainHomonym,
  DomainLanguageBootstrap,
  DomainLanguageBootstrapRequest,
  DomainLanguageSource,
  EffectiveDomainLanguage,
} from "./types.js";

const readFileAsync = promisify(readFile);
const STRUCTURED_FILES = ["domains.yaml", "glossary.yaml", "aliases.yaml", "naming.yaml"] as const;

const id = z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/);
const conventionSchema = z.object({
  apiVersion: z.literal("abcm/v1").optional(),
  kind: z.literal("DomainLanguageConvention").optional(),
  mode: z.enum(["inherit-only", "extend"]),
}).strict();
const domainsSchema = z.object({
  apiVersion: z.literal("abcm/v1"),
  kind: z.literal("DomainLanguageDomains"),
  domains: z.array(z.object({
    id,
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    locked: z.boolean().default(false),
  }).strict()).default([]),
}).strict();
const glossarySchema = z.object({
  apiVersion: z.literal("abcm/v1"),
  kind: z.literal("DomainLanguageGlossary"),
  concepts: z.array(z.object({
    id,
    domainId: id,
    term: z.string().min(1),
    definition: z.string().min(1).optional(),
    locked: z.boolean().default(false),
  }).strict()).default([]),
}).strict();
const aliasesSchema = z.object({
  apiVersion: z.literal("abcm/v1"),
  kind: z.literal("DomainLanguageAliases"),
  aliases: z.array(z.object({
    term: z.string().min(1),
    canonicalTerm: id,
    deprecated: z.boolean().default(false),
  }).strict()).default([]),
  homonyms: z.array(z.object({
    term: z.string().min(1),
    canonicalTerms: z.array(id).min(1),
  }).strict()).default([]),
}).strict();
const namingSchema = z.object({
  apiVersion: z.literal("abcm/v1"),
  kind: z.literal("DomainLanguageNaming"),
  rules: z.record(z.string(), z.string()).default({}),
}).strict();

interface MutableLanguage {
  domains: Map<string, DomainDefinition>;
  concepts: Map<string, ConceptDefinition>;
  aliases: Map<string, DomainAlias>;
  homonyms: Map<string, DomainHomonym>;
  namingRules: Map<string, string>;
}

interface StoredBootstrap {
  bootstrap: DomainLanguageBootstrap;
  principalId: string;
  workspaceRoot: string;
}

export interface DomainLanguageServiceOptions {
  bootstrapTtlMs?: number;
  now?: () => Date;
}

function checksum(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function frontmatter(source: string): unknown {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (match === null) throw new Error("DomainLanguageConvention.md requires YAML frontmatter.");
  return parse(match[1] ?? "");
}

function equalDefinition(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class DomainLanguageService {
  readonly #registry: WorkspaceRegistry;
  readonly #scopeMap: ScopeMapService;
  readonly #ttlMs: number;
  readonly #now: () => Date;
  readonly #bootstraps = new Map<string, StoredBootstrap>();

  constructor(registry: WorkspaceRegistry, scopeMap: ScopeMapService, options: DomainLanguageServiceOptions = {}) {
    this.#registry = registry;
    this.#scopeMap = scopeMap;
    this.#ttlMs = options.bootstrapTtlMs ?? 300_000;
    this.#now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) throw new Error("bootstrapTtlMs must be a positive integer.");
  }

  async createBootstrap(
    request: DomainLanguageBootstrapRequest,
    principal: ContextPrincipal,
  ): Promise<DomainLanguageBootstrap> {
    const revision = this.#scopeMap.getActiveRevision(request.anchor.workspaceId);
    const project = this.#resolveProject(revision, request.anchor.projectId);
    const workflow = revision.nodes.find(node => node.kind === "workflow" && node.status === "valid");
    if (workflow === undefined) throw new AbcmError("PROJECT_ANCHOR_NOT_RESOLVED", "Workflow anchor is not available.");
    for (const node of [workflow, project]) {
      for (const permission of ["scope.discover", "scope.read_metadata", "context.build"] as const) {
        if (!this.#hasPermission(principal, node, permission)) {
          throw new AbcmError("ACCESS_DENIED", "Domain-language bootstrap access is denied.", {
            scopeId: node.scopeId,
            permission,
          });
        }
      }
    }

    const workspace = this.#registry.get(request.anchor.workspaceId);
    const language: MutableLanguage = {
      domains: new Map(),
      concepts: new Map(),
      aliases: new Map(),
      homonyms: new Map(),
      namingRules: new Map(),
    };
    const sources: DomainLanguageSource[] = [];
    try {
      for (const node of [workflow, project]) await this.#mergeScope(workspace.root, revision, node, language, sources);
      this.#validateReferences(language);
    } catch (error) {
      if (error instanceof AbcmError) throw error;
      throw new AbcmError("DOMAIN_LANGUAGE_CONFIGURATION_INVALID", "Domain-language configuration is invalid.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const effectiveLanguage = this.#materialize(language);
    const anchor = { workspaceId: request.anchor.workspaceId, projectId: project.scopeId };
    const digestInput = {
      principalId: principal.principalId,
      anchor,
      roleId: request.roleId ?? null,
      projection: "agent",
      mapRevision: revision.revision,
      sources,
      effectiveLanguage,
    };
    const now = this.#now();
    const bootstrap: DomainLanguageBootstrap = {
      bootstrapId: `dlb-${randomUUID()}`,
      bootstrapDigest: stableDigest(digestInput),
      anchor,
      ...(request.roleId === undefined ? {} : { roleId: request.roleId }),
      projection: "agent",
      mapRevision: revision.revision,
      sourceConventions: sources,
      effectiveLanguage,
      readiness: "ready",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#ttlMs).toISOString(),
    };
    this.#bootstraps.set(bootstrap.bootstrapId, { bootstrap, principalId: principal.principalId, workspaceRoot: workspace.root });
    return bootstrap;
  }

  validateBootstrap(bootstrapId: string, principal: ContextPrincipal): DomainLanguageBootstrap {
    const stored = this.#bootstraps.get(bootstrapId);
    if (stored === undefined) {
      throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_REQUIRED", "Domain-language bootstrap does not exist.");
    }
    if (stored.principalId !== principal.principalId) {
      throw new AbcmError("ACCESS_DENIED", "Domain-language bootstrap belongs to a different principal.");
    }
    const bootstrap = stored.bootstrap;
    if (Date.parse(bootstrap.expiresAt) <= this.#now().getTime()) {
      throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_STALE", "Domain-language bootstrap has expired.");
    }
    const revision = this.#scopeMap.getActiveRevision(bootstrap.anchor.workspaceId);
    if (revision.revision !== bootstrap.mapRevision) {
      throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_STALE", "ScopeMap revision changed after bootstrap creation.");
    }
    for (const source of bootstrap.sourceConventions) {
      try {
        const content = new Uint8Array(readFileSync(join(stored.workspaceRoot, source.relativePath)));
        if (checksum(content) !== source.checksum) throw new Error("checksum mismatch");
      } catch {
        throw new AbcmError("DOMAIN_LANGUAGE_BOOTSTRAP_STALE", "Domain-language source changed after bootstrap creation.", {
          path: source.relativePath,
        });
      }
    }
    return bootstrap;
  }

  async #mergeScope(
    workspaceRoot: string,
    revision: MapRevision,
    node: ScopeNode,
    language: MutableLanguage,
    sources: DomainLanguageSource[],
  ): Promise<void> {
    const base = node.relativePath === "" ? "domain-language" : posix.join(node.relativePath, "domain-language");
    const conventionPath = posix.join(base, "DomainLanguageConvention.md");
    const conventionSource = await this.#readPinned(workspaceRoot, revision, node, conventionPath, true, sources);
    const convention = conventionSchema.parse(frontmatter(new TextDecoder().decode(conventionSource)));
    const structured: Array<{ path: string; content: Uint8Array }> = [];
    for (const name of STRUCTURED_FILES) {
      const path = posix.join(base, name);
      const content = await this.#readPinned(workspaceRoot, revision, node, path, false, sources);
      if (content !== undefined) structured.push({ path, content });
    }
    if (convention.mode === "inherit-only" && structured.length > 0) {
      throw new Error(`Inherit-only scope '${node.scopeId}' cannot define structured domain language.`);
    }
    for (const source of structured) {
      const value = parse(new TextDecoder().decode(source.content));
      if (source.path.endsWith("domains.yaml")) {
        for (const domain of domainsSchema.parse(value).domains) this.#mergeLocked(language.domains, domain, node.scopeId);
      } else if (source.path.endsWith("glossary.yaml")) {
        for (const concept of glossarySchema.parse(value).concepts) this.#mergeLocked(language.concepts, concept, node.scopeId);
      } else if (source.path.endsWith("aliases.yaml")) {
        const aliases = aliasesSchema.parse(value);
        for (const alias of aliases.aliases) {
          const previous = language.aliases.get(alias.term);
          if (previous !== undefined && previous.canonicalTerm !== alias.canonicalTerm) {
            throw new Error(`Alias '${alias.term}' is ambiguous.`);
          }
          language.aliases.set(alias.term, alias);
        }
        for (const homonym of aliases.homonyms) language.homonyms.set(homonym.term, {
          ...homonym,
          canonicalTerms: [...homonym.canonicalTerms].sort(),
        });
      } else {
        const naming = namingSchema.parse(value);
        for (const [key, rule] of Object.entries(naming.rules)) language.namingRules.set(key, rule);
      }
    }
  }

  async #readPinned(
    workspaceRoot: string,
    revision: MapRevision,
    node: ScopeNode,
    relativePath: string,
    required: true,
    sources: DomainLanguageSource[],
  ): Promise<Uint8Array>;
  async #readPinned(
    workspaceRoot: string,
    revision: MapRevision,
    node: ScopeNode,
    relativePath: string,
    required: false,
    sources: DomainLanguageSource[],
  ): Promise<Uint8Array | undefined>;
  async #readPinned(
    workspaceRoot: string,
    revision: MapRevision,
    node: ScopeNode,
    relativePath: string,
    required: boolean,
    sources: DomainLanguageSource[],
  ): Promise<Uint8Array | undefined> {
    const record = revision.files.find(file => file.scopeId === node.scopeId && file.relativePath === relativePath);
    if (record === undefined) {
      if (required) throw new Error(`Required convention '${relativePath}' is missing from the pinned map.`);
      return undefined;
    }
    const content = new Uint8Array(await readFileAsync(join(workspaceRoot, relativePath)));
    if (checksum(content) !== record.checksum) throw new Error(`Pinned source '${relativePath}' changed during bootstrap construction.`);
    sources.push({ scopeId: node.scopeId, relativePath, checksum: record.checksum });
    return content;
  }

  #mergeLocked<T extends { id: string; locked: boolean }>(target: Map<string, T>, value: T, scopeId: string): void {
    const previous = target.get(value.id);
    if (previous?.locked === true && !equalDefinition(previous, value)) {
      throw new Error(`Scope '${scopeId}' overrides locked definition '${value.id}'.`);
    }
    target.set(value.id, value);
  }

  #validateReferences(language: MutableLanguage): void {
    for (const concept of language.concepts.values()) {
      if (!language.domains.has(concept.domainId)) throw new Error(`Concept '${concept.id}' references unknown domain '${concept.domainId}'.`);
    }
    for (const alias of language.aliases.values()) {
      if (!language.concepts.has(alias.canonicalTerm)) throw new Error(`Alias '${alias.term}' references unknown concept '${alias.canonicalTerm}'.`);
    }
    for (const homonym of language.homonyms.values()) {
      for (const canonical of homonym.canonicalTerms) {
        if (!language.concepts.has(canonical)) throw new Error(`Homonym '${homonym.term}' references unknown concept '${canonical}'.`);
      }
    }
  }

  #materialize(language: MutableLanguage): EffectiveDomainLanguage {
    return {
      domains: [...language.domains.values()].sort((left, right) => left.id.localeCompare(right.id)),
      concepts: [...language.concepts.values()].sort((left, right) => left.id.localeCompare(right.id)),
      aliases: [...language.aliases.values()].sort((left, right) => left.term.localeCompare(right.term)),
      homonyms: [...language.homonyms.values()].sort((left, right) => left.term.localeCompare(right.term)),
      namingRules: Object.fromEntries([...language.namingRules.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
  }

  #resolveProject(revision: MapRevision, requested: string): ScopeNode {
    const projects = revision.nodes.filter(node => node.kind === "project" && node.status === "valid");
    const matches = projects.filter(node => node.scopeId === requested || node.aliases.includes(requested));
    if (matches.length !== 1) {
      throw new AbcmError("PROJECT_ANCHOR_NOT_RESOLVED", "Project anchor did not resolve to one valid project.", {
        projectId: requested,
      });
    }
    return matches[0]!;
  }

  #hasPermission(principal: ContextPrincipal, node: ScopeNode, permission: AbcmPermission): boolean {
    if (principal.access.workspacePermissions.includes(permission)) return true;
    const grants = principal.access.scopeGrants;
    if (grants?.[node.scopeId]?.includes(permission) === true) return true;
    return node.aliases.some(alias => grants?.[alias]?.includes(permission) === true);
  }
}
