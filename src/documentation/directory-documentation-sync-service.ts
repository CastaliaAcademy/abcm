import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { posix, relative, resolve, sep } from "node:path";

import { AbcmError } from "../core/errors.js";
import { observeOperation, type AbcmObservability } from "../core/observability.js";
import { throwIfAborted } from "../core/operation.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type {
  DirectoryDocumentationSourceDefinition,
  DocumentationImportOperation,
  DocumentationImportPlan,
  DocumentationCutoverResult,
  DocumentationCutoverRecord,
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
  observability?: AbcmObservability;
}

interface ResolvedSource extends DirectoryDocumentationSourceDefinition {
  root: string;
}

interface SourceFile {
  sourcePath: string;
  content: Uint8Array;
  checksum: string;
}

interface MappedSourceFile {
  file: SourceFile;
  candidateTargetPaths: readonly string[];
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

function validateGlob(pattern: string): void {
  if (
    pattern === "" ||
    pattern.includes("\\") ||
    pattern.includes("\0") ||
    pattern.startsWith("/") ||
    pattern.split("/").some(segment => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Documentation include/exclude/match patterns must be canonical relative globs.");
  }
}

function globRegex(pattern: string): RegExp {
  validateGlob(pattern);
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function mappingTarget(sourcePath: string, match: string, target: string): string {
  const wildcard = match.search(/[?*]/);
  if (wildcard < 0) return target;
  const prefix = match.slice(0, wildcard);
  const suffix = sourcePath.slice(prefix.length);
  return posix.join(target, suffix);
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
  readonly #observability: AbcmObservability | undefined;

  constructor(dependencies: DirectoryDocumentationSyncDependencies) {
    this.#registry = dependencies.registry;
    this.#files = dependencies.files;
    this.#scopeMap = dependencies.scopeMap;
    this.#state = dependencies.state;
    this.#clock = dependencies.clock ?? (() => new Date());
    this.#observability = dependencies.observability;
    for (const source of dependencies.sources) {
      validateSourceId(source.id);
      validateTargetBasePath(source.targetBasePath);
      for (const pattern of [...(source.include ?? []), ...(source.exclude ?? [])]) validateGlob(pattern);
      for (const rule of source.mapping ?? []) {
        validateGlob(rule.match);
        validateTargetBasePath(rule.target.endsWith("/") ? rule.target.slice(0, -1) : rule.target);
      }
      this.#registry.get(source.workspaceId);
      if (this.#sources.has(source.id)) throw new Error(`Documentation source '${source.id}' is duplicated.`);
      this.#sources.set(source.id, { ...source, root: resolve(source.root) });
    }
  }

  async preview(workspaceId: string, sourceId: string, signal?: AbortSignal): Promise<DocumentationImportPlan> {
    return observeOperation(this.#observability, {
      operation: "documentation.preview",
      workspaceId,
      durationMetric: "abcm_documentation_operation_duration_ms",
      successMetrics: result => [{
        name: "abcm_documentation_sync_conflicts",
        value: (result as DocumentationImportPlan).operations.filter(operation => operation.operation === "conflict").length,
        unit: "count",
        operation: "documentation.preview",
        outcome: "success",
      }],
    }, () => this.#preview(workspaceId, sourceId, signal));
  }

  async #preview(workspaceId: string, sourceId: string, signal?: AbortSignal): Promise<DocumentationImportPlan> {
    throwIfAborted(signal);
    if (this.#state.getDocumentationSource(workspaceId, sourceId)?.storageMode === "managed") {
      throw new AbcmError("DOCUMENTATION_SOURCE_ALREADY_MANAGED", "Documentation source has already cut over to managed storage.");
    }
    const source = await this.#source(sourceId, signal);
    if (source.workspaceId !== workspaceId) {
      throw new AbcmError("SOURCE_CONNECTOR_UNAVAILABLE", `Documentation source '${sourceId}' is not configured for workspace '${workspaceId}'.`);
    }
    const snapshot = await this.#snapshot(source, signal);
    await this.#recoverPending(source, snapshot);
    const provenance = this.#state.listDocumentProvenance(workspaceId, sourceId);
    const activeBySourcePath = new Map(provenance.filter(record => record.active).map(record => [record.sourcePath, record]));
    const sourcePaths = new Set(snapshot.map(file => file.sourcePath));
    const removed = provenance.filter(record => record.active && !sourcePaths.has(record.sourcePath));
    const mapped = snapshot.map(file => ({ file, candidateTargetPaths: this.#mapTargets(source, file.sourcePath) }));
    const targetUseCount = new Map<string, number>();
    for (const entry of mapped) {
      if (entry.candidateTargetPaths.length !== 1) continue;
      const target = entry.candidateTargetPaths[0]!;
      targetUseCount.set(target, (targetUseCount.get(target) ?? 0) + 1);
    }
    const movedSources = new Set<string>();
    const operations: DocumentationImportOperation[] = [];

    for (const { file, candidateTargetPaths } of mapped) {
      throwIfAborted(signal);
      const targetPath = candidateTargetPaths[0] ?? posix.join(source.targetBasePath, file.sourcePath);
      if (candidateTargetPaths.length > 1 || (targetUseCount.get(targetPath) ?? 0) > 1) {
        operations.push({
          operation: "conflict",
          sourcePath: file.sourcePath,
          targetPath,
          sourceChecksum: file.checksum,
          conflictCode: "DOCUMENTATION_MAPPING_AMBIGUOUS",
          candidateTargetPaths,
        });
        continue;
      }
      const previous = activeBySourcePath.get(file.sourcePath);
      if (previous !== undefined && previous.targetPath !== targetPath) {
        const oldTarget = await this.#readTarget(workspaceId, previous.targetPath, signal);
        const newTarget = await this.#readTarget(workspaceId, targetPath, signal);
        operations.push(
          oldTarget?.checksum === previous.targetChecksum && newTarget === undefined
            ? {
                operation: "move",
                sourcePath: file.sourcePath,
                previousSourcePath: previous.sourcePath,
                targetPath,
                previousTargetPath: previous.targetPath,
                sourceChecksum: file.checksum,
                targetChecksum: previous.targetChecksum,
              }
            : {
                operation: "conflict",
                sourcePath: file.sourcePath,
                targetPath,
                sourceChecksum: file.checksum,
                ...(newTarget === undefined ? {} : { targetChecksum: newTarget.checksum }),
                conflictCode: "SOURCE_TARGET_CONFLICT",
              },
        );
      } else if (previous === undefined) {
        const moveCandidates = removed.filter(record => !movedSources.has(record.sourcePath) && record.sourceChecksum === file.checksum);
        if (moveCandidates.length === 1) {
          const move = moveCandidates[0]!;
          const oldTarget = await this.#readTarget(workspaceId, move.targetPath, signal);
          const newTarget = move.targetPath === targetPath ? oldTarget : await this.#readTarget(workspaceId, targetPath, signal);
          if (oldTarget?.checksum === move.targetChecksum && (move.targetPath === targetPath || newTarget === undefined)) {
            movedSources.add(move.sourcePath);
            operations.push({
              operation: "move",
              sourcePath: file.sourcePath,
              previousSourcePath: move.sourcePath,
              targetPath,
              previousTargetPath: move.targetPath,
              sourceChecksum: file.checksum,
              targetChecksum: move.targetChecksum,
            });
            continue;
          }
        }
        const current = await this.#readTarget(workspaceId, targetPath, signal);
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
      } else {
        const current = await this.#readTarget(workspaceId, targetPath, signal);
        if (current === undefined || current.checksum !== previous.targetChecksum) {
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
    }
    for (const previous of removed.filter(record => !movedSources.has(record.sourcePath))) {
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
    const workspaceId = this.#plans.get(importId)?.workspaceId;
    return observeOperation(this.#observability, {
      operation: "documentation.apply",
      ...(workspaceId === undefined ? {} : { workspaceId }),
      durationMetric: "abcm_documentation_operation_duration_ms",
    }, () => this.#apply(importId, signal));
  }

  async #apply(importId: string, signal?: AbortSignal): Promise<DocumentationSyncResult> {
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
      const code = conflicts.some(operation => operation.conflictCode === "DOCUMENTATION_MAPPING_AMBIGUOUS")
        ? "DOCUMENTATION_MAPPING_AMBIGUOUS"
        : "SOURCE_TARGET_CONFLICT";
      throw new AbcmError(code, "Documentation import contains mapping or source-target conflicts.", {
        importId,
        paths: conflicts.map(operation => operation.targetPath),
      });
    }
    const reservedTargets = plan.operations.flatMap(operation => [
      this.#targetKey(plan.workspaceId, operation.targetPath),
      ...(operation.previousTargetPath === undefined
        ? []
        : [this.#targetKey(plan.workspaceId, operation.previousTargetPath)]),
    ]);
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
        if (operation.operation === "move") {
          if (operation.previousTargetPath === undefined || operation.previousSourcePath === undefined) {
            throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Documentation move metadata is incomplete.");
          }
          const previousTarget = await this.#readTarget(plan.workspaceId, operation.previousTargetPath, signal);
          if (previousTarget?.checksum !== operation.targetChecksum) {
            throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Documentation move source changed after preview.", {
              path: operation.previousTargetPath,
            });
          }
          if (operation.previousTargetPath !== operation.targetPath && target !== undefined) {
            throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Documentation move target changed after preview.", {
              path: operation.targetPath,
            });
          }
        }
      }

      // From this point the multi-file import is intentionally non-preemptible:
      // completing provenance, tombstones and the map publication is safer than
      // returning a timeout after only part of the canonical snapshot was applied.
      throwIfAborted(signal);

      const startedAt = this.#clock().toISOString();
      const upserts: DocumentProvenanceRecord[] = [];
      const retirements: Pick<
        DocumentProvenanceRecord,
        "workspaceId" | "sourceId" | "sourcePath" | "lastSynchronizedAt"
      >[] = [];
      const deletions: TombstoneRecord[] = [];
      let created = 0;
      let updated = 0;
      let moved = 0;
      let deleted = 0;
      for (const operation of plan.operations) {
        const file = sourceFiles.get(operation.sourcePath);
        const synchronizedAt = this.#clock().toISOString();
        if (operation.operation === "create" || operation.operation === "update" || operation.operation === "unchanged" || operation.operation === "move") {
          if (file === undefined) throw new AbcmError("DOCUMENTATION_IMPORT_STALE", "Planned source file disappeared.");
          upserts.push({
            workspaceId: plan.workspaceId,
            sourceId: plan.sourceId,
            sourcePath: operation.sourcePath,
            targetPath: operation.targetPath,
            sourceChecksum: file.checksum,
            targetChecksum: file.checksum,
            lastSynchronizedAt: synchronizedAt,
            active: true,
          });
          if (operation.operation === "create") created++;
          else if (operation.operation === "update") updated++;
          else if (operation.operation === "move") {
            if (operation.previousSourcePath === undefined) throw new Error("Move source is unavailable.");
            retirements.push({
              workspaceId: plan.workspaceId,
              sourceId: plan.sourceId,
              sourcePath: operation.previousSourcePath,
              lastSynchronizedAt: synchronizedAt,
            });
            moved++;
          }
        } else if (operation.operation === "delete") {
          if (operation.targetChecksum === undefined) throw new Error("Delete checksum is unavailable.");
          deletions.push({
            resourceId: randomUUID(),
            workspaceId: plan.workspaceId,
            sourceId: plan.sourceId,
            formerPath: operation.targetPath,
            checksum: operation.targetChecksum,
            deletedAt: synchronizedAt,
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
        moved,
        deleted,
        conflicts: 0,
        status: "succeeded",
      };
      const commit = {
        source: { id: source.id, workspaceId: source.workspaceId, targetBasePath: source.targetBasePath },
        run,
        upserts,
        retirements,
        deletions,
      };
      this.#state.prepareDocumentationSync(commit);
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
          await this.#files.writeMirror(plan.workspaceId, operation.targetPath, file.content, preconditions);
        } else if (operation.operation === "move") {
          const file = sourceFiles.get(operation.sourcePath);
          if (
            file === undefined ||
            operation.targetChecksum === undefined ||
            operation.previousSourcePath === undefined ||
            operation.previousTargetPath === undefined
          ) {
            throw new Error("Move source is unavailable.");
          }
          const movedEntry = operation.previousTargetPath === operation.targetPath
            ? { checksum: operation.targetChecksum }
            : await this.#files.moveMirror(
                plan.workspaceId,
                operation.previousTargetPath,
                operation.targetPath,
                { ifMatch: operation.targetChecksum },
              );
          void movedEntry;
        } else if (operation.operation === "unchanged") {
          continue;
        } else if (operation.operation === "delete") {
          if (operation.targetChecksum === undefined) throw new Error("Delete checksum is unavailable.");
          await this.#files.deleteMirror(plan.workspaceId, operation.targetPath, { ifMatch: operation.targetChecksum });
        }
      }
      this.#state.commitDocumentationSync(commit);
      this.#plans.delete(importId);
      const revision = await this.#scopeMap.scan(plan.workspaceId);
      return { ...run, mapRevision: revision.revision };
    } finally {
      for (const target of reservedTargets) this.#reservedTargets.delete(target);
    }
  }

  async sync(sourceId: string, signal?: AbortSignal): Promise<DocumentationSyncResult> {
    const workspaceId = this.#sources.get(sourceId)?.workspaceId;
    return observeOperation(this.#observability, {
      operation: "documentation.sync",
      ...(workspaceId === undefined ? {} : { workspaceId }),
      durationMetric: "abcm_documentation_operation_duration_ms",
    }, () => this.#sync(sourceId, signal));
  }

  async #sync(sourceId: string, signal?: AbortSignal): Promise<DocumentationSyncResult> {
    const configured = this.#sources.get(sourceId);
    if (configured !== undefined && this.#state.getDocumentationSource(configured.workspaceId, sourceId)?.storageMode === "managed") {
      throw new AbcmError("DOCUMENTATION_SOURCE_ALREADY_MANAGED", "Documentation source has already cut over to managed storage.");
    }
    const source = await this.#source(sourceId, signal);
    return this.#apply((await this.#preview(source.workspaceId, sourceId, signal)).importId, signal);
  }

  async cutover(
    sourceId: string,
    input: { operatorApproved: true; expectedSnapshotDigest: string },
    signal?: AbortSignal,
  ): Promise<DocumentationCutoverResult> {
    const workspaceId = this.#sources.get(sourceId)?.workspaceId;
    return observeOperation(this.#observability, {
      operation: "documentation.cutover",
      ...(workspaceId === undefined ? {} : { workspaceId }),
      durationMetric: "abcm_documentation_operation_duration_ms",
    }, () => this.#cutover(sourceId, input, signal));
  }

  async #cutover(
    sourceId: string,
    input: { operatorApproved: true; expectedSnapshotDigest: string },
    signal?: AbortSignal,
  ): Promise<DocumentationCutoverResult> {
    throwIfAborted(signal);
    if (input.operatorApproved !== true) {
      throw new AbcmError("CUTOVER_APPROVAL_REQUIRED", "Documentation cutover requires explicit operator approval.");
    }
    const configured = this.#sources.get(sourceId);
    if (configured === undefined) throw new AbcmError("SOURCE_CONNECTOR_UNAVAILABLE", `Documentation source '${sourceId}' is unavailable.`);
    const existing = this.#state.getDocumentationCutover(configured.workspaceId, sourceId);
    if (existing?.status === "completed") return { ...existing, storageMode: "managed" };
    if (existing?.status === "committed") {
      const revision = await this.#scopeMap.scan(configured.workspaceId, signal);
      const completed = this.#state.completeDocumentationCutover(configured.workspaceId, existing.cutoverId, revision.revision);
      return { ...completed, storageMode: "managed" };
    }
    const source = await this.#source(sourceId, signal);
    const state = this.#state.getDocumentationSource(source.workspaceId, sourceId);
    if (state?.storageMode === "managed") {
      throw new AbcmError("DOCUMENTATION_SOURCE_ALREADY_MANAGED", "Documentation source has already cut over to managed storage.");
    }
    await this.#sync(sourceId, signal);
    const snapshot = await this.#snapshot(source, signal);
    const snapshotDigest = this.#snapshotDigest(snapshot);
    if (snapshotDigest !== input.expectedSnapshotDigest) {
      throw new AbcmError("CUTOVER_CHECKSUM_MISMATCH", "Documentation source changed after operator approval.", {
        expectedSnapshotDigest: input.expectedSnapshotDigest,
        actualSnapshotDigest: snapshotDigest,
      });
    }
    const sourceFiles = new Map(snapshot.map(file => [file.sourcePath, file]));
    const provenance = this.#state.listDocumentProvenance(source.workspaceId, sourceId).filter(record => record.active);
    for (const record of provenance) {
      const external = sourceFiles.get(record.sourcePath);
      const target = await this.#readTarget(source.workspaceId, record.targetPath, signal);
      if (
        external?.checksum !== record.sourceChecksum ||
        target?.checksum !== record.targetChecksum ||
        external.checksum !== target.checksum
      ) {
        throw new AbcmError("CUTOVER_CHECKSUM_MISMATCH", "Source and mirror checksums do not match for cutover.", {
          sourcePath: record.sourcePath,
          targetPath: record.targetPath,
        });
      }
    }
    if (provenance.length !== snapshot.length) {
      throw new AbcmError("CUTOVER_CHECKSUM_MISMATCH", "Cutover selection does not match active mirror provenance.");
    }
    throwIfAborted(signal);
    const record: DocumentationCutoverRecord = {
      cutoverId: randomUUID(),
      workspaceId: source.workspaceId,
      sourceId,
      snapshotDigest,
      documentCount: provenance.length,
      cutoverAt: this.#clock().toISOString(),
      status: "committed",
    };
    this.#state.commitDocumentationCutover(record);
    const revision = await this.#scopeMap.scan(source.workspaceId);
    const completed = this.#state.completeDocumentationCutover(source.workspaceId, record.cutoverId, revision.revision);
    return { ...completed, storageMode: "managed" };
  }

  async #recoverPending(source: ResolvedSource, snapshot: readonly SourceFile[]): Promise<void> {
    const pending = this.#state.getPendingDocumentationSync(source.workspaceId, source.id);
    if (pending === undefined) return;
    const sourceFiles = new Map(snapshot.map(file => [file.sourcePath, file]));
    const active = new Map(
      this.#state
        .listDocumentProvenance(source.workspaceId, source.id)
        .filter(record => record.active)
        .map(record => [record.sourcePath, record]),
    );
    try {
      for (const record of pending.upserts) {
        const sourceFile = sourceFiles.get(record.sourcePath);
        if (sourceFile?.checksum !== record.sourceChecksum) {
          throw new AbcmError("DOCUMENTATION_RECOVERY_REQUIRED", "Pending sync source bytes no longer match the journal.", {
            sourcePath: record.sourcePath,
          });
        }
        const current = await this.#readTarget(record.workspaceId, record.targetPath);
        if (current === undefined) {
          await this.#files.writeMirror(record.workspaceId, record.targetPath, sourceFile.content, { ifNoneMatch: "*" });
        } else if (current.checksum !== record.targetChecksum) {
          throw new AbcmError("DOCUMENTATION_RECOVERY_REQUIRED", "Pending sync target bytes diverged from the journal.", {
            targetPath: record.targetPath,
          });
        }
      }
      for (const retirement of pending.retirements ?? []) {
        const previous = active.get(retirement.sourcePath);
        if (previous === undefined || pending.upserts.some(record => record.targetPath === previous.targetPath)) continue;
        const current = await this.#readTarget(previous.workspaceId, previous.targetPath);
        if (current === undefined) continue;
        if (current.checksum !== previous.targetChecksum) {
          throw new AbcmError("DOCUMENTATION_RECOVERY_REQUIRED", "Pending move source diverged from the journal.", {
            targetPath: previous.targetPath,
          });
        }
        await this.#files.deleteMirror(previous.workspaceId, previous.targetPath, { ifMatch: previous.targetChecksum });
      }
      for (const tombstone of pending.deletions) {
        const current = await this.#readTarget(tombstone.workspaceId, tombstone.formerPath);
        if (current === undefined) continue;
        if (current.checksum !== tombstone.checksum) {
          throw new AbcmError("DOCUMENTATION_RECOVERY_REQUIRED", "Pending deletion target diverged from the journal.", {
            targetPath: tombstone.formerPath,
          });
        }
        await this.#files.deleteMirror(tombstone.workspaceId, tombstone.formerPath, { ifMatch: tombstone.checksum });
      }
      this.#state.commitDocumentationSync(pending);
      await this.#scopeMap.scan(source.workspaceId);
    } catch (error) {
      if (error instanceof AbcmError && error.code === "DOCUMENTATION_RECOVERY_REQUIRED") throw error;
      throw new AbcmError("DOCUMENTATION_RECOVERY_REQUIRED", "Pending documentation sync could not be recovered.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
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
          if (!this.#matchesSourcePath(source, sourcePath)) continue;
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

  #matchesSourcePath(source: ResolvedSource, sourcePath: string): boolean {
    const included = source.include === undefined || source.include.some(pattern => globRegex(pattern).test(sourcePath));
    return included && !(source.exclude ?? []).some(pattern => globRegex(pattern).test(sourcePath));
  }

  #mapTargets(source: ResolvedSource, sourcePath: string): string[] {
    const matches = (source.mapping ?? []).filter(rule => globRegex(rule.match).test(sourcePath));
    if (matches.length === 0) return [posix.join(source.targetBasePath, sourcePath)];
    return [...new Set(matches.map(rule => mappingTarget(sourcePath, rule.match, rule.target)))].sort((left, right) =>
      left.localeCompare(right),
    );
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
