import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";

import { AbcmError } from "../core/errors.js";
import { throwIfAborted } from "../core/operation.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type {
  DirectoryDocumentationSourceDefinition,
  DocumentationImportOperation,
  DocumentationImportPlan,
  DocumentationStateStore,
  DocumentationSyncResult,
  DocumentProvenanceRecord,
  SyncRunRecord,
  TombstoneRecord,
} from "./types.js";

interface DirectoryDocumentationSyncDependencies {
  registry: WorkspaceRegistry;
  files: WorkspaceFileService;
  scopeMap: ScopeMapService;
  state: DocumentationStateStore;
  sources: readonly DirectoryDocumentationSourceDefinition[];
  clock?: () => Date;
}

interface ResolvedSource extends DirectoryDocumentationSourceDefinition {
  root: string;
}

interface SourceFile {
  sourcePath: string;
  content: Uint8Array;
  checksum: string;
}

function sha256(content: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function validateSourceId(id: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id)) {
    throw new Error(`Documentation source id '${id}' is invalid.`);
  }
}

function validateTargetBasePath(path: string): void {
  if (
    path === "" ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some(segment => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Documentation targetBasePath must be a canonical workspace-relative path.");
  }
}

export class DirectoryDocumentationSyncService {
  readonly #registry: WorkspaceRegistry;
  readonly #files: WorkspaceFileService;
  readonly #scopeMap: ScopeMapService;
  readonly #state: DocumentationStateStore;
  readonly #sources = new Map<string, ResolvedSource>();
  readonly #plans = new Map<string, DocumentationImportPlan>();
  readonly #reservedTargets = new Set<string>();
  readonly #clock: () => Date;

  constructor(dependencies: DirectoryDocumentationSyncDependencies) {
    this.#registry = dependencies.registry;
    this.#files = dependencies.files;
    this.#scopeMap = dependencies.scopeMap;
    this.#state = dependencies.state;
    this.#clock = dependencies.clock ?? (() => new Date());
    for (const source of dependencies.sources) {
      validateSourceId(source.id);
      validateTargetBasePath(source.targetBasePath);
      this.#registry.get(source.workspaceId);
      if (this.#sources.has(source.id)) throw new Error(`Documentation source '${source.id}' is duplicated.`);
      this.#sources.set(source.id, { ...source, root: resolve(source.root) });
    }
  }

  async preview(workspaceId: string, sourceId: string, signal?: AbortSignal): Promise<DocumentationImportPlan> {
    throwIfAborted(signal);
    const source = await this.#source(sourceId, signal);
    if (source.workspaceId !== workspaceId) {
      throw new AbcmError("SOURCE_CONNECTOR_UNAVAILABLE", `Documentation source '${sourceId}' is not configured for workspace '${workspaceId}'.`);
    }
    const snapshot = await this.#snapshot(source, signal);
    const provenance = this.#state.listDocumentProvenance(workspaceId, sourceId);
    const activeBySourcePath = new Map(provenance.filter(record => record.active).map(record => [record.sourcePath, record]));
    const sourcePaths = new Set(snapshot.map(file => file.sourcePath));
    const operations: DocumentationImportOperation[] = [];

    for (const file of snapshot) {
      throwIfAborted(signal);
      const targetPath = posix.join(source.targetBasePath, file.sourcePath);
      const previous = activeBySourcePath.get(file.sourcePath);
      const current = await this.#readTarget(workspaceId, targetPath, signal);
      if (previous === undefined) {
        operations.push(
          current === undefined
            ? { operation: "create", sourcePath: file.sourcePath, targetPath, sourceChecksum: file.checksum }
            : {
                operation: "conflict",
                sourcePath: file.sourcePath,
                targetPath,
                sourceChecksum: file.checksum,
                targetChecksum: current.checksum,
                conflictCode: "SOURCE_TARGET_CONFLICT",
              },
        );
      } else if (current === undefined || current.checksum !== previous.targetChecksum) {
        operations.push({
          operation: "conflict",
          sourcePath: file.sourcePath,
          targetPath,
          sourceChecksum: file.checksum,
          ...(current === undefined ? {} : { targetChecksum: current.checksum }),
          conflictCode: "SOURCE_TARGET_CONFLICT",
        });
      } else {
        operations.push({
          operation: file.checksum === previous.sourceChecksum ? "unchanged" : "update",
          sourcePath: file.sourcePath,
          targetPath,
          sourceChecksum: file.checksum,
          targetChecksum: current.checksum,
        });
      }
    }
    for (const previous of provenance.filter(record => record.active && !sourcePaths.has(record.sourcePath))) {
      throwIfAborted(signal);
      const current = await this.#readTarget(workspaceId, previous.targetPath, signal);
      operations.push(
        current?.checksum === previous.targetChecksum
          ? {
              operation: "delete",
              sourcePath: previous.sourcePath,
              targetPath: previous.targetPath,
              targetChecksum: previous.targetChecksum,
            }
          : {
              operation: "conflict",
              sourcePath: previous.sourcePath,
              targetPath: previous.targetPath,
              ...(current === undefined ? {} : { targetChecksum: current.checksum }),
              conflictCode: "SOURCE_TARGET_CONFLICT",
            },
      );
    }
    operations.sort((left, right) => `${left.targetPath}/${left.operation}`.localeCompare(`${right.targetPath}/${right.operation}`));
    const plan: DocumentationImportPlan = {
      importId: randomUUID(),
      sourceId,
      workspaceId,
      snapshotDigest: this.#snapshotDigest(snapshot),
      createdAt: this.#clock().toISOString(),
      operations,
    };
    throwIfAborted(signal);
    this.#plans.set(plan.importId, plan);
    return plan;
  }

  async apply(importId: string, signal?: AbortSignal): Promise<DocumentationSyncResult> {
    throwIfAborted(signal);
    const plan = this.#plans.get(importId);
    if (plan === undefined) throw new AbcmError("DOCUMENTATION_IMPORT_NOT_FOUND", `Documentation import '${importId}' was not found.`);
    const source = await this.#source(plan.sourceId, signal);
    const snapshot = await this.#snapshot(source, signal);
    if (this.#snapshotDigest(snapshot) !== plan.snapshotDigest) {
      throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Documentation source changed after preview.", { importId });
    }
    const conflicts = plan.operations.filter(operation => operation.operation === "conflict");
    if (conflicts.length > 0) {
      throw new AbcmError("SOURCE_TARGET_CONFLICT", "Documentation import contains source-target conflicts.", {
        importId,
        paths: conflicts.map(operation => operation.targetPath),
      });
    }
    const reservedTargets = plan.operations.map(operation => this.#targetKey(plan.workspaceId, operation.targetPath));
    if (reservedTargets.some(target => this.#reservedTargets.has(target))) {
      throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Another documentation import is applying to the same target.");
    }
    for (const target of reservedTargets) this.#reservedTargets.add(target);
    try {
      const sourceFiles = new Map(snapshot.map(file => [file.sourcePath, file]));
      for (const operation of plan.operations) {
        throwIfAborted(signal);
        const target = await this.#readTarget(plan.workspaceId, operation.targetPath, signal);
        if (operation.operation === "create" && target !== undefined) {
          throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Documentation target changed after preview.", { path: operation.targetPath });
        }
        if (
          (operation.operation === "update" || operation.operation === "delete" || operation.operation === "unchanged") &&
          target?.checksum !== operation.targetChecksum
        ) {
          throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Documentation target changed after preview.", { path: operation.targetPath });
        }
      }

      // From this point the multi-file import is intentionally non-preemptible:
      // completing provenance, tombstones and the map publication is safer than
      // returning a timeout after only part of the canonical snapshot was applied.
      throwIfAborted(signal);

      const startedAt = this.#clock().toISOString();
      const upserts: DocumentProvenanceRecord[] = [];
      const deletions: TombstoneRecord[] = [];
      let created = 0;
      let updated = 0;
      let deleted = 0;
      for (const operation of plan.operations) {
        if (operation.operation === "create" || operation.operation === "update") {
          const file = sourceFiles.get(operation.sourcePath);
          if (file === undefined) throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Planned source file disappeared.");
          const preconditions =
            operation.operation === "create"
              ? { ifNoneMatch: "*" as const }
              : operation.targetChecksum === undefined
                ? (() => {
                    throw new Error("Update checksum is unavailable.");
                  })()
                : { ifMatch: operation.targetChecksum };
          const written = await this.#files.writeMirror(plan.workspaceId, operation.targetPath, file.content, preconditions);
          upserts.push({
            workspaceId: plan.workspaceId,
            sourceId: plan.sourceId,
            sourcePath: operation.sourcePath,
            targetPath: operation.targetPath,
            sourceChecksum: file.checksum,
            targetChecksum: written.checksum,
            lastSynchronizedAt: this.#clock().toISOString(),
            active: true,
          });
          if (operation.operation === "create") created++;
          else updated++;
        } else if (operation.operation === "unchanged") {
          const file = sourceFiles.get(operation.sourcePath);
          if (file === undefined || operation.targetChecksum === undefined) throw new Error("Unchanged source is unavailable.");
          upserts.push({
            workspaceId: plan.workspaceId,
            sourceId: plan.sourceId,
            sourcePath: operation.sourcePath,
            targetPath: operation.targetPath,
            sourceChecksum: file.checksum,
            targetChecksum: operation.targetChecksum,
            lastSynchronizedAt: this.#clock().toISOString(),
            active: true,
          });
        } else if (operation.operation === "delete") {
          if (operation.targetChecksum === undefined) throw new Error("Delete checksum is unavailable.");
          await this.#files.deleteMirror(plan.workspaceId, operation.targetPath, { ifMatch: operation.targetChecksum });
          deletions.push({
            resourceId: randomUUID(),
            workspaceId: plan.workspaceId,
            sourceId: plan.sourceId,
            formerPath: operation.targetPath,
            checksum: operation.targetChecksum,
            deletedAt: this.#clock().toISOString(),
            reason: "canonical_source_deleted",
          });
          deleted++;
        }
      }

      const run: SyncRunRecord = {
        syncRunId: randomUUID(),
        workspaceId: plan.workspaceId,
        sourceId: plan.sourceId,
        startedAt,
        finishedAt: this.#clock().toISOString(),
        created,
        updated,
        moved: 0,
        deleted,
        conflicts: 0,
        status: "succeeded",
      };
      this.#state.commitDocumentationSync({
        source: { id: source.id, workspaceId: source.workspaceId, targetBasePath: source.targetBasePath },
        run,
        upserts,
        deletions,
      });
      this.#plans.delete(importId);
      const revision = await this.#scopeMap.scan(plan.workspaceId);
      return { ...run, mapRevision: revision.revision };
    } finally {
      for (const target of reservedTargets) this.#reservedTargets.delete(target);
    }
  }

  async sync(sourceId: string, signal?: AbortSignal): Promise<DocumentationSyncResult> {
    const source = await this.#source(sourceId, signal);
    return this.apply((await this.preview(source.workspaceId, sourceId, signal)).importId, signal);
  }

  async authorizeMutation(workspaceId: string, paths: readonly string[]): Promise<void> {
    for (const path of paths) {
      if (this.#reservedTargets.has(this.#targetKey(workspaceId, path))) {
        throw new AbcmError("MIRROR_DOCUMENT_READ_ONLY", "A documentation import currently owns this target.", {
          workspaceId,
          path,
        });
      }
      const storage = this.#state.resolveDocumentStorage(workspaceId, path);
      if (storage.storageMode === "mirror") {
        throw new AbcmError("MIRROR_DOCUMENT_READ_ONLY", "Mirrored documents can only be changed by their canonical source sync.", {
          workspaceId,
          path,
          sourceId: storage.sourceId,
        });
      }
    }
  }

  async #source(sourceId: string, signal?: AbortSignal): Promise<ResolvedSource> {
    throwIfAborted(signal);
    const configured = this.#sources.get(sourceId);
    if (configured === undefined) throw new AbcmError("SOURCE_CONNECTOR_UNAVAILABLE", `Documentation source '${sourceId}' is unavailable.`);
    let root: string;
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      root = await realpath(configured.root);
      metadata = await stat(root);
      throwIfAborted(signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new AbcmError("SOURCE_CONNECTOR_UNAVAILABLE", `Documentation source '${sourceId}' cannot be read.`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!metadata.isDirectory()) throw new AbcmError("SOURCE_CONNECTOR_UNAVAILABLE", "Documentation source is not a directory.");
    return { ...configured, root };
  }

  async #snapshot(source: ResolvedSource, signal?: AbortSignal): Promise<SourceFile[]> {
    throwIfAborted(signal);
    const files: SourceFile[] = [];
    const visit = async (directory: string): Promise<void> => {
      throwIfAborted(signal);
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        throwIfAborted(signal);
        if (child.isSymbolicLink() || child.name.startsWith(".")) continue;
        const absolute = resolve(directory, child.name);
        if (!isWithinRoot(source.root, absolute)) continue;
        if (child.isDirectory()) await visit(absolute);
        else if (child.isFile() && child.name.toLowerCase().endsWith(".md")) {
          const sourcePath = relative(source.root, absolute).split(sep).join("/");
          const content = new Uint8Array(await readFile(absolute));
          throwIfAborted(signal);
          files.push({ sourcePath, content, checksum: sha256(content) });
        }
      }
    };
    try {
      await visit(source.root);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof AbcmError) throw error;
      throw new AbcmError("SOURCE_CONNECTOR_UNAVAILABLE", `Documentation source '${source.id}' could not be snapshotted.`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return files.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  }

  #targetKey(workspaceId: string, targetPath: string): string {
    return `${workspaceId}\0${targetPath}`;
  }

  #snapshotDigest(snapshot: readonly SourceFile[]): string {
    return sha256(JSON.stringify(snapshot.map(file => ({ sourcePath: file.sourcePath, checksum: file.checksum }))));
  }

  async #readTarget(workspaceId: string, targetPath: string, signal?: AbortSignal): Promise<{ checksum: string } | undefined> {
    try {
      const result = await this.#files.read(workspaceId, targetPath, signal);
      return { checksum: result.entry.checksum };
    } catch (error) {
      if (error instanceof AbcmError && error.code === "FILE_NOT_FOUND") return undefined;
      throw error;
    }
  }
}
