import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, posix } from "node:path";

import { Database } from "bun:sqlite";

import type { ArtifactAmendmentService } from "../artifacts/amendment-service.js";
import { AbcmError } from "../core/errors.js";
import { emitAudit, type AbcmObservability } from "../core/observability.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import {
  portablePathKey,
  syncApplyBatchSchema,
  syncConflictIdSchema,
  syncConflictSchema,
  syncConflictResolutionSchema,
  syncPairingCreateSchema,
  syncPairingRedeemSchema,
  syncPortablePathSchema,
  syncPortableInventorySchema,
  syncPreviewRequestSchema,
  type SyncApplyOperation,
  type SyncConflict,
  type SyncConflictResolution,
  type SyncPreviewResult,
} from "./contracts.js";
import { planIdentityAwarePreview } from "./preview-planner.js";
import {
  SqliteObsidianDeviceStore,
  type ObsidianDevicePrincipal,
} from "./sqlite-device-store.js";
import { SqliteSyncJournal, type SyncJournalMutation } from "./sqlite-sync-journal.js";

const DEFAULT_PREVIEW_TTL_SECONDS = 600;

export interface ObsidianSyncServiceOptions {
  stateRoot: string;
  clock?: () => number;
  previewTtlSeconds?: number;
  credentialTtlSeconds?: number;
  observability?: AbcmObservability;
  reservedReadOnlyMappings?: readonly { workspaceId: string; targetBasePath: string }[];
  artifactAmendments?: ArtifactAmendmentService;
}

interface StoredPreview {
  preview_id: string;
  device_id: string;
  workspace_id: string;
  project_id: string;
  server_revision: string;
  cursor: string;
  expires_at_ms: number;
  plan_json: string;
}

interface StoredReceipt { request_digest: string; receipt_json: string }
interface StoredConflict { payload_json: string; local_content: Uint8Array | null; status: "open" | "resolved" }

type OperationReceipt = {
  operationId: string;
  cursor: string;
  objectId: string;
  checksum: string | null;
  status: "applied" | "duplicate" | "conflict";
  conflictId?: string;
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function checksumBytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function globMatches(path: string, pattern: string): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*" && pattern[index + 1] === "*") { source += ".*"; index += 1; }
    else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.charCodeAt(0) === 92 || "^$.*+?()[]{}|".includes(character) ? String.fromCharCode(92) + character : character;
  }
  return new RegExp(`${source}$`, "u").test(path);
}

function includedByFilters(path: string, include: readonly string[] | undefined, exclude: readonly string[] | undefined): boolean {
  const included = include === undefined || include.length === 0 || include.some(pattern => globMatches(path, pattern));
  return included && !(exclude?.some(pattern => globMatches(path, pattern)) ?? false);
}

function excludedSyncPath(path: string): boolean {
  const root = path.split("/", 1)[0]?.toLocaleLowerCase("en-US");
  return root === ".obsidian" || root === "_abcm conflicts";
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) throw new AbcmError("AUTHENTICATION_REQUIRED", "A valid Obsidian device bearer credential is required.");
  return header.slice("Bearer ".length);
}

function safeSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class ObsidianSyncService {
  readonly #registry: WorkspaceRegistry;
  readonly #files: WorkspaceFileService;
  readonly #stateRoot: string;
  readonly #devices: SqliteObsidianDeviceStore;
  readonly #control: Database;
  readonly #clock: () => number;
  readonly #previewTtlSeconds: number;
  readonly #observability: AbcmObservability | undefined;
  readonly #reservedReadOnlyMappings: readonly { workspaceId: string; targetBasePath: string }[];
  readonly #artifactAmendments: ArtifactAmendmentService | undefined;
  readonly #journals = new Map<string, SqliteSyncJournal>();
  #captureSuppression = 0;

  constructor(registry: WorkspaceRegistry, files: WorkspaceFileService, options: ObsidianSyncServiceOptions) {
    if (!Number.isSafeInteger(options.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS) || (options.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS) < 60) {
      throw new Error("Obsidian synchronization preview TTL must be at least 60 seconds.");
    }
    this.#registry = registry;
    this.#files = files;
    this.#stateRoot = options.stateRoot;
    this.#clock = options.clock ?? Date.now;
    this.#previewTtlSeconds = options.previewTtlSeconds ?? DEFAULT_PREVIEW_TTL_SECONDS;
    this.#observability = options.observability;
    this.#reservedReadOnlyMappings = options.reservedReadOnlyMappings ?? [];
    this.#artifactAmendments = options.artifactAmendments;
    mkdirSync(options.stateRoot, { recursive: true });
    this.#devices = new SqliteObsidianDeviceStore(join(options.stateRoot, "obsidian-devices.sqlite"), {
      clock: this.#clock,
      ...(options.credentialTtlSeconds === undefined ? {} : { credentialTtlSeconds: options.credentialTtlSeconds }),
    });
    this.#control = new Database(join(options.stateRoot, "obsidian-sync-control.sqlite"), { create: true, readwrite: true });
    this.#control.run("PRAGMA busy_timeout = 5000");
    this.#control.run("PRAGMA journal_mode = DELETE");
    this.#migrate();
  }

  createPairing(input: unknown) {
    const parsed = syncPairingCreateSchema.parse(input);
    try {
      this.#registry.get(parsed.workspaceId);
      const prefix = syncPortablePathSchema.parse(parsed.projectPrefix ?? parsed.projectId);
      const overlapsMirror = this.#reservedReadOnlyMappings.some(mapping => mapping.workspaceId === parsed.workspaceId
        && (prefix === mapping.targetBasePath || prefix.startsWith(mapping.targetBasePath + "/") || mapping.targetBasePath.startsWith(prefix + "/")));
      if (overlapsMirror) throw new AbcmError("MIRROR_DOCUMENT_READ_ONLY", "Bidirectional synchronization cannot overlap an active read-only documentation mapping.", { workspaceId: parsed.workspaceId, projectId: parsed.projectId, projectPrefix: prefix });
      const result = this.#devices.createPairing(parsed);
      this.#audit("sync.pairing.create", "success", parsed.workspaceId);
      return result;
    } catch (error) {
      this.#audit("sync.pairing.create", error instanceof AbcmError && ["ACCESS_DENIED", "MIRROR_DOCUMENT_READ_ONLY"].includes(error.code) ? "denied" : "failure", parsed.workspaceId);
      throw error;
    }
  }

  redeemPairing(input: unknown) {
    const parsed = syncPairingRedeemSchema.parse(input);
    try {
      const result = this.#devices.redeemPairing(parsed);
      this.#audit("sync.pairing.redeem", "success", result.workspaceId, result.deviceId);
      return result;
    } catch (error) {
      this.#audit("sync.pairing.redeem", "denied");
      throw error;
    }
  }

  revokeDevice(deviceId: string): void {
    this.#devices.revokeDevice(deviceId);
    this.#audit("sync.device.revoke", "success", undefined, deviceId);
  }

  async preview(request: Request, workspaceId: string, projectId: string, input: unknown, signal?: AbortSignal): Promise<SyncPreviewResult> {
    const principal = this.#authenticate(request, workspaceId, projectId, "read");
    const parsed = syncPreviewRequestSchema.parse(input);
    const journal = this.#journal(workspaceId, projectId);
    const server = (await this.#inventory(principal, signal)).filter(entry => includedByFilters(entry.path, parsed.include, parsed.exclude));
    const localInventory = parsed.inventory.filter(entry => includedByFilters(entry.path, parsed.include, parsed.exclude));
    for (const entry of server) {
      journal.ensureObjectSnapshot({
        objectId: journal.getObjectByPath(entry.path)?.objectId ?? this.#initialObjectId(workspaceId, projectId, entry.path),
        path: entry.path,
        checksum: entry.checksum,
      });
    }
    const items = parsed.base === undefined
      ? this.#legacyPreviewItems(workspaceId, projectId, parsed.cursor, localInventory, server, journal)
      : planIdentityAwarePreview({
        base: parsed.base.filter(entry => includedByFilters(entry.path, parsed.include, parsed.exclude)),
        local: localInventory,
        ...(parsed.identityHints === undefined ? {} : {
          identityHints: parsed.identityHints.filter(hint =>
            includedByFilters(hint.previousPath, parsed.include, parsed.exclude) &&
            includedByFilters(hint.path, parsed.include, parsed.exclude)
          ),
        }),
        server: server.map(entry => ({
          ...entry,
          objectId: journal.getObjectByPath(entry.path)?.objectId ?? this.#initialObjectId(workspaceId, projectId, entry.path),
        })),
        objectIdForPath: path => this.#initialObjectId(workspaceId, projectId, path),
      });
    const previewId = `preview_${randomUUID().replaceAll("-", "")}`;
    const serverRevision = digest(server.map(({ path, checksum, size }) => ({ path, checksum, size })));
    const cursor = journal.currentCursor();
    const expiresAtMs = this.#clock() + this.#previewTtlSeconds * 1_000;
    this.#control.run(
      `INSERT INTO sync_previews (preview_id, device_id, workspace_id, project_id, server_revision, cursor, local_inventory_digest, plan_json, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [previewId, principal.deviceId, workspaceId, projectId, serverRevision, cursor, digest(localInventory), JSON.stringify({ inventory: localInventory, items }), expiresAtMs],
    );
    this.#audit("sync.preview", "success", workspaceId, principal.deviceId);
    return { previewId, serverRevision, cursor, expiresAt: new Date(expiresAtMs).toISOString(), items };
  }

  #legacyPreviewItems(workspaceId: string, projectId: string, cursor: string | null, localInventory: { path: string; checksum: string; size: number }[], server: { path: string; checksum: string; size: number }[], journal: SqliteSyncJournal): SyncPreviewResult["items"] {
    const hasUnseenServerChanges = cursor !== null && journal.changesAfter(cursor, 1).changes.length > 0;
    const localByPath = new Map(localInventory.map(entry => [portablePathKey(entry.path), entry]));
    const serverByPath = new Map(server.map(entry => [portablePathKey(entry.path), entry]));
    const keys = [...new Set([...localByPath.keys(), ...serverByPath.keys()])].sort();
    return keys.map(key => {
      const local = localByPath.get(key);
      const remote = serverByPath.get(key);
      const path = local?.path ?? remote!.path;
      return {
        action: local === undefined ? "create-local" as const : remote === undefined ? "create-server" as const : local.checksum === remote.checksum ? "noop" as const : cursor === null || hasUnseenServerChanges ? "conflict" as const : "update-server" as const,
        objectId: journal.getObjectByPath(path)?.objectId ?? this.#initialObjectId(workspaceId, projectId, path),
        path,
        localChecksum: local?.checksum ?? null,
        serverChecksum: remote?.checksum ?? null,
        size: local?.size ?? remote?.size ?? null,
      };
    });
  }

  async readContent(request: Request, workspaceId: string, projectId: string, path: string, signal?: AbortSignal) {
    const principal = this.#authenticate(request, workspaceId, projectId, "read");
    const relativePath = syncPortablePathSchema.parse(path);
    const result = await this.#files.read(workspaceId, this.#fullPath(principal, relativePath), signal);
    const objectId = this.#journal(workspaceId, projectId).getObjectByPath(relativePath)?.objectId
      ?? this.#initialObjectId(workspaceId, projectId, relativePath);
    return { ...result, entry: { ...result.entry, path: relativePath }, objectId };
  }

  changes(request: Request, workspaceId: string, projectId: string, cursor: string, limit: number) {
    const principal = this.#authenticate(request, workspaceId, projectId, "read");
    const result = this.#journal(workspaceId, projectId).changesAfter(cursor, limit);
    this.#audit("sync.changes", "success", workspaceId, principal.deviceId);
    return result;
  }

  async apply(request: Request, workspaceId: string, projectId: string, input: unknown, signal?: AbortSignal): Promise<{ receipts: OperationReceipt[] }> {
    const principal = this.#authenticate(request, workspaceId, projectId, "write");
    const batch = syncApplyBatchSchema.parse(input);
    const known = new Map<string, OperationReceipt>();
    for (const operation of batch.operations) {
      const existing = this.#receipt(operation.operationId);
      if (existing === undefined) continue;
      if (existing.request_digest !== digest(operation)) {
        throw new AbcmError("SYNC_IDEMPOTENCY_CONFLICT", "Synchronization operation id was reused with different content.", { operationId: operation.operationId });
      }
      known.set(operation.operationId, JSON.parse(existing.receipt_json) as OperationReceipt);
    }
    if (known.size === batch.operations.length) {
      return { receipts: batch.operations.map(operation => {
        const receipt = known.get(operation.operationId)!;
        return receipt.status === "applied" ? { ...receipt, status: "duplicate" as const } : receipt;
      }) };
    }
    const preview = this.#requiredPreview(batch.previewId, principal, workspaceId, projectId);
    if (preview.server_revision !== batch.serverRevision || preview.cursor !== batch.cursor) {
      throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization batch does not match its pinned preview revision and cursor.");
    }
    this.#journal(workspaceId, projectId).changesAfter(batch.cursor, 1);
    const receipts: OperationReceipt[] = [];
    for (const operation of batch.operations) {
      const existing = known.get(operation.operationId);
      if (existing !== undefined) {
        receipts.push(existing.status === "applied" ? { ...existing, status: "duplicate" } : existing);
        continue;
      }
      const previewAction = this.#assertPreviewOperation(preview, operation);
      if (previewAction === "conflict") {
        await this.#ensureJournalBase(principal, this.#journal(workspaceId, projectId), operation, signal);
        receipts.push(await this.#recordConflict(principal, operation, digest(operation)));
      } else {
        receipts.push(await this.#applyOperation(principal, operation, digest(operation), signal));
      }
    }
    this.#audit("sync.apply", "success", workspaceId, principal.deviceId);
    return { receipts };
  }

  getConflict(request: Request, workspaceId: string, projectId: string, conflictId: string): SyncConflict {
    this.#authenticate(request, workspaceId, projectId, "read");
    syncConflictIdSchema.parse(conflictId);
    const row = this.#control.query<StoredConflict, [string, string, string]>(
      "SELECT payload_json, local_content, status FROM sync_conflicts WHERE conflict_id = ? AND workspace_id = ? AND project_id = ?",
    ).get(conflictId, workspaceId, projectId);
    if (row === null) throw new AbcmError("SYNC_OBJECT_NOT_FOUND", "Synchronization conflict was not found.", { conflictId });
    return { ...(JSON.parse(row.payload_json) as SyncConflict), status: row.status };
  }

  async resolveConflict(request: Request, workspaceId: string, projectId: string, conflictId: string, input: unknown, signal?: AbortSignal): Promise<OperationReceipt> {
    const principal = this.#authenticate(request, workspaceId, projectId, "write");
    const resolution = syncConflictResolutionSchema.parse(input);
    const resolutionDigest = digest(resolution);
    const existingReceipt = this.#receipt(resolution.operationId);
    if (existingReceipt !== undefined) {
      if (existingReceipt.request_digest !== resolutionDigest) throw new AbcmError("SYNC_IDEMPOTENCY_CONFLICT", "Conflict resolution operation id was reused with different content.", { operationId: resolution.operationId });
      const receipt = JSON.parse(existingReceipt.receipt_json) as OperationReceipt;
      return receipt.status === "applied" ? { ...receipt, status: "duplicate" } : receipt;
    }
    const row = this.#control.query<StoredConflict, [string, string, string]>(
      "SELECT payload_json, local_content, status FROM sync_conflicts WHERE conflict_id = ? AND workspace_id = ? AND project_id = ?",
    ).get(conflictId, workspaceId, projectId);
    if (row === null) throw new AbcmError("SYNC_OBJECT_NOT_FOUND", "Synchronization conflict was not found.", { conflictId });
    if (row.status !== "open") throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization conflict is already resolved.", { conflictId });
    const conflict = syncConflictSchema.parse(JSON.parse(row.payload_json));
    this.#assertResolutionChecksums(conflict, resolution);
    const journal = this.#journal(workspaceId, projectId);
    const current = journal.getObject(conflict.objectId);
    const serverChecksum = conflict.server.state === "present" ? conflict.server.checksum : null;
    if (conflict.server.state === "present") {
      if (conflict.serverPath === null || current === undefined || current.deleted || current.path !== conflict.serverPath || current.checksum !== conflict.server.checksum) {
        throw new AbcmError("SYNC_OBJECT_CONFLICT", "Server conflict state changed before resolution.", { conflictId });
      }
    } else if (current !== undefined && !current.deleted) {
      throw new AbcmError("SYNC_OBJECT_CONFLICT", "Server conflict deletion changed before resolution.", { conflictId });
    }

    const localBytes = (): Uint8Array => {
      if (conflict.local.state !== "present" || conflict.localPath === null || row.local_content === null) {
        throw new AbcmError("SYNC_OBJECT_CONFLICT", "Conflict has no local bytes to preserve.");
      }
      if (row.local_content.byteLength !== conflict.local.size || checksumBytes(row.local_content) !== conflict.local.checksum) {
        throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Stored conflict bytes do not match conflict metadata.", { conflictId });
      }
      return row.local_content;
    };
    const internalOperationId = (purpose: string): string =>
      "op_" + createHash("sha256").update(resolution.operationId + "\0" + purpose).digest("hex").slice(0, 32);
    const objectIdForCopy = (path: string): string =>
      "obj_" + createHash("sha256").update(resolution.operationId + "\0" + path).digest("hex").slice(0, 32);
    const withSuppressedCapture = async <T>(action: () => Promise<T>): Promise<T> => {
      this.#captureSuppression += 1;
      try { return await action(); }
      finally { this.#captureSuppression -= 1; }
    };
    const createCopy = async (path: string, content: Uint8Array, checksum: string, contentType: string, operationId: string) => {
      const fullPath = this.#fullPath(principal, path);
      const existing = await this.#tryRead(workspaceId, fullPath);
      let entry = existing?.entry;
      if (existing !== undefined && existing.entry.checksum !== checksum) {
        throw new AbcmError("SYNC_OBJECT_CONFLICT", "Conflict copy path is occupied by different bytes.", { path });
      }
      if (existing === undefined) {
        entry = await withSuppressedCapture(() => this.#files.write(workspaceId, fullPath, content, { ifNoneMatch: "*" }, signal));
      }
      if (entry === undefined || entry.checksum !== checksum) throw new AbcmError("SYNC_OBJECT_CONFLICT", "Conflict copy checksum verification failed.", { path });
      return journal.record({
        kind: "create", operationId, originDeviceId: principal.deviceId, objectId: objectIdForCopy(path),
        path, checksum: entry.checksum, size: entry.size, contentType,
      }).event;
    };
    const deleteServer = async (operationId: string) => {
      if (conflict.server.state !== "present" || conflict.serverPath === null || current === undefined || current.deleted) return undefined;
      await withSuppressedCapture(() => this.#files.delete(
        workspaceId, this.#fullPath(principal, conflict.serverPath!), { ifMatch: serverChecksum! }, signal,
      ));
      return journal.record({
        kind: "delete", operationId, originDeviceId: principal.deviceId, objectId: current.objectId,
        path: current.path, baseChecksum: current.checksum,
      }).event;
    };

    let event: { cursor: string; objectId: string; checksum?: string } | undefined;
    if (resolution.resolution === "keep-server") {
      // The server is already authoritative; the checksummed resolution itself is the auditable operation.
    } else if (resolution.resolution === "keep-local") {
      if (conflict.local.state === "deleted") {
        event = await deleteServer(resolution.operationId);
      } else {
        const content = localBytes();
        const localPath = conflict.localPath!;
        if (conflict.server.state === "deleted") {
          const restored = await withSuppressedCapture(() => this.#files.write(
            workspaceId, this.#fullPath(principal, localPath), content, { ifNoneMatch: "*" }, signal,
          ));
          event = journal.record({
            kind: "create", operationId: resolution.operationId, originDeviceId: principal.deviceId,
            objectId: conflict.objectId, path: localPath, checksum: restored.checksum,
            size: restored.size, contentType: conflict.local.contentType,
          }).event;
        } else if (current !== undefined && conflict.serverPath === localPath) {
          const written = await withSuppressedCapture(() => this.#files.write(
            workspaceId, this.#fullPath(principal, localPath), content, { ifMatch: serverChecksum! }, signal,
          ));
          event = journal.record({
            kind: "update", operationId: resolution.operationId, originDeviceId: principal.deviceId,
            objectId: current.objectId, path: current.path, baseChecksum: current.checksum,
            checksum: written.checksum, size: written.size, contentType: conflict.local.contentType,
          }).event;
        } else if (current !== undefined && conflict.serverPath !== null) {
          const moved = await withSuppressedCapture(async () => {
            await this.#files.move(
              workspaceId, this.#fullPath(principal, conflict.serverPath!), this.#fullPath(principal, localPath),
              { ifMatch: serverChecksum! }, signal,
            );
            return this.#files.write(
              workspaceId, this.#fullPath(principal, localPath), content, { ifMatch: serverChecksum! }, signal,
            );
          });
          event = journal.record({
            kind: "move", operationId: resolution.operationId, originDeviceId: principal.deviceId,
            objectId: current.objectId, previousPath: current.path, path: localPath, baseChecksum: current.checksum,
            checksum: moved.checksum, size: moved.size, contentType: conflict.local.contentType,
          }).event;
        }
      }
    } else if (conflict.local.state === "present") {
      event = await createCopy(resolution.keepBothPath, localBytes(), conflict.local.checksum, conflict.local.contentType, resolution.operationId);
    } else if (conflict.server.state === "present" && conflict.serverPath !== null) {
      const serverContent = await this.#files.read(workspaceId, this.#fullPath(principal, conflict.serverPath), signal);
      if (serverContent.entry.checksum !== serverChecksum!) {
        throw new AbcmError("SYNC_OBJECT_CONFLICT", "Server conflict bytes changed before keep-both resolution.", { conflictId });
      }
      await createCopy(
        resolution.keepBothPath, serverContent.content, serverChecksum!, conflict.server.contentType,
        internalOperationId("keep-both-copy"),
      );
      event = await deleteServer(resolution.operationId);
    }

    this.#control.run("UPDATE sync_conflicts SET status = 'resolved', resolved_at_ms = ?, resolution_json = ? WHERE conflict_id = ?", [this.#clock(), JSON.stringify(resolution), conflictId]);
    const receipt: OperationReceipt = {
      operationId: resolution.operationId,
      cursor: event?.cursor ?? journal.currentCursor(),
      objectId: event?.objectId ?? conflict.objectId,
      checksum: event !== undefined && "checksum" in event ? event.checksum ?? null : conflict.server.state === "present" ? serverChecksum! : null,
      status: "applied",
    };
    this.#storeReceipt(resolution.operationId, resolutionDigest, receipt);
    this.#audit("sync.conflict.resolve", "success", workspaceId, principal.deviceId);
    return receipt;
  }

  async captureWorkspaceMutation(workspaceId: string, changedPaths: readonly string[]): Promise<void> {
    if (this.#captureSuppression > 0) return;
    for (const scope of this.#devices.listActiveProjectScopes(workspaceId)) {
      const prefix = scope.projectPrefix ?? scope.projectId;
      const relativePaths = changedPaths.map(path => this.#relativePath(prefix, path)).filter((path): path is string => path !== undefined);
      if (relativePaths.length === 0) continue;
      const journal = this.#journal(workspaceId, scope.projectId);
      if (relativePaths.length === 2) {
        const sourceObject = journal.getObjectByPath(relativePaths[0]!);
        const target = await this.#tryRead(workspaceId, posix.join(prefix, relativePaths[1]!));
        if (sourceObject !== undefined && !sourceObject.deleted && target !== undefined) {
          journal.record({ kind: "move", operationId: `op_external_${randomUUID().replaceAll("-", "")}`, originDeviceId: null,
            objectId: sourceObject.objectId, previousPath: relativePaths[0]!, path: relativePaths[1]!, baseChecksum: sourceObject.checksum,
            checksum: target.entry.checksum, size: target.entry.size, contentType: target.contentType });
          continue;
        }
      }
      for (const relativePath of relativePaths) await this.#capturePath(workspaceId, prefix, relativePath, journal);
    }
  }

  close(): void {
    for (const journal of this.#journals.values()) journal.close();
    this.#journals.clear();
    this.#devices.close();
    this.#control.close();
  }

  async #applyOperation(principal: ObsidianDevicePrincipal, operation: SyncApplyOperation, requestDigest: string, signal?: AbortSignal): Promise<OperationReceipt> {
    const journal = this.#journal(principal.workspaceId, principal.projectId);
    try {
      await this.#ensureJournalBase(principal, journal, operation, signal);
      this.#assertJournalPrecondition(journal, operation);
      this.#captureSuppression += 1;
      let entry: { checksum: string; size: number } | undefined;
      let moveContentType: string | undefined;
      try {
        if (operation.kind === "create" || operation.kind === "update") {
          const content = this.#content(operation);
          const amendment = operation.kind === "update"
            ? await this.#artifactAmendments?.acceptIntegratedEdit({
                workspaceId: principal.workspaceId,
                path: this.#fullPath(principal, operation.path),
                baseChecksum: operation.baseChecksum,
                content,
                operationId: operation.operationId,
                integrationIdentity: principal.deviceId,
              }, signal)
            : undefined;
          entry = amendment === undefined
            ? await this.#files.write(
                principal.workspaceId,
                this.#fullPath(principal, operation.path),
                content,
                operation.kind === "create" ? { ifNoneMatch: "*" } : { ifMatch: operation.baseChecksum },
                signal,
              )
            : (await this.#files.read(principal.workspaceId, this.#fullPath(principal, operation.path), signal)).entry;
        } else if (operation.kind === "delete") {
          await this.#files.delete(principal.workspaceId, this.#fullPath(principal, operation.path), { ifMatch: operation.baseChecksum }, signal);
        } else {
          const content = this.#content(operation);
          entry = await this.#files.move(
            principal.workspaceId,
            this.#fullPath(principal, operation.previousPath),
            this.#fullPath(principal, operation.path),
            { ifMatch: operation.baseChecksum },
            signal,
          );
          if (entry.checksum !== operation.checksum) {
            entry = await this.#files.write(
              principal.workspaceId,
              this.#fullPath(principal, operation.path),
              content,
              { ifMatch: entry.checksum },
              signal,
            );
            moveContentType = operation.contentType;
          } else {
            moveContentType = (await this.#files.read(principal.workspaceId, this.#fullPath(principal, operation.path), signal)).contentType;
          }
        }
      } finally {
        this.#captureSuppression -= 1;
      }
      const recorded = journal.record(this.#mutation(operation, principal.deviceId, entry, moveContentType));
      const receipt: OperationReceipt = {
        operationId: operation.operationId,
        cursor: recorded.event.cursor,
        objectId: recorded.event.objectId,
        checksum: operation.kind === "delete" ? null : entry?.checksum ?? operation.checksum,
        status: recorded.status,
      };
      this.#storeReceipt(operation.operationId, requestDigest, receipt);
      return receipt;
    } catch (error) {
      if (!(error instanceof AbcmError) || ![
        "FILE_ALREADY_EXISTS",
        "FILE_CHECKSUM_MISMATCH",
        "SYNC_OBJECT_CONFLICT",
        "SYNC_OBJECT_NOT_FOUND",
        "ARTIFACT_AMENDMENT_CONFLICT",
        "ARTIFACT_AMENDMENT_INVALID",
      ].includes(error.code)) throw error;
      const receipt = await this.#recordConflict(principal, operation, requestDigest);
      return receipt;
    }
  }

  async #ensureJournalBase(principal: ObsidianDevicePrincipal, journal: SqliteSyncJournal, operation: SyncApplyOperation, signal?: AbortSignal): Promise<void> {
    if (operation.kind === "create" || journal.getObject(operation.objectId) !== undefined) return;
    const basePath = operation.kind === "move" ? operation.previousPath : operation.path;
    const current = await this.#tryRead(principal.workspaceId, this.#fullPath(principal, basePath));
    if (current === undefined || current.entry.checksum !== operation.baseChecksum) return;
    if (signal?.aborted) throw signal.reason;
    journal.record({
      kind: "create", operationId: `op_snapshot_${randomUUID().replaceAll("-", "")}`, originDeviceId: null,
      objectId: operation.objectId, path: basePath, checksum: current.entry.checksum, size: current.entry.size, contentType: current.contentType,
    });
  }

  #initialObjectId(workspaceId: string, projectId: string, path: string): string {
    return `obj_${createHash("sha256").update(`${workspaceId}\0${projectId}\0${portablePathKey(path)}`).digest("hex").slice(0, 32)}`;
  }

  #assertJournalPrecondition(journal: SqliteSyncJournal, operation: SyncApplyOperation): void {
    const byId = journal.getObject(operation.objectId);
    if (operation.kind === "create") {
      if (byId !== undefined || journal.getObjectByPath(operation.path) !== undefined) throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization create object or path already exists.");
      return;
    }
    if (byId === undefined) throw new AbcmError("SYNC_OBJECT_NOT_FOUND", "Synchronization object was not found.", { objectId: operation.objectId });
    const expectedPath = operation.kind === "move" ? operation.previousPath : operation.path;
    if (byId.deleted || byId.path !== expectedPath || byId.checksum !== operation.baseChecksum) {
      throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization object differs from the requested base.", { objectId: operation.objectId });
    }
    if (operation.kind === "move") {
      const target = journal.getObjectByPath(operation.path);
      if (target !== undefined && target.objectId !== operation.objectId) throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization move target is occupied.", { path: operation.path });
    }
  }

  #mutation(
    operation: SyncApplyOperation,
    deviceId: string,
    entry?: { checksum?: string; size: number },
    moveContentType?: string,
  ): SyncJournalMutation {
    if (operation.kind === "create") return { kind: "create", operationId: operation.operationId, originDeviceId: deviceId, objectId: operation.objectId, path: operation.path, checksum: operation.checksum, size: operation.size, contentType: operation.contentType };
    if (operation.kind === "update") return {
      kind: "update",
      operationId: operation.operationId,
      originDeviceId: deviceId,
      objectId: operation.objectId,
      path: operation.path,
      baseChecksum: operation.baseChecksum,
      checksum: entry?.checksum ?? operation.checksum,
      size: entry?.size ?? operation.size,
      contentType: operation.contentType,
    };
    if (operation.kind === "delete") return { kind: "delete", operationId: operation.operationId, originDeviceId: deviceId, objectId: operation.objectId, path: operation.path, baseChecksum: operation.baseChecksum };
    return { kind: "move", operationId: operation.operationId, originDeviceId: deviceId, objectId: operation.objectId, previousPath: operation.previousPath, path: operation.path, baseChecksum: operation.baseChecksum, checksum: operation.checksum, size: entry?.size ?? 0, contentType: moveContentType ?? "application/octet-stream" };
  }

  #content(operation: Extract<SyncApplyOperation, { kind: "create" | "update" | "move" }>): Uint8Array {
    const content = Uint8Array.from(Buffer.from(operation.contentBase64, "base64"));
    if (content.byteLength !== operation.size || checksumBytes(content) !== operation.checksum) {
      throw new AbcmError("REQUEST_INVALID", "Synchronization content size or checksum does not match its declaration.");
    }
    return content;
  }

  async #recordConflict(principal: ObsidianDevicePrincipal, operation: SyncApplyOperation, requestDigest: string): Promise<OperationReceipt> {
    const conflictId = `conflict_${randomUUID().replaceAll("-", "")}`;
    const journal = this.#journal(principal.workspaceId, principal.projectId);
    const serverObject = journal.getObject(operation.objectId);
    const serverPath = serverObject !== undefined && !serverObject.deleted ? serverObject.path : operation.kind === "create" ? operation.path : null;
    const serverRead = serverPath === null ? undefined : await this.#tryRead(principal.workspaceId, this.#fullPath(principal, serverPath));
    const localContent = operation.kind === "delete" ? null : this.#content(operation);
    const localPath = operation.kind === "delete" ? null : operation.path;
    const local = operation.kind === "delete"
      ? { state: "deleted" as const, baseChecksum: operation.baseChecksum }
      : { state: "present" as const, checksum: operation.checksum, size: operation.size, contentType: operation.contentType };
    const server = serverRead === undefined
      ? { state: "deleted" as const, baseChecksum: "baseChecksum" in operation ? operation.baseChecksum : operation.checksum }
      : { state: "present" as const, checksum: serverRead.entry.checksum, size: serverRead.entry.size, contentType: serverRead.contentType };
    const movedOnServer = serverPath !== null && serverPath !== (operation.kind === "move" ? operation.previousPath : operation.path);
    const conflict: SyncConflict = {
      conflictId,
      objectId: operation.objectId,
      kind: operation.kind === "delete" || serverRead === undefined ? "delete-update" : movedOnServer ? "move-move" : "concurrent-update",
      path: localPath ?? serverPath ?? operation.path,
      localPath,
      serverPath: serverRead === undefined ? null : serverPath,
      local,
      server,
      baseChecksum: "baseChecksum" in operation ? operation.baseChecksum : null,
      status: "open",
    };
    this.#control.run(
      `INSERT INTO sync_conflicts (conflict_id, workspace_id, project_id, device_id, payload_json, local_content, status, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      [conflictId, principal.workspaceId, principal.projectId, principal.deviceId, JSON.stringify(conflict), localContent, this.#clock()],
    );
    const receipt: OperationReceipt = { operationId: operation.operationId, cursor: this.#journal(principal.workspaceId, principal.projectId).currentCursor(), objectId: operation.objectId, checksum: null, status: "conflict", conflictId };
    this.#storeReceipt(operation.operationId, requestDigest, receipt);
    this.#audit("sync.conflict.create", "conflict", principal.workspaceId, principal.deviceId);
    return receipt;
  }

  async #inventory(principal: ObsidianDevicePrincipal, signal?: AbortSignal) {
    const prefix = this.#prefix(principal);
    const entries = await this.#files.list(principal.workspaceId, prefix, true, signal);
    return syncPortableInventorySchema.parse(entries
      .filter((entry): entry is typeof entry & { checksum: string } => entry.kind === "file" && entry.checksum !== undefined)
      .flatMap(entry => {
        const path = this.#relativePath(prefix, entry.path);
        if (path === undefined || excludedSyncPath(path)) return [];
        return [{ path: syncPortablePathSchema.parse(path), checksum: entry.checksum, size: entry.size }];
      })
      .sort((left, right) => portablePathKey(left.path).localeCompare(portablePathKey(right.path))));
  }

  #authenticate(request: Request, workspaceId: string, projectId: string, capability: "read" | "write") {
    return this.#devices.authenticate(bearer(request), { workspaceId, projectId, capability });
  }

  #prefix(principal: Pick<ObsidianDevicePrincipal, "projectPrefix" | "projectId">): string {
    return syncPortablePathSchema.parse(principal.projectPrefix ?? principal.projectId);
  }

  #fullPath(principal: Pick<ObsidianDevicePrincipal, "projectPrefix" | "projectId">, relativePath: string): string {
    return posix.join(this.#prefix(principal), syncPortablePathSchema.parse(relativePath));
  }

  #relativePath(prefix: string, path: string): string | undefined {
    if (path === prefix) return undefined;
    const marker = `${prefix}/`;
    return path.startsWith(marker) ? path.slice(marker.length) : undefined;
  }

  #journal(workspaceId: string, projectId: string): SqliteSyncJournal {
    const key = `${workspaceId}\0${projectId}`;
    let journal = this.#journals.get(key);
    if (journal === undefined) {
      journal = new SqliteSyncJournal(join(this.#stateRoot, "journals", `${safeSegment(key)}.sqlite`), { clock: this.#clock });
      this.#journals.set(key, journal);
    }
    return journal;
  }

  #requiredPreview(previewId: string, principal: ObsidianDevicePrincipal, workspaceId: string, projectId: string): StoredPreview {
    const row = this.#control.query<StoredPreview, [string]>(
      "SELECT preview_id, device_id, workspace_id, project_id, server_revision, cursor, expires_at_ms, plan_json FROM sync_previews WHERE preview_id = ?",
    ).get(previewId);
    if (row === null || row.expires_at_ms <= this.#clock()) throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization preview is missing or expired.");
    if (row.device_id !== principal.deviceId || row.workspace_id !== workspaceId || row.project_id !== projectId) {
      throw new AbcmError("ACCESS_DENIED", "Synchronization preview belongs to a different device scope.");
    }
    return row;
  }

  #assertPreviewOperation(preview: StoredPreview, operation: SyncApplyOperation): string {
    let plan: { inventory: { path: string; checksum: string }[]; items: { path: string; action: string; objectId: string | null }[] };
    try {
      plan = JSON.parse(preview.plan_json) as typeof plan;
    } catch {
      throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Synchronization preview plan is invalid.");
    }
    const item = plan.items.find(candidate => portablePathKey(candidate.path) === portablePathKey(operation.path))
      ?? plan.items.find(candidate => candidate.action === "conflict" && candidate.objectId === operation.objectId);
    const local = plan.inventory.find(candidate => portablePathKey(candidate.path) === portablePathKey(operation.path));
    if (item?.objectId !== operation.objectId) throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization object id does not match the pinned preview plan.", { operationId: operation.operationId });
    const allowed = operation.kind === "create"
      ? item?.action === "create-server" && local?.checksum === operation.checksum
      : operation.kind === "update"
        ? (item?.action === "update-server" || item?.action === "conflict") && local?.checksum === operation.checksum
        : operation.kind === "delete"
          ? item?.action === "delete-server" || item?.action === "conflict"
          : item?.action === "move-server" || item?.action === "conflict";
    if (!allowed) throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization operation is not authorized by the pinned preview plan.", { operationId: operation.operationId, path: operation.path });
    return item!.action;
  }

  #receipt(operationId: string): StoredReceipt | undefined {
    return this.#control.query<StoredReceipt, [string]>("SELECT request_digest, receipt_json FROM sync_apply_receipts WHERE operation_id = ?").get(operationId) ?? undefined;
  }

  #storeReceipt(operationId: string, requestDigest: string, receipt: OperationReceipt): void {
    this.#control.run("INSERT INTO sync_apply_receipts (operation_id, request_digest, receipt_json, created_at_ms) VALUES (?, ?, ?, ?)", [operationId, requestDigest, JSON.stringify(receipt), this.#clock()]);
  }

  async #tryRead(workspaceId: string, path: string) {
    try { return await this.#files.read(workspaceId, path); }
    catch (error) { if (error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT") return undefined; if (error instanceof AbcmError && error.code === "FILE_NOT_FOUND") return undefined; throw error; }
  }

  async #capturePath(workspaceId: string, prefix: string, relativePath: string, journal: SqliteSyncJournal): Promise<void> {
    if (!syncPortablePathSchema.safeParse(relativePath).success) return;
    const existing = journal.getObjectByPath(relativePath);
    const current = await this.#tryRead(workspaceId, posix.join(prefix, relativePath));
    if (current === undefined) {
      if (existing !== undefined && !existing.deleted) journal.record({ kind: "delete", operationId: `op_external_${randomUUID().replaceAll("-", "")}`, originDeviceId: null, objectId: existing.objectId, path: existing.path, baseChecksum: existing.checksum });
      return;
    }
    if (existing === undefined || existing.deleted) {
      journal.record({ kind: "create", operationId: `op_external_${randomUUID().replaceAll("-", "")}`, originDeviceId: null, objectId: `obj_${randomUUID().replaceAll("-", "")}`, path: relativePath, checksum: current.entry.checksum, size: current.entry.size, contentType: current.contentType });
    } else if (existing.checksum !== current.entry.checksum) {
      journal.record({ kind: "update", operationId: `op_external_${randomUUID().replaceAll("-", "")}`, originDeviceId: null, objectId: existing.objectId, path: relativePath, baseChecksum: existing.checksum, checksum: current.entry.checksum, size: current.entry.size, contentType: current.contentType });
    }
  }

  #assertResolutionChecksums(conflict: SyncConflict, resolution: SyncConflictResolution): void {
    const local = conflict.local.state === "present" ? conflict.local.checksum : null;
    const server = conflict.server.state === "present" ? conflict.server.checksum : null;
    if (resolution.localChecksum !== local || resolution.serverChecksum !== server) {
      throw new AbcmError("SYNC_OBJECT_CONFLICT", "Conflict resolution checksums are stale.");
    }
  }

  #audit(operation: Parameters<typeof emitAudit>[1]["operation"], outcome: Parameters<typeof emitAudit>[1]["outcome"], workspaceId?: string, principalId?: string): void {
    emitAudit(this.#observability, { schemaVersion: 1, occurredAt: new Date(this.#clock()).toISOString(), operation, outcome, durationMs: 0,
      ...(workspaceId === undefined ? {} : { workspaceId }), ...(principalId === undefined ? {} : { principalId }) });
  }

  #migrate(): void {
    this.#control.transaction(() => {
      this.#control.run("CREATE TABLE IF NOT EXISTS sync_control_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.#control.run("INSERT OR IGNORE INTO sync_control_metadata (key, value) VALUES ('schema_version', '1')");
      const version = this.#control.query<{ value: string }, []>("SELECT value FROM sync_control_metadata WHERE key = 'schema_version'").get();
      if (version?.value !== "1") throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Unsupported Obsidian sync control schema version.");
      this.#control.run(`CREATE TABLE IF NOT EXISTS sync_previews (
        preview_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL,
        server_revision TEXT NOT NULL, cursor TEXT NOT NULL, local_inventory_digest TEXT NOT NULL, plan_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL
      )`);
      this.#control.run(`CREATE TABLE IF NOT EXISTS sync_apply_receipts (
        operation_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL
      )`);
      this.#control.run(`CREATE TABLE IF NOT EXISTS sync_conflicts (
        conflict_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, device_id TEXT NOT NULL,
        payload_json TEXT NOT NULL, local_content BLOB, status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        created_at_ms INTEGER NOT NULL, resolved_at_ms INTEGER, resolution_json TEXT
      )`);
    }).immediate();
  }
}
