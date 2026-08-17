import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";
import { z } from "zod/v4";

import { AbcmError } from "../core/errors.js";
import {
  portablePathKey,
  syncChangeEventSchema,
  syncChecksumSchema,
  syncDeviceIdSchema,
  syncObjectIdSchema,
  syncOperationIdSchema,
  syncPortablePathSchema,
  type SyncChangeEvent,
} from "./contracts.js";

const SCHEMA_VERSION = 1;
const CURSOR_PATTERN = /^cur_1_([0-9a-z]+)_([0-9a-f]{24})$/;

const mutationBase = z.object({
  operationId: syncOperationIdSchema,
  originDeviceId: syncDeviceIdSchema.nullable(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});
const mutationContent = {
  checksum: syncChecksumSchema,
  size: z.number().int().min(0),
  contentType: z.string().min(1).max(255),
} as const;
export const syncJournalMutationSchema = z.discriminatedUnion("kind", [
  mutationBase.extend({ kind: z.literal("create"), objectId: syncObjectIdSchema.optional(), path: syncPortablePathSchema, ...mutationContent }).strict(),
  mutationBase.extend({ kind: z.literal("update"), objectId: syncObjectIdSchema, path: syncPortablePathSchema, baseChecksum: syncChecksumSchema, ...mutationContent }).strict(),
  mutationBase.extend({ kind: z.literal("move"), objectId: syncObjectIdSchema, previousPath: syncPortablePathSchema, path: syncPortablePathSchema, baseChecksum: syncChecksumSchema, ...mutationContent }).strict(),
  mutationBase.extend({ kind: z.literal("delete"), objectId: syncObjectIdSchema, path: syncPortablePathSchema, baseChecksum: syncChecksumSchema }).strict(),
]);

export type SyncJournalMutation = z.infer<typeof syncJournalMutationSchema>;

export interface SyncJournalRecordResult {
  status: "applied" | "duplicate";
  event: SyncChangeEvent;
}

export interface SyncJournalChanges {
  changes: SyncChangeEvent[];
  nextCursor: string;
  hasMore: boolean;
}

export interface SyncJournalObject {
  objectId: string;
  path: string;
  checksum: string;
  deleted: boolean;
  version: number;
}

export interface SyncJournalTombstone {
  objectId: string;
  path: string;
  checksum: string;
  cursor: string;
  deletedAt: string;
}

export interface SqliteSyncJournalOptions {
  clock?: () => number;
}

interface ObjectRow {
  object_id: string;
  path: string;
  checksum: string;
  deleted: number;
  version: number;
}

interface EventRow { sequence: number; payload_json: string }
interface ReceiptRow { request_digest: string; payload_json: string }
interface TombstoneRow { object_id: string; path: string; checksum: string; event_sequence: number; deleted_at: string }

function mutationDigest(input: SyncJournalMutation): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

function parseMutation(input: unknown): SyncJournalMutation {
  const result = syncJournalMutationSchema.safeParse(input);
  if (!result.success) {
    throw new AbcmError("REQUEST_INVALID", "Synchronization journal mutation is invalid.", {
      cause: result.error.issues.map(issue => issue.message).join("; "),
    });
  }
  return result.data;
}

export class SqliteSyncJournal {
  readonly #database: Database;
  readonly #clock: () => number;
  #cursorSecret = "";

  constructor(databasePath: string, options: SqliteSyncJournalOptions = {}) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath, { create: true, readwrite: true });
    this.#clock = options.clock ?? Date.now;
    try {
      this.#database.run("PRAGMA foreign_keys = ON");
      this.#database.run("PRAGMA busy_timeout = 5000");
      this.#database.run("PRAGMA journal_mode = DELETE");
      this.#migrate();
      this.#cursorSecret = this.#metadata("cursor_secret");
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  currentCursor(): string {
    const row = this.#database.query<{ sequence: number }, []>("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'sync_events'), 0) AS sequence").get();
    if (row === null) throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Synchronization journal sequence is unavailable.");
    return this.#cursor(row.sequence);
  }

  cursorBefore(cursor: string): string {
    const sequence = this.#parseCursor(cursor);
    return this.#cursor(Math.max(0, sequence - 1));
  }

  ensureObjectSnapshot(raw: { objectId: string; path: string; checksum: string }): SyncJournalObject {
    const objectId = syncObjectIdSchema.parse(raw.objectId);
    const path = syncPortablePathSchema.parse(raw.path);
    const checksum = syncChecksumSchema.parse(raw.checksum);
    return this.#database.transaction(() => {
      const byId = this.getObject(objectId);
      const byPath = this.getObjectByPath(path);
      if (byId === undefined && byPath === undefined) {
        this.#database.run(
          "INSERT INTO sync_objects (object_id, path, path_key, checksum, deleted, version) VALUES (?, ?, ?, ?, 0, 1)",
          [objectId, path, portablePathKey(path), checksum],
        );
        return { objectId, path, checksum, deleted: false, version: 1 };
      }
      const existing = byId ?? byPath!;
      if (existing.objectId !== objectId || existing.path !== path || existing.checksum !== checksum || existing.deleted) {
        throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization snapshot differs from the durable object identity.", { objectId, path });
      }
      return existing;
    }).immediate();
  }

  record(rawInput: SyncJournalMutation): SyncJournalRecordResult {
    const input = parseMutation(rawInput);
    const requestDigest = mutationDigest(input);
    return this.#database.transaction(() => {
      const existing = this.#database
        .query<ReceiptRow, [string]>("SELECT request_digest, payload_json FROM sync_receipts WHERE operation_id = ?")
        .get(input.operationId);
      if (existing !== null) {
        if (existing.request_digest !== requestDigest) {
          throw new AbcmError("SYNC_IDEMPOTENCY_CONFLICT", "Synchronization operation id was reused with a different request.", {
            operationId: input.operationId,
          });
        }
        const applied = this.#parseReceipt(existing.payload_json);
        return { ...applied, status: "duplicate" as const };
      }

      const objectId = input.kind === "create" ? input.objectId ?? `obj_${randomUUID().replaceAll("-", "")}` : input.objectId;
      const current = input.kind === "create" ? undefined : this.#requiredObject(objectId);
      if (input.kind === "create") {
        this.#assertPathAvailable(input.path);
      } else {
        if (current === undefined) throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Synchronization object lookup did not return a record.");
        if (current.deleted) throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization object is deleted.", { objectId });
        if (current.path !== (input.kind === "move" ? input.previousPath : input.path) || current.checksum !== input.baseChecksum) {
          throw new AbcmError("SYNC_OBJECT_CONFLICT", "Synchronization object path or checksum differs from the requested base.", {
            objectId,
            currentPath: current.path,
            currentChecksum: current.checksum,
          });
        }
        if (input.kind === "move") this.#assertPathAvailable(input.path, objectId);
      }

      const insert = this.#database.run(
        "INSERT INTO sync_events (operation_id, object_id, payload_json) VALUES (?, ?, '')",
        [input.operationId, objectId],
      );
      const sequence = Number(insert.lastInsertRowid);
      if (!Number.isSafeInteger(sequence) || sequence <= 0) {
        throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Synchronization journal did not allocate a valid sequence.");
      }
      const cursor = this.#cursor(sequence);
      const occurredAt = input.occurredAt ?? new Date(this.#clock()).toISOString();
      const common = { cursor, objectId, operationId: input.operationId, originDeviceId: input.originDeviceId, path: input.path, occurredAt };
      const event = syncChangeEventSchema.parse(
        input.kind === "create"
          ? { ...common, kind: "create", checksum: input.checksum, size: input.size, contentType: input.contentType, tombstone: false }
          : input.kind === "update"
            ? { ...common, kind: "update", baseChecksum: input.baseChecksum, checksum: input.checksum, size: input.size, contentType: input.contentType, tombstone: false }
            : input.kind === "move"
              ? { ...common, kind: "move", previousPath: input.previousPath, baseChecksum: input.baseChecksum, checksum: input.checksum, size: input.size, contentType: input.contentType, tombstone: false }
              : { ...common, kind: "delete", baseChecksum: input.baseChecksum, tombstone: true },
      );
      const eventJson = JSON.stringify(event);
      this.#database.run("UPDATE sync_events SET payload_json = ? WHERE sequence = ?", [eventJson, sequence]);

      if (input.kind === "create") {
        this.#database.run(
          "INSERT INTO sync_objects (object_id, path, path_key, checksum, deleted, version) VALUES (?, ?, ?, ?, 0, 1)",
          [objectId, input.path, portablePathKey(input.path), input.checksum],
        );
      } else if (input.kind === "delete") {
        this.#database.run("UPDATE sync_objects SET deleted = 1, version = version + 1 WHERE object_id = ?", [objectId]);
        this.#database.run(
          "INSERT OR REPLACE INTO sync_tombstones (object_id, path, checksum, event_sequence, deleted_at) VALUES (?, ?, ?, ?, ?)",
          [objectId, input.path, input.baseChecksum, sequence, occurredAt],
        );
      } else {
        this.#database.run(
          "UPDATE sync_objects SET path = ?, path_key = ?, checksum = ?, version = version + 1 WHERE object_id = ?",
          [input.path, portablePathKey(input.path), input.checksum, objectId],
        );
      }

      const result: SyncJournalRecordResult = { status: "applied", event };
      this.#database.run(
        "INSERT INTO sync_receipts (operation_id, request_digest, event_sequence, payload_json) VALUES (?, ?, ?, ?)",
        [input.operationId, requestDigest, sequence, JSON.stringify(result)],
      );
      return result;
    }).immediate();
  }

  changesAfter(cursor: string, limit: number): SyncJournalChanges {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new AbcmError("REQUEST_INVALID", "Synchronization change limit must be between 1 and 1000.");
    }
    const sequence = this.#parseCursor(cursor);
    const retainedThrough = Number(this.#metadata("retained_through_sequence"));
    if (!Number.isSafeInteger(retainedThrough) || retainedThrough < 0) {
      throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Synchronization retention metadata is invalid.");
    }
    if (sequence < retainedThrough) {
      throw new AbcmError("SYNC_CURSOR_EXPIRED", "Synchronization cursor references compacted history.", {
        retainedThroughCursor: this.#cursor(retainedThrough),
      });
    }
    const currentSequence = this.#parseCursor(this.currentCursor());
    if (sequence > currentSequence) throw new AbcmError("SYNC_CURSOR_INVALID", "Synchronization cursor is ahead of the journal.");
    const rows = this.#database
      .query<EventRow, [number, number]>("SELECT sequence, payload_json FROM sync_events WHERE sequence > ? ORDER BY sequence LIMIT ?")
      .all(sequence, limit + 1);
    const hasMore = rows.length > limit;
    const selected = hasMore ? rows.slice(0, limit) : rows;
    const changes = selected.map(row => this.#parseEvent(row.payload_json));
    return {
      changes,
      nextCursor: changes.at(-1)?.cursor ?? cursor,
      hasMore,
    };
  }

  compactThrough(cursor: string): void {
    const sequence = this.#parseCursor(cursor);
    const currentSequence = this.#parseCursor(this.currentCursor());
    if (sequence > currentSequence) throw new AbcmError("SYNC_CURSOR_INVALID", "Compaction cursor is ahead of the journal.");
    this.#database.transaction(() => {
      const retainedThrough = Number(this.#metadata("retained_through_sequence"));
      if (sequence <= retainedThrough) return;
      this.#database.run("DELETE FROM sync_events WHERE sequence <= ?", [sequence]);
      this.#database.run("UPDATE sync_metadata SET value = ? WHERE key = 'retained_through_sequence'", [String(sequence)]);
    }).immediate();
  }

  getObject(objectId: string): SyncJournalObject | undefined {
    const row = this.#database
      .query<ObjectRow, [string]>("SELECT object_id, path, checksum, deleted, version FROM sync_objects WHERE object_id = ?")
      .get(objectId);
    return row === null ? undefined : this.#object(row);
  }

  getObjectByPath(path: string): SyncJournalObject | undefined {
    const row = this.#database
      .query<ObjectRow, [string]>("SELECT object_id, path, checksum, deleted, version FROM sync_objects WHERE path_key = ? AND deleted = 0")
      .get(portablePathKey(path));
    return row === null ? undefined : this.#object(row);
  }

  listTombstones(): SyncJournalTombstone[] {
    return this.#database
      .query<TombstoneRow, []>("SELECT object_id, path, checksum, event_sequence, deleted_at FROM sync_tombstones ORDER BY event_sequence")
      .all()
      .map(row => ({ objectId: row.object_id, path: row.path, checksum: row.checksum, cursor: this.#cursor(row.event_sequence), deletedAt: row.deleted_at }));
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.transaction(() => {
      this.#database.run("CREATE TABLE IF NOT EXISTS sync_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.#database.run(`CREATE TABLE IF NOT EXISTS sync_objects (
        object_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        path_key TEXT NOT NULL,
        checksum TEXT NOT NULL,
        deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
        version INTEGER NOT NULL CHECK (version > 0)
      )`);
      this.#database.run("CREATE UNIQUE INDEX IF NOT EXISTS sync_objects_active_path ON sync_objects(path_key) WHERE deleted = 0");
      this.#database.run(`CREATE TABLE IF NOT EXISTS sync_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        object_id TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )`);
      this.#database.run(`CREATE TABLE IF NOT EXISTS sync_receipts (
        operation_id TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )`);
      this.#database.run(`CREATE TABLE IF NOT EXISTS sync_tombstones (
        object_id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        checksum TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        deleted_at TEXT NOT NULL
      )`);
      this.#database.run("INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
      this.#database.run("INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('cursor_secret', ?)", [randomBytes(32).toString("hex")]);
      this.#database.run("INSERT OR IGNORE INTO sync_metadata (key, value) VALUES ('retained_through_sequence', '0')");
      if (this.#metadata("schema_version") !== String(SCHEMA_VERSION)) {
        throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Unsupported synchronization journal schema version.");
      }
    }).immediate();
  }

  #metadata(key: string): string {
    const row = this.#database.query<{ value: string }, [string]>("SELECT value FROM sync_metadata WHERE key = ?").get(key);
    if (row === null) throw new AbcmError("SYNC_JOURNAL_CORRUPT", `Synchronization journal metadata '${key}' is missing.`);
    return row.value;
  }

  #cursor(sequence: number): string {
    const payload = `1:${sequence.toString(36)}`;
    const signature = createHmac("sha256", this.#cursorSecret).update(payload).digest("hex").slice(0, 24);
    return `cur_1_${sequence.toString(36)}_${signature}`;
  }

  #parseCursor(cursor: string): number {
    const match = CURSOR_PATTERN.exec(cursor);
    if (match === null) throw new AbcmError("SYNC_CURSOR_INVALID", "Synchronization cursor is malformed.");
    const sequence = Number.parseInt(match[1] ?? "", 36);
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new AbcmError("SYNC_CURSOR_INVALID", "Synchronization cursor sequence is invalid.");
    const expected = this.#cursor(sequence);
    const suppliedBytes = Buffer.from(cursor);
    const expectedBytes = Buffer.from(expected);
    if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      throw new AbcmError("SYNC_CURSOR_INVALID", "Synchronization cursor authentication failed.");
    }
    return sequence;
  }

  #requiredObject(objectId: string): SyncJournalObject {
    const object = this.getObject(objectId);
    if (object === undefined) throw new AbcmError("SYNC_OBJECT_NOT_FOUND", "Synchronization object was not found.", { objectId });
    return object;
  }

  #assertPathAvailable(path: string, exceptObjectId?: string): void {
    const row = this.#database
      .query<{ object_id: string }, [string]>("SELECT object_id FROM sync_objects WHERE path_key = ? AND deleted = 0")
      .get(portablePathKey(path));
    if (row !== null && row.object_id !== exceptObjectId) {
      throw new AbcmError("SYNC_OBJECT_CONFLICT", "Portable synchronization path is already occupied.", { path, objectId: row.object_id });
    }
  }

  #object(row: ObjectRow): SyncJournalObject {
    return { objectId: row.object_id, path: row.path, checksum: row.checksum, deleted: row.deleted === 1, version: row.version };
  }

  #parseEvent(payload: string): SyncChangeEvent {
    try {
      return syncChangeEventSchema.parse(JSON.parse(payload));
    } catch {
      throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Synchronization event payload is invalid.");
    }
  }

  #parseReceipt(payload: string): SyncJournalRecordResult {
    try {
      const parsed = JSON.parse(payload) as { status?: unknown; event?: unknown };
      if (parsed.status !== "applied") throw new Error("invalid status");
      return { status: "applied", event: syncChangeEventSchema.parse(parsed.event) };
    } catch {
      throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Synchronization receipt payload is invalid.");
    }
  }
}
