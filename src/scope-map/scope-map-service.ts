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
import { indexScopeContent, resolveDocumentCandidates } from "./content-indexer.js";
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

  constructor(registry: WorkspaceRegistry, store?: ScopeMapStore, documentationState?: DocumentationStateStore) {
    this.#registry = registry;
    this.#store = store;
    this.#documentationState = documentationState;
  }

  scan(workspaceId: string): Promise<MapRevision> {
    const previous = this.#scanTails.get(workspaceId) ?? Promise.resolve();
    const operation = previous.then(() => this.#scanOnce(workspaceId));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#scanTails.set(workspaceId, tail);
    void tail.then(() => {
      if (this.#scanTails.get(workspaceId) === tail) this.#scanTails.delete(workspaceId);
    });
    return operation;
  }

  async #scanOnce(workspaceId: string): Promise<MapRevision> {
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
      const revision = await this.#build(workspaceId);
      if (renewalError !== undefined) throw renewalError;
      if (lease !== undefined) store?.publish(lease, revision);
      this.#active.set(workspaceId, revision);
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
      nodes.filter(node => node.status === "valid").map(node => indexScopeContent(workspace, node)),
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
