import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";

import { z } from "zod/v4";
import { AbcmError } from "../core/errors.js";
import { observeOperation, type AbcmObservability } from "../core/observability.js";
import { throwIfAborted } from "../core/operation.js";
import { parseSafeYaml } from "../core/safe-yaml.js";
import { parseProjectLanguageConfig } from "../core/project-language.js";
import type { ScopeMapStore } from "../derived-store/types.js";
import type { DocumentationStateStore } from "../documentation/types.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import type { FileMutationOperation, ResolvedWorkspace } from "../workspace/types.js";
import {
  indexScopeContent,
  resolveDocumentCandidates,
  type ScopeContentIndex,
} from "./content-indexer.js";
import { resolveArtifactLineages } from "./artifact-lineage.js";
import { indexExplicitRelations } from "./explicit-relations.js";
import {
  buildTypedLinkGraph,
  linkSourcesFromGraph,
  type DocumentLinkSource,
} from "./link-graph.js";
import type {
  DocumentRecord,
  ExecutableResourceRecord,
  FileRecord,
  MapDiagnostic,
  MapRevision,
  MapRevisionSummary,
  ScopeKind,
  ScopeMapAccess,
  ScopeMapPermission,
  ScopeMapProjection,
  ScopeMapProjectionNode,
  ScopeMapProjectionQuery,
  ScopeMapChanged,
  ScopeMapChangedListener,
  ScopeNode,
  ScopeRelation,
  SkillDescriptor,
  TypedLinkGraph,
} from "./types.js";

const SCOPE_KINDS = ["workflow", "project", "service", "feature"] as const;
const RESERVED_SCOPE_DIRECTORIES = new Set([".abcm", "config", "domain-language", "agents", "artifacts", "architecture"]);
const TRUSTED_SCOPE_MAP_ACCESS: ScopeMapAccess = {
  workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full"],
};

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
type ContentIndexer = (workspace: ResolvedWorkspace, scope: ScopeNode, signal?: AbortSignal) => Promise<ScopeContentIndex>;

