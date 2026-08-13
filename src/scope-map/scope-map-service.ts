import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";

import { z } from "zod/v4";
import { parse } from "yaml";

import { AbcmError } from "../core/errors.js";
import type { ScopeMapStore } from "../derived-store/types.js";
import type { DocumentationStateStore } from "../documentation/types.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { ResolvedWorkspace } from "../workspace/types.js";
import {
  indexScopeContent,
  resolveDocumentCandidates,
  type ScopeContentIndex,
} from "./content-indexer.js";
import { indexExplicitRelations } from "./explicit-relations.js";
import type {
  DocumentRecord,
  ExecutableResourceRecord,
  FileRecord,
  MapDiagnostic,
  MapRevision,
  MapRevisionSummary,
  ScopeKind,
  ScopeMapProjection,
  ScopeMapChanged,
  ScopeMapChangedListener,
  ScopeNode,
  ScopeRelation,
} from "./types.js";

const SCOPE_KINDS = ["workflow", "project", "service", "feature"] as const;
const RESERVED_SCOPE_DIRECTORIES = new Set([".abcm", "config", "domain-language", "agents", "artifacts", "architecture"]);

const scopeManifestSchema = z
  .object({
    apiVersion: z.literal("abcm/v1"),
    kind: z.enum(SCOPE_KINDS),
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    name: z.string().min(1).max(160),
    aliases: z.array(z.string()).default([]),
    status: z.string().optional(),
    owner: z.unknown().optional(),
    tags: z.array(z.string()).optional(),
    description: z.string().optional(),
  })
  .strict();

type ScopeManifest = z.infer<typeof scopeManifestSchema>;
type ContentIndexer = (workspace: ResolvedWorkspace, scope: ScopeNode) => Promise<ScopeContentIndex>;

