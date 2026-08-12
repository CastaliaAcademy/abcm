import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { AbcmError } from "../core/errors.js";
import type { MapRevision } from "../scope-map/types.js";
import type { ScanLeaseHandle, ScopeMapStore, SqliteScopeMapStoreOptions } from "./types.js";

const SCHEMA_VERSION = 1;

interface LeaseRow {
  owner_id: string;
  expires_at: number;
  fencing_token: number;
}

interface ActiveRevisionRow {
  payload_json: string;
}

export class SqliteScopeMapStore implements ScopeMapStore {
  readonly #database: Database;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  readonly #clock: () => number;

  constructor(databasePath: string, options: SqliteScopeMapStoreOptions = {}) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath, { create: true, readwrite: true });
    this.#ownerId = options.ownerId ?? randomUUID();
    this.#leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.#clock = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs <= 0) {
      this.#database.close();
      throw new Error("leaseTtlMs must be a positive safe integer.");
    }
    try {
      this.#database.run("PRAGMA foreign_keys = ON");
      this.#database.run("PRAGMA busy_timeout = 5000");
      this.#database.run("PRAGMA journal_mode = DELETE");
      if (this.journalMode().toLowerCase() === "wal") {
        throw new AbcmError("DERIVED_STORE_CORRUPT", "WAL journal mode is forbidden for the derived store profile.");
      }
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  schemaVersion(): number {
    const row = this.#database
      .query<{ value: string }, [string]>("SELECT value FROM schema_metadata WHERE key = ?")
      .get("schema_version");
    if (row === null) throw new AbcmError("DERIVED_STORE_CORRUPT", "SQLite schema version is missing.");
    return Number(row.value);
  }

  journalMode(): string {
    const row = this.#database.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    if (row === null) throw new AbcmError("DERIVED_STORE_CORRUPT", "SQLite journal mode is unavailable.");
    return row.journal_mode;
  }

  beginScan(workspaceId: string): ScanLeaseHandle {
    const now = this.#clock();
    const scanId = randomUUID();
    return this.#database.transaction(() => {
      const existing = this.#database
        .query<LeaseRow, [string]>(
          "SELECT owner_id, expires_at, fencing_token FROM scan_leases WHERE workspace_id = ?",
        )
        .get(workspaceId);
      if (existing !== null && existing.expires_at > now) {
        throw new AbcmError("SCAN_LEASE_BUSY", `Workspace '${workspaceId}' already has an active scan lease.`, {
          workspaceId,
          expiresAt: new Date(existing.expires_at).toISOString(),
        });
      }
      const fencingToken = (existing?.fencing_token ?? 0) + 1;
      const expiresAt = now + this.#leaseTtlMs;
      const active = this.#database
        .query<{ revision: string }, [string]>("SELECT revision FROM active_map_revisions WHERE workspace_id = ?")
        .get(workspaceId);
      this.#database.run(
        `INSERT INTO scan_leases (workspace_id, owner_id, expires_at, fencing_token)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           expires_at = excluded.expires_at,
           fencing_token = excluded.fencing_token`,
        [workspaceId, this.#ownerId, expiresAt, fencingToken],
      );
      this.#database.run(
        `INSERT INTO scan_sessions
          (scan_id, workspace_id, owner_id, fencing_token, started_at, previous_map_revision, status)
         VALUES (?, ?, ?, ?, ?, ?, 'running')`,
        [scanId, workspaceId, this.#ownerId, fencingToken, now, active?.revision ?? null],
      );
      return {
        workspaceId,
        scanId,
        ownerId: this.#ownerId,
        fencingToken,
        expiresAt,
        ...(active === null ? {} : { previousMapRevision: active.revision }),
      };
    }).immediate();
  }

  publish(lease: ScanLeaseHandle, revision: MapRevision): void {
    const now = this.#clock();
    this.#database.transaction(() => {
      this.#assertCurrentLease(lease, now);
      this.#database.run(
        `INSERT OR IGNORE INTO map_revisions
          (workspace_id, revision, digest, created_at, scan_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [lease.workspaceId, revision.revision, revision.digest, revision.createdAt, lease.scanId, JSON.stringify(revision)],
      );
      this.#database.run(
        `INSERT INTO active_map_revisions (workspace_id, revision)
         VALUES (?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET revision = excluded.revision`,
        [lease.workspaceId, revision.revision],
      );
      this.#database.run("UPDATE scan_sessions SET status = 'published', finished_at = ? WHERE scan_id = ?", [now, lease.scanId]);
      this.#database.run(
        "UPDATE scan_leases SET expires_at = 0 WHERE workspace_id = ? AND owner_id = ? AND fencing_token = ?",
        [lease.workspaceId, lease.ownerId, lease.fencingToken],
      );
    }).immediate();
  }

  fail(lease: ScanLeaseHandle): void {
    const now = this.#clock();
    this.#database.transaction(() => {
      this.#database.run("UPDATE scan_sessions SET status = 'failed', finished_at = ? WHERE scan_id = ? AND status = 'running'", [now, lease.scanId]);
      this.#database.run(
        "UPDATE scan_leases SET expires_at = 0 WHERE workspace_id = ? AND owner_id = ? AND fencing_token = ?",
        [lease.workspaceId, lease.ownerId, lease.fencingToken],
      );
    }).immediate();
  }

  getActive(workspaceId: string): MapRevision | undefined {
    const row = this.#database
      .query<ActiveRevisionRow, [string]>(
        `SELECT revisions.payload_json
           FROM active_map_revisions AS active
           JOIN map_revisions AS revisions
             ON revisions.workspace_id = active.workspace_id AND revisions.revision = active.revision
          WHERE active.workspace_id = ?`,
      )
      .get(workspaceId);
    if (row === null) return undefined;
    try {
      return JSON.parse(row.payload_json) as MapRevision;
    } catch (error) {
      throw new AbcmError("DERIVED_STORE_CORRUPT", "Active MapRevision payload is invalid JSON.", {
        workspaceId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  close(): void {
    this.#database.close();
  }

  #assertCurrentLease(lease: ScanLeaseHandle, now: number): void {
    const current = this.#database
      .query<LeaseRow, [string]>(
        "SELECT owner_id, expires_at, fencing_token FROM scan_leases WHERE workspace_id = ?",
      )
      .get(lease.workspaceId);
    if (
      current === null ||
      current.owner_id !== lease.ownerId ||
      current.fencing_token !== lease.fencingToken ||
      current.expires_at <= now
    ) {
      throw new AbcmError("SCAN_FENCING_STALE", "Scan publication was rejected because its fencing token is stale.", {
        workspaceId: lease.workspaceId,
        fencingToken: lease.fencingToken,
      });
    }
  }

  #migrate(): void {
    this.#database.transaction(() => {
      this.#database.run("CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const current = this.#database
        .query<{ value: string }, [string]>("SELECT value FROM schema_metadata WHERE key = ?")
        .get("schema_version");
      if (current !== null && Number(current.value) !== SCHEMA_VERSION) {
        throw new AbcmError("DERIVED_STORE_CORRUPT", `Unsupported SQLite schema version '${current.value}'.`);
      }
      this.#database.run(`CREATE TABLE IF NOT EXISTS scan_leases (
        workspace_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        fencing_token INTEGER NOT NULL CHECK(fencing_token > 0)
      )`);
      this.#database.run(`CREATE TABLE IF NOT EXISTS scan_sessions (
        scan_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        previous_map_revision TEXT,
        status TEXT NOT NULL CHECK(status IN ('running', 'published', 'failed'))
      )`);
      this.#database.run(`CREATE TABLE IF NOT EXISTS map_revisions (
        workspace_id TEXT NOT NULL,
        revision TEXT NOT NULL,
        digest TEXT NOT NULL,
        created_at TEXT NOT NULL,
        scan_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (workspace_id, revision),
        FOREIGN KEY (scan_id) REFERENCES scan_sessions(scan_id)
      )`);
      this.#database.run(`CREATE TABLE IF NOT EXISTS active_map_revisions (
        workspace_id TEXT PRIMARY KEY,
        revision TEXT NOT NULL,
        FOREIGN KEY (workspace_id, revision) REFERENCES map_revisions(workspace_id, revision)
      )`);
      if (current === null) {
        this.#database.run("INSERT INTO schema_metadata (key, value) VALUES ('schema_version', ?)", [String(SCHEMA_VERSION)]);
      }
    }).immediate();
  }
}