export interface ScopeMapServiceOptions {
  contentIndexer?: ContentIndexer;
  observability?: AbcmObservability;
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
  skills: readonly SkillDescriptor[],
  linkGraph: TypedLinkGraph,
  artifactLineages: NonNullable<MapRevision["artifactLineages"]>,
  diagnostics: readonly MapDiagnostic[],
): string {
  const normalized = JSON.stringify({ nodes, relations, files, documents, executableResources, skills, linkGraph, artifactLineages, diagnostics });
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
  readonly #observability: AbcmObservability | undefined;

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
    this.#observability = options.observability;
  }

  scan(workspaceId: string, signal?: AbortSignal): Promise<MapRevision> {
    throwIfAborted(signal);
    return observeOperation(this.#observability, {
      operation: "scope_map.scan",
      workspaceId,
      durationMetric: "abcm_scope_map_scan_duration_ms",
    }, () => this.#enqueue(workspaceId, () => this.#scanOnce(workspaceId, undefined, signal)));
  }

  reconcile(workspaceId: string, changedPaths: readonly string[]): Promise<MapRevision> {
    return observeOperation(this.#observability, {
      operation: "scope_map.scan",
      workspaceId,
      durationMetric: "abcm_scope_map_scan_duration_ms",
    }, () => this.#enqueue(workspaceId, () => this.#scanOnce(workspaceId, changedPaths)));
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

  async #scanOnce(workspaceId: string, changedPaths?: readonly string[], signal?: AbortSignal): Promise<MapRevision> {
    throwIfAborted(signal);
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
        changedPaths === undefined ? await this.#build(workspaceId, signal) : await this.#buildIncremental(workspaceId, changedPaths, signal);
      if (renewalError !== undefined) throw renewalError;
      throwIfAborted(signal);
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

  async #build(workspaceId: string, signal?: AbortSignal): Promise<MapRevision> {
    throwIfAborted(signal);
    const workspace = this.#registry.get(workspaceId);
    const rootManifest = await this.#readManifest(workspace.root, "", true, workspace.maxIndexBytes);
    if (rootManifest.kind !== "workflow") {
      throw new AbcmError("WORKSPACE_ROOT_MUST_BE_WORKFLOW", "Workspace root scope must have kind=workflow.", {
        actual: rootManifest.kind,
      });
    }

    const nodes: ScopeNode[] = [];
    const relations: ScopeRelation[] = [];
    const diagnostics: MapDiagnostic[] = [];
    const seenIds = new Set<string>();
    const rootNode = await this.#node(rootManifest, "", undefined, "valid", workspace.root, diagnostics, workspace.maxIndexBytes);
    nodes.push(rootNode);
    seenIds.add(rootNode.scopeId);

    const walk = async (parent: ScopeNode, absoluteDirectory: string): Promise<void> => {
      throwIfAborted(signal);
      const children = await readdir(absoluteDirectory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        throwIfAborted(signal);
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        if (workspace.deniedDirectories.has(child.name) || RESERVED_SCOPE_DIRECTORIES.has(child.name)) continue;
        const childAbsolute = join(absoluteDirectory, child.name);
        const manifestPath = join(childAbsolute, "scope.yaml");
        if (!(await exists(manifestPath))) continue;
        const childRelative = parent.relativePath === "" ? child.name : posix.join(parent.relativePath, child.name);

        let manifest: ScopeManifest;
        try {
          manifest = await this.#readManifest(childAbsolute, childRelative, false, workspace.maxIndexBytes);
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

        const childNode = await this.#node(manifest, childRelative, parent.scopeId, status, childAbsolute, diagnostics, workspace.maxIndexBytes);
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
    const linkSources: DocumentLinkSource[] = [];
    const executableResources: ExecutableResourceRecord[] = [];
    const skills: SkillDescriptor[] = [];
    const indexes = await Promise.all(
      nodes.filter(node => node.status === "valid").map(node => this.#contentIndexer(workspace, node, signal)),
    );
    throwIfAborted(signal);
    for (const index of indexes) {
      files.push(...index.files);
      documentCandidates.push(...index.documentCandidates);
      linkSources.push(...index.linkSources);
      executableResources.push(...index.executableResources);
      skills.push(...index.skills);
      diagnostics.push(...(index.diagnostics ?? []));
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
    skills.sort((left, right) => `${left.skillId}/${left.sourceScopeId}`.localeCompare(`${right.skillId}/${right.sourceScopeId}`));
    const resolvedDocuments = resolveDocumentCandidates(documentCandidates, diagnostics);
    const lineage = resolveArtifactLineages(resolvedDocuments, diagnostics);
    const documents = lineage.documents;
    const linkGraph = buildTypedLinkGraph(linkSources, documents, diagnostics);
    throwIfAborted(signal);
    const explicit = await indexExplicitRelations(workspace, nodes, documents, diagnostics);
    throwIfAborted(signal);
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
    const digest = normalizedDigest(nodes, relations, files, documents, executableResources, skills, linkGraph, lineage.lineages, diagnostics);
    const revision: MapRevision = {
      revision: digest,
      digest,
      createdAt: new Date().toISOString(),
      nodes,
      relations,
      files,
      documents,
      executableResources,
      skills,
      linkGraph,
      artifactLineages: lineage.lineages,
      diagnostics,
    };
    return revision;
  }

  async #buildIncremental(workspaceId: string, changedPaths: readonly string[], signal?: AbortSignal): Promise<MapRevision> {
    throwIfAborted(signal);
    const previous = this.#active.get(workspaceId);
    const normalizedPaths = this.#normalizeChangedPaths(changedPaths);
    if (
      previous === undefined ||
      normalizedPaths === undefined ||
      normalizedPaths.length === 0 ||
      normalizedPaths.some(path => posix.basename(path) === "scope.yaml") ||
      previous.diagnostics.some(diagnostic => diagnostic.code === "DOCUMENT_ID_DUPLICATE")
    ) {
      return this.#build(workspaceId, signal);
    }

    const workspace = this.#registry.get(workspaceId);
    const validNodes = previous.nodes.filter(node => node.status === "valid");
    const nodesById = new Map(validNodes.map(node => [node.scopeId, node]));
    const changedScopeIds = new Set<string>();
    const readinessRoots = new Set<string>();
    for (const path of normalizedPaths) {
      const scope = this.#nearestScope(validNodes, path);
      if (scope === undefined) return this.#build(workspaceId, signal);
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
      throwIfAborted(signal);
      for (const scopeId of impacted) {
        throwIfAborted(signal);
        if (indexed.has(scopeId)) continue;
        const node = nodesById.get(scopeId);
        if (node === undefined) continue;
        const content = await this.#contentIndexer(workspace, node, signal);
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
      diagnostic => diagnostic.code !== "DOCUMENT_ID_DUPLICATE" && !diagnostic.code.startsWith("LINK_GRAPH_") &&
        (diagnostic.scopeId === undefined || !impacted.has(diagnostic.scopeId)),
    );
    const nodes = await Promise.all(
      previous.nodes.map(node =>
        node.status === "valid" && impacted.has(node.scopeId)
          ? this.#refreshReadiness(node, workspace.root, diagnostics, workspace.maxIndexBytes)
          : Promise.resolve(node),
      ),
    );

    const files = previous.files.filter(file => !impacted.has(file.scopeId));
    const documentCandidates = previous.documents.filter(document => !impacted.has(document.scopeId));
    const linkSources = linkSourcesFromGraph(previous.linkGraph).filter(source => !impacted.has(source.scopeId));
    const executableResources = previous.executableResources.filter(resource => !impacted.has(resource.scopeId));
    const skills = previous.skills.filter(skill => !impacted.has(skill.sourceScopeId));
    for (const content of indexed.values()) {
      files.push(...content.files);
      documentCandidates.push(...content.documentCandidates);
      linkSources.push(...content.linkSources);
      executableResources.push(...content.executableResources);
      skills.push(...content.skills);
      diagnostics.push(...(content.diagnostics ?? []));
    }
    files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    executableResources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    skills.sort((left, right) => `${left.skillId}/${left.sourceScopeId}`.localeCompare(`${right.skillId}/${right.sourceScopeId}`));
    const resolvedDocuments = resolveDocumentCandidates(documentCandidates, diagnostics);
    const lineage = resolveArtifactLineages(resolvedDocuments, diagnostics);
    const documents = lineage.documents;
    const linkGraph = buildTypedLinkGraph(linkSources, documents, diagnostics);

    const relations = previous.relations.filter(
      relation => relation.relationType === "parent-child" || !impacted.has(relation.fromId),
    );
    const explicit = await indexExplicitRelations(workspace, nodes, documents, diagnostics, impacted);
    throwIfAborted(signal);
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
    const digest = normalizedDigest(nodes, relations, files, documents, executableResources, skills, linkGraph, lineage.lineages, diagnostics);
    return {
      revision: digest,
      digest,
      createdAt: new Date().toISOString(),
      nodes,
      relations,
      files,
      documents,
      executableResources,
      skills,
      linkGraph,
      artifactLineages: lineage.lineages,
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

  async #refreshReadiness(
    node: ScopeNode,
    workspaceRoot: string,
    diagnostics: MapDiagnostic[],
    maxBytes: number,
  ): Promise<ScopeNode> {
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
    const languageReady = node.kind !== "project" || await this.#projectLanguageReady(
      join(workspaceRoot, node.relativePath),
      node.relativePath,
      node.scopeId,
      diagnostics,
      maxBytes,
    );
    return { ...node, readiness: conventionExists && languageReady ? "ready" : "warning" };
  }

  async #projectLanguageReady(
    absoluteDirectory: string,
    relativePath: string,
    scopeId: string,
    diagnostics: MapDiagnostic[],
    maxBytes: number,
  ): Promise<boolean> {
    const configurationPath = join(absoluteDirectory, "config/context.yaml");
    const diagnosticPath = relativePath === "" ? "config/context.yaml" : posix.join(relativePath, "config/context.yaml");
    try {
      const metadata = await stat(configurationPath);
      if (metadata.size > maxBytes) throw new AbcmError("FILE_TOO_LARGE", `context.yaml exceeds maxIndexBytes=${maxBytes}.`);
      parseProjectLanguageConfig(await readFile(configurationPath, "utf8"));
      return true;
    } catch (error) {
      diagnostics.push({
        code: "PROJECT_LANGUAGE_CONFIGURATION_INVALID",
        severity: "warning",
        path: diagnosticPath,
        scopeId,
        message: error instanceof Error ? error.message : "Project language configuration is invalid.",
      });
      return false;
    }
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
        skills: map.skills.filter(skill => skill.sourceScopeId === scopeId),
        linkGraphNodes: map.linkGraph.nodes.filter(node => node.scopeId === scopeId),
        linkGraphEdges: map.linkGraph.edges.filter(edge => {
          const from = map.linkGraph.nodes.find(node => node.documentId === edge.fromDocumentId);
          const to = edge.toDocumentId === undefined
            ? undefined
            : map.linkGraph.nodes.find(node => node.documentId === edge.toDocumentId);
          return from?.scopeId === scopeId || to?.scopeId === scopeId;
        }),
        diagnostics: map.diagnostics.filter(diagnostic => diagnostic.scopeId === scopeId),
      });
    return [...ids].filter(scopeId => snapshot(previous, scopeId) !== snapshot(revision, scopeId)).sort();
  }

  async authorizeArtifactMutation(
    workspaceId: string,
    paths: readonly string[],
    operation: FileMutationOperation,
  ): Promise<void> {
    const protectedPaths = operation === "move" ? paths.slice(1) : paths;
    if (!protectedPaths.some(path => /(?:^|\/)artifacts\//.test(path))) return;
    let revision = this.#active.get(workspaceId);
    if (revision === undefined) revision = await this.scan(workspaceId);
    for (const path of protectedPaths) {
      const artifact = revision.documents.find(document =>
        document.relativePath === path &&
        ["adr", "rfc"].includes(document.kind.toLocaleLowerCase("en-US")) &&
        document.lifecycle.toLocaleLowerCase("en-US") === "accepted"
      );
      if (artifact !== undefined) {
        throw new AbcmError(
          "ACCEPTED_ARTIFACT_IMMUTABLE",
          `Accepted ${artifact.kind.toUpperCase()} '${artifact.documentId}' requires an explicit amendment workflow.`,
          { documentId: artifact.documentId, path: artifact.relativePath },
        );
      }
    }
  }

  getActiveRevision(workspaceId: string): MapRevision {
    const revision = this.#active.get(workspaceId);
    if (revision === undefined) throw new AbcmError("MAP_NOT_BUILT", "ScopeMap has not been scanned for this workspace.");
    return revision;
  }

  getProjection(workspaceId: string, view?: "agent" | "admin"): ScopeMapProjection;
  getProjection(workspaceId: string, query: ScopeMapProjectionQuery, access?: ScopeMapAccess): ScopeMapProjection;
  getProjection(
    workspaceId: string,
    queryOrView: ScopeMapProjectionQuery | "agent" | "admin" = "agent",
    access: ScopeMapAccess = TRUSTED_SCOPE_MAP_ACCESS,
  ): ScopeMapProjection {
    const revision = this.#active.get(workspaceId);
    if (!revision) throw new AbcmError("MAP_NOT_BUILT", "ScopeMap has not been scanned for this workspace.");
    const legacy = typeof queryOrView === "string";
    const query: ScopeMapProjectionQuery = legacy ? { view: queryOrView } : queryOrView;
    const view = query.view ?? "agent";
    const includeInvalid = query.includeInvalid ?? (legacy && view === "admin");
    const depth = query.depth;
    if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 0)) {
      throw new AbcmError("REQUEST_INVALID", "ScopeMap depth must be a non-negative integer.");
    }
    if (includeInvalid && view !== "admin") {
      throw new AbcmError("REQUEST_INVALID", "Invalid ScopeMap branches are available only in the admin view.");
    }
    if ((view === "admin" || includeInvalid) && !access.workspacePermissions.includes("scope_map.read_full")) {
      throw new AbcmError("ACCESS_DENIED", "Full-map permission is required for admin or invalid ScopeMap projections.");
    }

    const eligibleNodes = includeInvalid ? revision.nodes : revision.nodes.filter(node => node.status === "valid");
    const root = this.#resolveProjectionRoot(eligibleNodes, query.rootScopeId);
    const boundedNodes = eligibleNodes.filter(node => {
      const distance = this.#projectionDistance(root, node, eligibleNodes);
      return distance !== undefined && (depth === undefined || distance <= depth);
    });
    const selectedNodes = boundedNodes.filter(
      node =>
        this.#hasScopePermission(access, node, "scope.discover") &&
        this.#hasScopePermission(access, node, "scope.read_metadata"),
    );
    if (selectedNodes.length === 0) {
      throw new AbcmError("ACCESS_DENIED", "Scope discovery and metadata permissions are required for this projection.");
    }

    const selectedIds = new Set(selectedNodes.map(node => node.scopeId));
    const visibleIds = new Set(selectedIds);
    const nodesById = new Map(revision.nodes.map(node => [node.scopeId, node]));
    for (const selected of selectedNodes) {
      let parentScopeId = selected.parentScopeId;
      while (parentScopeId !== undefined) {
        visibleIds.add(parentScopeId);
        parentScopeId = nodesById.get(parentScopeId)?.parentScopeId;
      }
    }
    const visibleNodes = revision.nodes.filter(node => visibleIds.has(node.scopeId));
    const knownScopeIds = new Map<string, string>();
    for (const node of revision.nodes) {
      knownScopeIds.set(node.scopeId, node.scopeId);
      for (const alias of node.aliases) knownScopeIds.set(alias, node.scopeId);
    }
    const targetScopeId = (relation: ScopeRelation): string | undefined => {
      const stableScope = /^abcm:\/\/scope\/([^/?#]+)$/.exec(relation.toId)?.[1];
      return knownScopeIds.get(stableScope ?? relation.toId);
    };
    const relationIsBounded = (relation: ScopeRelation): boolean => {
      if (!visibleIds.has(relation.fromId)) return false;
      const target = targetScopeId(relation);
      if (target !== undefined) return visibleIds.has(target);
      return view === "admin" && selectedIds.has(relation.fromId);
    };
    const relations = revision.relations.filter(
      relation => relationIsBounded(relation) && (view === "admin" || relation.status === "resolved"),
    );
    const projectedNodes: ScopeMapProjectionNode[] = visibleNodes.map(node => {
      const directChildScopeIds = revision.nodes
        .filter(child => child.parentScopeId === node.scopeId && visibleIds.has(child.scopeId))
        .map(child => child.scopeId)
        .sort();
      const relevantRelations = relations.filter(relation => relation.fromId === node.scopeId || relation.toId === node.scopeId);
      const projected: ScopeMapProjectionNode = {
        scopeId: node.scopeId,
        kind: node.kind,
        name: node.name,
        relativePath: node.relativePath,
        rank: node.rank,
        status: node.status,
        readiness: node.readiness,
        pathOnly: !selectedIds.has(node.scopeId),
        directChildScopeIds,
        relationSummary: {
          inbound: relevantRelations.filter(relation => relation.toId === node.scopeId).length,
          outbound: relevantRelations.filter(relation => relation.fromId === node.scopeId).length,
          unresolved: relevantRelations.filter(relation => relation.status !== "resolved").length,
        },
      };
      return node.parentScopeId === undefined ? projected : { ...projected, parentScopeId: node.parentScopeId };
    });
    const warnings = revision.diagnostics.filter(diagnostic => {
      if (diagnostic.scopeId === undefined || !selectedIds.has(diagnostic.scopeId)) return false;
      return view === "admin" ||
        diagnostic.code === "DOMAIN_LANGUAGE_CONFIGURATION_INVALID" ||
        diagnostic.code === "PROJECT_LANGUAGE_CONFIGURATION_INVALID" ||
        diagnostic.code === "EXPLICIT_LINK_UNRESOLVED";
    });
    const selectedFiles = revision.files.filter(file => selectedIds.has(file.scopeId));
    const selectedDocuments = revision.documents.filter(document => selectedIds.has(document.scopeId));
    const selectedExecutableResources = revision.executableResources.filter(resource => selectedIds.has(resource.scopeId));
    const projection: ScopeMapProjection = {
      mapRevision: revision.revision,
      digest: revision.digest,
      view,
      rootScopeId: root.scopeId,
      depth: depth ?? null,
      includeInvalid,
      nodes: projectedNodes,
      relations,
      warnings,
      resourceSummary: {
        indexedFiles: selectedFiles.length,
        documents: selectedDocuments.length,
        executableResources: selectedExecutableResources.length,
      },
      resolverEntrypoints: ["context.get_domain_language", "context.build_task_context"],
    };
    if (view !== "admin") return projection;
    const fileClassificationCounts = {
      scope_manifest: 0,
      configuration: 0,
      domain_language: 0,
      agent_definition: 0,
      context_document: 0,
      executable_resource: 0,
    };
    for (const file of selectedFiles) fileClassificationCounts[file.classification] += 1;
    const sourceIds = [
      ...new Set(
        selectedFiles.flatMap(file => file.storageMode === "mirror" && file.sourceId !== undefined ? [file.sourceId] : []),
      ),
    ].sort();
    return {
      ...projection,
      admin: {
        scanCreatedAt: revision.createdAt,
        diagnosticsSummary: {
          branchErrors: warnings.filter(diagnostic => diagnostic.severity === "branch_error").length,
          scopeErrors: warnings.filter(diagnostic => diagnostic.severity === "scope_error").length,
          warnings: warnings.filter(diagnostic => diagnostic.severity === "warning").length,
        },
        fileClassificationCounts,
        documentationSyncSummary: {
          managedDocuments: selectedDocuments.filter(document => document.storageMode === "managed").length,
          mirroredDocuments: selectedDocuments.filter(document => document.storageMode === "mirror").length,
          sourceIds,
        },
      },
    };
  }

  #resolveProjectionRoot(nodes: readonly ScopeNode[], requested: string | undefined): ScopeNode {
    if (requested === undefined) {
      const root = nodes.find(node => node.parentScopeId === undefined);
      if (root !== undefined) return root;
      throw new AbcmError("REQUEST_INVALID", "ScopeMap does not contain an eligible root scope.");
    }
    const canonical = nodes.find(node => node.scopeId === requested);
    if (canonical !== undefined) return canonical;
    const aliases = nodes.filter(node => node.aliases.includes(requested));
    if (aliases.length === 1) return aliases[0]!;
    throw new AbcmError("REQUEST_INVALID", "ScopeMap rootScopeId does not resolve to one eligible scope.", {
      rootScopeId: requested,
    });
  }

  #projectionDistance(root: ScopeNode, node: ScopeNode, nodes: readonly ScopeNode[]): number | undefined {
    if (root.scopeId === node.scopeId) return 0;
    const byId = new Map(nodes.map(candidate => [candidate.scopeId, candidate]));
    let distance = 0;
    let current: ScopeNode | undefined = node;
    while (current.parentScopeId !== undefined) {
      distance += 1;
      if (current.parentScopeId === root.scopeId) return distance;
      current = byId.get(current.parentScopeId);
      if (current === undefined) return undefined;
    }
    return undefined;
  }

  #hasScopePermission(access: ScopeMapAccess, node: ScopeNode, permission: ScopeMapPermission): boolean {
    if (access.workspacePermissions.includes(permission)) return true;
    const grants = access.scopeGrants;
    if (grants === undefined) return false;
    if (grants[node.scopeId]?.includes(permission) === true) return true;
    return node.aliases.some(alias => grants[alias]?.includes(permission) === true);
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
      linkGraphSummary: {
        policyVersion: revision.linkGraph.policyVersion,
        digest: revision.linkGraph.digest,
        nodes: revision.linkGraph.nodes.length,
        edges: revision.linkGraph.edges.length,
        resolved: revision.linkGraph.edges.filter(edge => edge.status === "resolved").length,
        broken: revision.linkGraph.edges.filter(edge => edge.status === "broken").length,
        ambiguous: revision.linkGraph.edges.filter(edge => edge.status === "ambiguous").length,
      },
    };
  }

  async #readManifest(absoluteDirectory: string, relativePath: string, root: boolean, maxBytes: number): Promise<ScopeManifest> {
    try {
      const manifestPath = join(absoluteDirectory, "scope.yaml");
      const metadata = await stat(manifestPath);
      if (metadata.size > maxBytes) throw new AbcmError("FILE_TOO_LARGE", `scope.yaml exceeds maxIndexBytes=${maxBytes}.`);
      const source = await readFile(manifestPath, "utf8");
      return scopeManifestSchema.parse(parseSafeYaml(source));
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
    maxBytes: number,
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
    const languageReady = manifest.kind !== "project" || await this.#projectLanguageReady(
      absoluteDirectory,
      relativePath,
      manifest.id,
      diagnostics,
      maxBytes,
    );
    const node: ScopeNode = {
      scopeId: manifest.id,
      kind: manifest.kind,
      name: manifest.name,
      aliases: manifest.aliases,
      relativePath,
      rank: rankOf(manifest.kind),
      status,
      readiness: conventionExists && languageReady ? "ready" : "warning",
    };
    if (parentScopeId !== undefined) return { ...node, parentScopeId };
    return node;
  }
}