export interface ScopeMapServiceOptions {
  contentIndexer?: ContentIndexer;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function rankOf(kind: ScopeKind): number {
  return SCOPE_KINDS.indexOf(kind);
}

function normalizedDigest(
  nodes: readonly ScopeNode[],
  relations: readonly ScopeRelation[],
  files: readonly FileRecord[],
  documents: readonly DocumentRecord[],
  executableResources: readonly ExecutableResourceRecord[],
  diagnostics: readonly MapDiagnostic[],
): string {
  const normalized = JSON.stringify({ nodes, relations, files, documents, executableResources, diagnostics });
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

export class ScopeMapService {
  readonly #registry: WorkspaceRegistry;
  readonly #store: ScopeMapStore | undefined;
  readonly #documentationState: DocumentationStateStore | undefined;
  readonly #active = new Map<string, MapRevision>();
  readonly #scanTails = new Map<string, Promise<void>>();
  readonly #contentIndexer: ContentIndexer;
  readonly #listeners = new Set<ScopeMapChangedListener>();

  constructor(
    registry: WorkspaceRegistry,
    store?: ScopeMapStore,
    documentationState?: DocumentationStateStore,
    options: ScopeMapServiceOptions = {},
  ) {
    this.#registry = registry;
    this.#store = store;
    this.#documentationState = documentationState;
    this.#contentIndexer = options.contentIndexer ?? indexScopeContent;
  }

  scan(workspaceId: string): Promise<MapRevision> {
    return this.#enqueue(workspaceId, () => this.#scanOnce(workspaceId));
  }

  reconcile(workspaceId: string, changedPaths: readonly string[]): Promise<MapRevision> {
    return this.#enqueue(workspaceId, () => this.#scanOnce(workspaceId, changedPaths));
  }

  subscribe(listener: ScopeMapChangedListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #enqueue(workspaceId: string, operation: () => Promise<MapRevision>): Promise<MapRevision> {
    const previous = this.#scanTails.get(workspaceId) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#scanTails.set(workspaceId, tail);
    void tail.then(() => {
      if (this.#scanTails.get(workspaceId) === tail) this.#scanTails.delete(workspaceId);
    });
    return result;
  }

  async #scanOnce(workspaceId: string, changedPaths?: readonly string[]): Promise<MapRevision> {
    const store = this.#store;
    let lease = store?.beginScan(workspaceId);
    let renewalError: unknown;
    const heartbeat =
      lease === undefined || store === undefined
        ? undefined
        : setInterval(() => {
            if (renewalError !== undefined || lease === undefined) return;
            try {
              lease = store.renew(lease);
            } catch (error) {
              renewalError = error;
            }
          }, store.scanLeaseRenewalIntervalMs);
    heartbeat?.unref();
    try {
      const previous = this.#active.get(workspaceId);
      const revision =
        changedPaths === undefined ? await this.#build(workspaceId) : await this.#buildIncremental(workspaceId, changedPaths);
      if (renewalError !== undefined) throw renewalError;
      if (lease !== undefined) store?.publish(lease, revision);
      this.#active.set(workspaceId, revision);
      this.#emitChanged(workspaceId, previous, revision);
      return revision;
    } catch (error) {
      if (lease !== undefined) {
        try {
          store?.fail(lease);
        } catch {
          // Preserve the scan/publication failure; the lease expires and remains fenced.
        }
      }
      throw error;
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat);
    }
  }

  async #build(workspaceId: string): Promise<MapRevision> {
    const workspace = this.#registry.get(workspaceId);
    const rootManifest = await this.#readManifest(workspace.root, "", true);
    if (rootManifest.kind !== "workflow") {
      throw new AbcmError("WORKSPACE_ROOT_MUST_BE_WORKFLOW", "Workspace root scope must have kind=workflow.", {
        actual: rootManifest.kind,
      });
    }

    const nodes: ScopeNode[] = [];
    const relations: ScopeRelation[] = [];
    const diagnostics: MapDiagnostic[] = [];
    const seenIds = new Set<string>();
    const rootNode = await this.#node(rootManifest, "", undefined, "valid", workspace.root, diagnostics);
    nodes.push(rootNode);
    seenIds.add(rootNode.scopeId);

    const walk = async (parent: ScopeNode, absoluteDirectory: string): Promise<void> => {
      const children = await readdir(absoluteDirectory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        if (workspace.deniedDirectories.has(child.name) || RESERVED_SCOPE_DIRECTORIES.has(child.name)) continue;
        const childAbsolute = join(absoluteDirectory, child.name);
        const manifestPath = join(childAbsolute, "scope.yaml");
        if (!(await exists(manifestPath))) continue;
        const childRelative = parent.relativePath === "" ? child.name : posix.join(parent.relativePath, child.name);

        let manifest: ScopeManifest;
        try {
          manifest = await this.#readManifest(childAbsolute, childRelative, false);
        } catch (error) {
          diagnostics.push({
            code: "SCOPE_MANIFEST_INVALID",
            severity: "scope_error",
            path: childRelative,
            message: error instanceof Error ? error.message : "Invalid scope manifest.",
          });
          continue;
        }

        const expectedRank = parent.rank + 1;
        let status: "valid" | "invalid" = "valid";
        if (rankOf(manifest.kind) !== expectedRank || expectedRank >= SCOPE_KINDS.length) {
          status = "invalid";
          diagnostics.push({
            code: "SCOPE_HIERARCHY_INVALID",
            severity: "branch_error",
            path: childRelative,
            scopeId: manifest.id,
            message: `Scope kind '${manifest.kind}' cannot be a child of '${parent.kind}'.`,
          });
        } else if (seenIds.has(manifest.id) || manifest.aliases.some(alias => seenIds.has(alias))) {
          status = "invalid";
          diagnostics.push({
            code: "SCOPE_ID_DUPLICATE",
            severity: "scope_error",
            path: childRelative,
            scopeId: manifest.id,
            message: `Scope id or alias '${manifest.id}' is duplicated.`,
          });
        }

        const childNode = await this.#node(manifest, childRelative, parent.scopeId, status, childAbsolute, diagnostics);
        nodes.push(childNode);
        relations.push({
          fromId: parent.scopeId,
          toId: childNode.scopeId,
          relationType: "parent-child",
          source: "physical-hierarchy",
          status: "resolved",
        });
        if (status === "valid") {
          seenIds.add(manifest.id);
          for (const alias of manifest.aliases) seenIds.add(alias);
          await walk(childNode, childAbsolute);
        }
      }
    };

    await walk(rootNode, workspace.root);
    nodes.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const files: FileRecord[] = [];
    const documentCandidates: DocumentRecord[] = [];
    const executableResources: ExecutableResourceRecord[] = [];
    const indexes = await Promise.all(
      nodes.filter(node => node.status === "valid").map(node => this.#contentIndexer(workspace, node)),
    );
    for (const index of indexes) {
      files.push(...index.files);
      documentCandidates.push(...index.documentCandidates);
      executableResources.push(...index.executableResources);
    }
    if (this.#documentationState !== undefined) {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (file === undefined) continue;
        const storage = this.#documentationState.resolveDocumentStorage(workspaceId, file.relativePath);
        files[index] = { ...file, ...storage };
      }
      for (let index = 0; index < documentCandidates.length; index++) {
        const document = documentCandidates[index];
        if (document === undefined) continue;
        const storage = this.#documentationState.resolveDocumentStorage(workspaceId, document.relativePath);
        documentCandidates[index] = { ...document, ...storage };
      }
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    executableResources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const documents = resolveDocumentCandidates(documentCandidates, diagnostics);
    const explicit = await indexExplicitRelations(workspace, nodes, documents, diagnostics);
    relations.push(...explicit.relations);
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node !== undefined && explicit.warningScopeIds.has(node.scopeId)) nodes[index] = { ...node, readiness: "warning" };
    }
    relations.sort((left, right) =>
      `${left.fromId}/${left.toId}/${left.relationType}/${left.source}`.localeCompare(
        `${right.fromId}/${right.toId}/${right.relationType}/${right.source}`,
      ),
    );
    diagnostics.sort((left, right) => `${left.path}/${left.code}`.localeCompare(`${right.path}/${right.code}`));
    const digest = normalizedDigest(nodes, relations, files, documents, executableResources, diagnostics);
    const revision: MapRevision = {
      revision: digest,
      digest,
      createdAt: new Date().toISOString(),
      nodes,
      relations,
      files,
      documents,
      executableResources,
      diagnostics,
    };
    return revision;
  }

  async #buildIncremental(workspaceId: string, changedPaths: readonly string[]): Promise<MapRevision> {
    const previous = this.#active.get(workspaceId);
    const normalizedPaths = this.#normalizeChangedPaths(changedPaths);
    if (
      previous === undefined ||
      normalizedPaths === undefined ||
      normalizedPaths.length === 0 ||
      normalizedPaths.some(path => posix.basename(path) === "scope.yaml") ||
      previous.diagnostics.some(diagnostic => diagnostic.code === "DOCUMENT_ID_DUPLICATE")
    ) {
      return this.#build(workspaceId);
    }

    const workspace = this.#registry.get(workspaceId);
    const validNodes = previous.nodes.filter(node => node.status === "valid");
    const nodesById = new Map(validNodes.map(node => [node.scopeId, node]));
    const changedScopeIds = new Set<string>();
    const readinessRoots = new Set<string>();
    for (const path of normalizedPaths) {
      const scope = this.#nearestScope(validNodes, path);
      if (scope === undefined) return this.#build(workspaceId);
      changedScopeIds.add(scope.scopeId);
      const insideScope = scope.relativePath === "" ? path : path.slice(scope.relativePath.length + 1);
      if (insideScope === "domain-language" || insideScope.startsWith("domain-language/")) {
        readinessRoots.add(scope.scopeId);
      }
    }

    const impacted = new Set(changedScopeIds);
    for (const node of validNodes) {
      if (node.parentScopeId !== undefined && changedScopeIds.has(node.parentScopeId)) impacted.add(node.scopeId);
      if (this.#isDescendantOf(node, readinessRoots, nodesById)) impacted.add(node.scopeId);
    }

    const indexed = new Map<string, ScopeContentIndex>();
    while (true) {
      for (const scopeId of impacted) {
        if (indexed.has(scopeId)) continue;
        const node = nodesById.get(scopeId);
        if (node === undefined) continue;
        const content = await this.#contentIndexer(workspace, node);
        const documentationState = this.#documentationState;
        if (documentationState !== undefined) {
          content.files = content.files.map(file => ({
            ...file,
            ...documentationState.resolveDocumentStorage(workspaceId, file.relativePath),
          }));
          content.documentCandidates = content.documentCandidates.map(document => ({
            ...document,
            ...documentationState.resolveDocumentStorage(workspaceId, document.relativePath),
          }));
        }
        indexed.set(scopeId, content);
      }

      const targetIds = new Set<string>();
      for (const node of validNodes.filter(node => impacted.has(node.scopeId))) {
        targetIds.add(node.scopeId);
        for (const alias of node.aliases) targetIds.add(alias);
      }
      for (const document of previous.documents.filter(document => impacted.has(document.scopeId))) {
        targetIds.add(document.documentId);
      }
      for (const content of indexed.values()) {
        for (const document of content.documentCandidates) {
          targetIds.add(document.documentId);
          for (const previousDocument of previous.documents) {
            if (previousDocument.documentId === document.documentId) impacted.add(previousDocument.scopeId);
          }
        }
      }

      let expanded = false;
      for (const relation of previous.relations) {
        if (relation.relationType === "parent-child") continue;
        const stableTarget = /^abcm:\/\/(?:scope|artifact|plan|architecture)\/([^/?#]+)$/.exec(relation.toId)?.[1] ?? relation.toId;
        if (targetIds.has(stableTarget) && !impacted.has(relation.fromId) && nodesById.has(relation.fromId)) {
          impacted.add(relation.fromId);
          expanded = true;
        }
      }
      if (!expanded && [...impacted].every(scopeId => indexed.has(scopeId))) break;
    }

    const diagnostics = previous.diagnostics.filter(
      diagnostic => diagnostic.code !== "DOCUMENT_ID_DUPLICATE" &&
        (diagnostic.scopeId === undefined || !impacted.has(diagnostic.scopeId)),
    );
    const nodes = await Promise.all(
      previous.nodes.map(node =>
        node.status === "valid" && impacted.has(node.scopeId)
          ? this.#refreshReadiness(node, workspace.root, diagnostics)
          : Promise.resolve(node),
      ),
    );

    const files = previous.files.filter(file => !impacted.has(file.scopeId));
    const documentCandidates = previous.documents.filter(document => !impacted.has(document.scopeId));
    const executableResources = previous.executableResources.filter(resource => !impacted.has(resource.scopeId));
    for (const content of indexed.values()) {
      files.push(...content.files);
      documentCandidates.push(...content.documentCandidates);
      executableResources.push(...content.executableResources);
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    executableResources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const documents = resolveDocumentCandidates(documentCandidates, diagnostics);

    const relations = previous.relations.filter(
      relation => relation.relationType === "parent-child" || !impacted.has(relation.fromId),
    );
    const explicit = await indexExplicitRelations(workspace, nodes, documents, diagnostics, impacted);
    relations.push(...explicit.relations);
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index];
      if (node !== undefined && explicit.warningScopeIds.has(node.scopeId)) nodes[index] = { ...node, readiness: "warning" };
    }
    relations.sort((left, right) =>
      `${left.fromId}/${left.toId}/${left.relationType}/${left.source}`.localeCompare(
        `${right.fromId}/${right.toId}/${right.relationType}/${right.source}`,
      ),
    );
    diagnostics.sort((left, right) => `${left.path}/${left.code}`.localeCompare(`${right.path}/${right.code}`));
    const digest = normalizedDigest(nodes, relations, files, documents, executableResources, diagnostics);
    return {
      revision: digest,
      digest,
      createdAt: new Date().toISOString(),
      nodes,
      relations,
      files,
      documents,
      executableResources,
      diagnostics,
    };
  }

  #normalizeChangedPaths(paths: readonly string[]): string[] | undefined {
    const normalized = new Set<string>();
    for (const path of paths) {
      if (path === "" || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined;
      const candidate = posix.normalize(path);
      if (candidate === ".." || candidate.startsWith("../") || candidate.includes("\0")) return undefined;
      normalized.add(candidate);
    }
    return [...normalized].sort();
  }

  #nearestScope(nodes: readonly ScopeNode[], path: string): ScopeNode | undefined {
    return nodes
      .filter(node => node.relativePath === "" || path === node.relativePath || path.startsWith(`${node.relativePath}/`))
      .sort((left, right) => right.relativePath.length - left.relativePath.length)[0];
  }

  #isDescendantOf(node: ScopeNode, ancestors: ReadonlySet<string>, nodesById: ReadonlyMap<string, ScopeNode>): boolean {
    let parentScopeId = node.parentScopeId;
    while (parentScopeId !== undefined) {
      if (ancestors.has(parentScopeId)) return true;
      parentScopeId = nodesById.get(parentScopeId)?.parentScopeId;
    }
    return false;
  }

  async #refreshReadiness(node: ScopeNode, workspaceRoot: string, diagnostics: MapDiagnostic[]): Promise<ScopeNode> {
    const conventionExists = await exists(
      join(workspaceRoot, node.relativePath, "domain-language/DomainLanguageConvention.md"),
    );
    if (!conventionExists) {
      diagnostics.push({
        code: "DOMAIN_LANGUAGE_CONFIGURATION_INVALID",
        severity: "warning",
        path: node.relativePath,
        scopeId: node.scopeId,
        message: "DomainLanguageConvention.md is missing.",
      });
    }
    return { ...node, readiness: conventionExists ? "ready" : "warning" };
  }

  #emitChanged(workspaceId: string, previous: MapRevision | undefined, revision: MapRevision): void {
    if (previous?.digest === revision.digest) return;
    const event: ScopeMapChanged = {
      workspaceId,
      revision: revision.revision,
      digest: revision.digest,
      changedScopeIds: this.#changedScopeIds(previous, revision),
      diagnosticsSummary: {
        branchErrors: revision.diagnostics.filter(diagnostic => diagnostic.severity === "branch_error").length,
        scopeErrors: revision.diagnostics.filter(diagnostic => diagnostic.severity === "scope_error").length,
        warnings: revision.diagnostics.filter(diagnostic => diagnostic.severity === "warning").length,
      },
    };
    for (const listener of this.#listeners) {
      try {
        void Promise.resolve(listener(event)).catch(() => undefined);
      } catch {
        // A subscriber cannot roll back a revision that was already published.
      }
    }
  }

  #changedScopeIds(previous: MapRevision | undefined, revision: MapRevision): string[] {
    if (previous === undefined) return revision.nodes.map(node => node.scopeId).sort();
    const ids = new Set([...previous.nodes, ...revision.nodes].map(node => node.scopeId));
    const snapshot = (map: MapRevision, scopeId: string): string =>
      JSON.stringify({
        node: map.nodes.find(node => node.scopeId === scopeId),
        relations: map.relations.filter(relation => relation.fromId === scopeId),
        files: map.files.filter(file => file.scopeId === scopeId),
        documents: map.documents.filter(document => document.scopeId === scopeId),
        executableResources: map.executableResources.filter(resource => resource.scopeId === scopeId),
        diagnostics: map.diagnostics.filter(diagnostic => diagnostic.scopeId === scopeId),
      });
    return [...ids].filter(scopeId => snapshot(previous, scopeId) !== snapshot(revision, scopeId)).sort();
  }

  getProjection(workspaceId: string, view: "agent" | "admin" = "agent"): ScopeMapProjection {
    const revision = this.#active.get(workspaceId);
    if (!revision) throw new AbcmError("MAP_NOT_BUILT", "ScopeMap has not been scanned for this workspace.");
    const nodes = view === "admin" ? revision.nodes : revision.nodes.filter(node => node.status === "valid");
    const visibleIds = new Set(nodes.map(node => node.scopeId));
    const relations =
      view === "admin"
        ? revision.relations
        : revision.relations.filter(relation => visibleIds.has(relation.fromId) && visibleIds.has(relation.toId));
    const warnings =
      view === "admin"
        ? revision.diagnostics
        : revision.diagnostics.filter(
            diagnostic =>
              (diagnostic.code === "DOMAIN_LANGUAGE_CONFIGURATION_INVALID" ||
                diagnostic.code === "EXPLICIT_LINK_UNRESOLVED") &&
              (diagnostic.scopeId === undefined || visibleIds.has(diagnostic.scopeId)),
          );
    return {
      mapRevision: revision.revision,
      digest: revision.digest,
      view,
      nodes,
      relations,
      warnings,
      resourceSummary: {
        indexedFiles: revision.files.length,
        documents: revision.documents.length,
        executableResources: revision.executableResources.length,
      },
      resolverEntrypoints: ["context.get_domain_language", "context.build_task_context"],
    };
  }

  summarize(revision: MapRevision): MapRevisionSummary {
    return {
      revision: revision.revision,
      digest: revision.digest,
      createdAt: revision.createdAt,
      nodes: revision.nodes,
      relations: revision.relations,
      diagnostics: revision.diagnostics,
      resourceSummary: {
        indexedFiles: revision.files.length,
        documents: revision.documents.length,
        executableResources: revision.executableResources.length,
      },
    };
  }

  async #readManifest(absoluteDirectory: string, relativePath: string, root: boolean): Promise<ScopeManifest> {
    try {
      const source = await readFile(join(absoluteDirectory, "scope.yaml"), "utf8");
      return scopeManifestSchema.parse(parse(source));
    } catch (error) {
      if (root) {
        throw new AbcmError("SCOPE_MANIFEST_INVALID", "Workspace root scope.yaml is missing or invalid.", {
          path: relativePath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  async #node(
    manifest: ScopeManifest,
    relativePath: string,
    parentScopeId: string | undefined,
    status: "valid" | "invalid",
    absoluteDirectory: string,
    diagnostics: MapDiagnostic[],
  ): Promise<ScopeNode> {
    const conventionExists = await exists(join(absoluteDirectory, "domain-language/DomainLanguageConvention.md"));
    if (!conventionExists) {
      diagnostics.push({
        code: "DOMAIN_LANGUAGE_CONFIGURATION_INVALID",
        severity: "warning",
        path: relativePath,
        scopeId: manifest.id,
        message: "DomainLanguageConvention.md is missing.",
      });
    }
    const node: ScopeNode = {
      scopeId: manifest.id,
      kind: manifest.kind,
      name: manifest.name,
      aliases: manifest.aliases,
      relativePath,
      rank: rankOf(manifest.kind),
      status,
      readiness: conventionExists ? "ready" : "warning",
    };
    if (parentScopeId !== undefined) return { ...node, parentScopeId };
    return node;
  }
}
