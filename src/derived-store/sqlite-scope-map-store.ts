import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { AbcmError } from "../core/errors.js";
import type {
  DocumentationStateCommit,
  DocumentProvenanceRecord,
  DocumentStorageResolution,
  SyncRunRecord,
  TombstoneRecord,
} from "../documentation/types.js";
import type { MapRevision } from "../scope-map/types.js";
import type { RuntimeOwnerHandle, ScanLeaseHandle, ScopeMapStore, SqliteScopeMapStoreOptions } from "./types.js";

const SCHEMA_VERSION = 5;

interface LeaseRow {
  owner_id: string;
  expires_at: number;
  fencing_token: number;
}

interface ActiveRevisionRow {
  payload_json: string;
}

interface RuntimeOwnerRow {
  owner_id: string;
  expires_at: number;
  fencing_token: number;
}

export class SqliteScopeMapStore implements ScopeMapStore {
  readonly scanLeaseRenewalIntervalMs: number;
  readonly #database: Database;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  readonly #runtimeOwnerTtlMs: number | undefined;
  readonly #clock: () => number;
  #runtimeOwner: RuntimeOwnerHandle | undefined;

  constructor(databasePath: string, options: SqliteScopeMapStoreOptions = {}) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath, { create: true, readwrite: true });
    this.#ownerId = options.ownerId ?? randomUUID();
    this.#leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.scanLeaseRenewalIntervalMs = options.scanLeaseRenewalIntervalMs ?? Math.floor(this.#leaseTtlMs / 3);
    this.#runtimeOwnerTtlMs = options.runtimeOwnerTtlMs;
    this.#clock = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.#leaseTtlMs) || this.#leaseTtlMs <= 0) {
      this.#database.close();
      throw new Error("leaseTtlMs must be a positive safe integer.");
    }
    if (
      !Number.isSafeInteger(this.scanLeaseRenewalIntervalMs) ||
      this.scanLeaseRenewalIntervalMs <= 0 ||
      this.scanLeaseRenewalIntervalMs >= this.#leaseTtlMs
    ) {
      this.#database.close();
      throw new Error("scanLeaseRenewalIntervalMs must be a positive integer smaller than leaseTtlMs.");
    }
    if (
      this.#runtimeOwnerTtlMs !== undefined &&
      (!Number.isSafeInteger(this.#runtimeOwnerTtlMs) || this.#runtimeOwnerTtlMs <= 0)
    ) {
      this.#database.close();
      throw new Error("runtimeOwnerTtlMs must be a positive safe integer.");
    }
    try {
      this.#database.run("PRAGMA foreign_keys = ON");
      this.#database.run("PRAGMA busy_timeout = 5000");
      this.#database.run("PRAGMA journal_mode = DELETE");
      if (this.journalMode().toLowerCase() === "wal") {
        throw new AbcmError("DERIVED_STORE_CORRUPT", "WAL journal mode is forbidden for the derived store profile.");
      }
      this.#migrate();
      if (this.#runtimeOwnerTtlMs !== undefined) this.#runtimeOwner = this.#acquireRuntimeOwner();
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
      this.#assertRuntimeOwner(now);
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
      this.#assertRuntimeOwner(now);
      this.#assertCurrentLease(lease, now);
      this.#database.run(
        `INSERT OR IGNORE INTO map_revisions
          (workspace_id, revision, digest, created_at, scan_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [lease.workspaceId, revision.revision, revision.digest, revision.createdAt, lease.scanId, JSON.stringify(revision)],
      );
      for (const file of revision.files) {
        this.#database.run(
          `INSERT OR IGNORE INTO map_files
            (workspace_id, revision, relative_path, scope_id, size, mtime, checksum, parse_status, classification, storage_mode, source_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            lease.workspaceId,
            revision.revision,
            file.relativePath,
            file.scopeId,
            file.size,
            file.mtime,
            file.checksum,
            file.parseStatus,
            file.classification,
            file.storageMode,
            file.sourceId ?? null,
          ],
        );
      }
      for (const document of revision.documents) {
        this.#database.run(
          `INSERT OR IGNORE INTO map_documents
            (workspace_id, revision, document_id, kind, title, scope_id, relative_path, checksum, lifecycle,
             required_selectors_json, role_selectors_json, task_selectors_json, links_json, context_policy, storage_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            lease.workspaceId,
            revision.revision,
            document.documentId,
            document.kind,
            document.title,
            document.scopeId,
            document.relativePath,
            document.checksum,
            document.lifecycle,
            JSON.stringify(document.requiredSelectors),
            JSON.stringify(document.roleSelectors),
            JSON.stringify(document.taskSelectors),
            JSON.stringify(document.links),
            document.contextPolicy,
            document.storageMode,
          ],
        );
      }
      for (const resource of revision.executableResources) {
        this.#database.run(
          `INSERT OR IGNORE INTO map_executable_resources
            (workspace_id, revision, resource_id, scope_id, relative_path, language, checksum, activation_status, permissions_profile)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            lease.workspaceId,
            revision.revision,
            resource.resourceId,
            resource.scopeId,
            resource.relativePath,
            resource.language,
            resource.checksum,
            resource.activationStatus,
            resource.permissionsProfile,
          ],
        );
      }
      this.#persistNormalizedGraph(lease.workspaceId, revision);
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

  renew(lease: ScanLeaseHandle): ScanLeaseHandle {
    const now = this.#clock();
    const expiresAt = now + this.#leaseTtlMs;
    return this.#database.transaction(() => {
      this.#assertRuntimeOwner(now);
      const result = this.#database.run(
        `UPDATE scan_leases SET expires_at = ?
          WHERE workspace_id = ? AND owner_id = ? AND fencing_token = ? AND expires_at > ?`,
        [expiresAt, lease.workspaceId, lease.ownerId, lease.fencingToken, now],
      );
      if (result.changes !== 1) {
        throw new AbcmError("SCAN_FENCING_STALE", "Scan lease renewal was rejected because its fencing token is stale.", {
          workspaceId: lease.workspaceId,
          fencingToken: lease.fencingToken,
        });
      }
      return { ...lease, expiresAt };
    }).immediate();
  }

  fail(lease: ScanLeaseHandle): void {
    const now = this.#clock();
    this.#database.transaction(() => {
      this.#assertRuntimeOwner(now);
      this.#database.run("UPDATE scan_sessions SET status = 'failed', finished_at = ? WHERE scan_id = ? AND status = 'running'", [now, lease.scanId]);
      this.#database.run(
        "UPDATE scan_leases SET expires_at = 0 WHERE workspace_id = ? AND owner_id = ? AND fencing_token = ?",
        [lease.workspaceId, lease.ownerId, lease.fencingToken],
      );
    }).immediate();
  }

  getActive(workspaceId: string): MapRevision | undefined {
    return this.#database.transaction(() => {
      this.#assertRuntimeOwner();
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
    }).deferred();
  }

  resolveDocumentStorage(workspaceId: string, targetPath: string): DocumentStorageResolution {
    this.#assertRuntimeOwner();
    const row = this.#database
      .query<{ source_id: string }, [string, string]>(
        "SELECT source_id FROM document_provenance WHERE workspace_id = ? AND target_path = ? AND active = 1",
      )
      .get(workspaceId, targetPath);
    return row === null ? { storageMode: "managed" } : { storageMode: "mirror", sourceId: row.source_id };
  }

  listDocumentProvenance(workspaceId: string, sourceId: string): DocumentProvenanceRecord[] {
    this.#assertRuntimeOwner();
    return this.#database
      .query<
        {
          workspace_id: string;
          source_id: string;
          source_path: string;
          target_path: string;
          source_checksum: string;
          target_checksum: string;
          last_synchronized_at: string;
          active: number;
        },
        [string, string]
      >(
        `SELECT workspace_id, source_id, source_path, target_path, source_checksum, target_checksum,
                last_synchronized_at, active
           FROM document_provenance WHERE workspace_id = ? AND source_id = ? ORDER BY source_path`,
      )
      .all(workspaceId, sourceId)
      .map(row => ({
        workspaceId: row.workspace_id,
        sourceId: row.source_id,
        sourcePath: row.source_path,
        targetPath: row.target_path,
        sourceChecksum: row.source_checksum,
        targetChecksum: row.target_checksum,
        lastSynchronizedAt: row.last_synchronized_at,
        active: row.active === 1,
      }));
  }

  listTombstones(workspaceId: string, sourceId: string): TombstoneRecord[] {
    this.#assertRuntimeOwner();
    return this.#database
      .query<
        {
          resource_id: string;
          workspace_id: string;
          source_id: string;
          former_path: string;
          checksum: string;
          deleted_at: string;
          reason: "canonical_source_deleted";
        },
        [string, string]
      >(
        `SELECT resource_id, workspace_id, source_id, former_path, checksum, deleted_at, reason
           FROM tombstones WHERE workspace_id = ? AND source_id = ? ORDER BY deleted_at, resource_id`,
      )
      .all(workspaceId, sourceId)
      .map(row => ({
        resourceId: row.resource_id,
        workspaceId: row.workspace_id,
        sourceId: row.source_id,
        formerPath: row.former_path,
        checksum: row.checksum,
        deletedAt: row.deleted_at,
        reason: row.reason,
      }));
  }

  listSyncRuns(workspaceId: string, sourceId: string): SyncRunRecord[] {
    this.#assertRuntimeOwner();
    return this.#database
      .query<
        {
          sync_run_id: string;
          workspace_id: string;
          source_id: string;
          started_at: string;
          finished_at: string;
          created: number;
          updated: number;
          moved: number;
          deleted: number;
          conflicts: number;
          status: "succeeded";
        },
        [string, string]
      >(
        `SELECT sync_run_id, workspace_id, source_id, started_at, finished_at, created, updated, moved, deleted,
                conflicts, status
           FROM sync_runs WHERE workspace_id = ? AND source_id = ? ORDER BY started_at, sync_run_id`,
      )
      .all(workspaceId, sourceId)
      .map(row => ({
        syncRunId: row.sync_run_id,
        workspaceId: row.workspace_id,
        sourceId: row.source_id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        created: row.created,
        updated: row.updated,
        moved: row.moved,
        deleted: row.deleted,
        conflicts: row.conflicts,
        status: row.status,
      }));
  }

  commitDocumentationSync(commit: DocumentationStateCommit): void {
    this.#database.transaction(() => {
      this.#assertRuntimeOwner();
      this.#database.run(
        `INSERT INTO documentation_sources (workspace_id, source_id, connector_kind, target_base_path, storage_mode, status)
         VALUES (?, ?, 'directory', ?, 'mirror', 'active')
         ON CONFLICT(workspace_id, source_id) DO UPDATE SET
           target_base_path = excluded.target_base_path, storage_mode = excluded.storage_mode, status = excluded.status`,
        [commit.source.workspaceId, commit.source.id, commit.source.targetBasePath],
      );
      for (const record of commit.upserts) {
        this.#database.run(
          `INSERT INTO document_provenance
            (workspace_id, source_id, source_path, target_path, source_checksum, target_checksum, last_synchronized_at, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(workspace_id, source_id, source_path) DO UPDATE SET
             target_path = excluded.target_path,
             source_checksum = excluded.source_checksum,
             target_checksum = excluded.target_checksum,
             last_synchronized_at = excluded.last_synchronized_at,
             active = 1`,
          [
            record.workspaceId,
            record.sourceId,
            record.sourcePath,
            record.targetPath,
            record.sourceChecksum,
            record.targetChecksum,
            record.lastSynchronizedAt,
          ],
        );
      }
      for (const tombstone of commit.deletions) {
        this.#database.run(
          `UPDATE document_provenance SET active = 0, last_synchronized_at = ?
            WHERE workspace_id = ? AND source_id = ? AND target_path = ?`,
          [tombstone.deletedAt, tombstone.workspaceId, tombstone.sourceId, tombstone.formerPath],
        );
        this.#database.run(
          `INSERT INTO tombstones (resource_id, workspace_id, source_id, former_path, checksum, deleted_at, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            tombstone.resourceId,
            tombstone.workspaceId,
            tombstone.sourceId,
            tombstone.formerPath,
            tombstone.checksum,
            tombstone.deletedAt,
            tombstone.reason,
          ],
        );
      }
      const run = commit.run;
      this.#database.run(
        `INSERT INTO sync_runs
          (sync_run_id, workspace_id, source_id, started_at, finished_at, created, updated, moved, deleted, conflicts, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          run.syncRunId,
          run.workspaceId,
          run.sourceId,
          run.startedAt,
          run.finishedAt,
          run.created,
          run.updated,
          run.moved,
          run.deleted,
          run.conflicts,
          run.status,
        ],
      );
    }).immediate();
  }

  close(): void {
    this.releaseRuntimeOwner();
    this.#database.close();
  }

  runtimeOwner(): RuntimeOwnerHandle | undefined {
    if (this.#runtimeOwner === undefined) return undefined;
    return { ...this.#runtimeOwner };
  }

  renewRuntimeOwner(): RuntimeOwnerHandle {
    const current = this.#runtimeOwner;
    const ttl = this.#runtimeOwnerTtlMs;
    if (current === undefined || ttl === undefined) {
      throw new AbcmError("DERIVED_STORE_OWNER_LOST", "This store does not hold a runtime owner lease.");
    }
    const now = this.#clock();
    const expiresAt = now + ttl;
    const result = this.#database.run(
      `UPDATE runtime_owners SET expires_at = ?
        WHERE singleton = 1 AND owner_id = ? AND fencing_token = ? AND expires_at > ?`,
      [expiresAt, current.ownerId, current.fencingToken, now],
    );
    if (result.changes !== 1) {
      throw new AbcmError("DERIVED_STORE_OWNER_LOST", "Runtime ownership was lost before heartbeat renewal.", {
        ownerId: current.ownerId,
        fencingToken: current.fencingToken,
      });
    }
    this.#runtimeOwner = { ...current, expiresAt };
    return { ...this.#runtimeOwner };
  }

  releaseRuntimeOwner(): void {
    const current = this.#runtimeOwner;
    if (current === undefined) return;
    this.#database.run(
      "UPDATE runtime_owners SET expires_at = 0 WHERE singleton = 1 AND owner_id = ? AND fencing_token = ?",
      [current.ownerId, current.fencingToken],
    );
    this.#runtimeOwner = undefined;
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

  #acquireRuntimeOwner(): RuntimeOwnerHandle {
    const ttl = this.#runtimeOwnerTtlMs;
    if (ttl === undefined) throw new Error("Runtime owner TTL is not configured.");
    const now = this.#clock();
    return this.#database.transaction(() => {
      const existing = this.#database
        .query<RuntimeOwnerRow, []>(
          "SELECT owner_id, expires_at, fencing_token FROM runtime_owners WHERE singleton = 1",
        )
        .get();
      if (existing !== null && existing.expires_at > now) {
        throw new AbcmError("DERIVED_STORE_OWNER_BUSY", "Another runtime owns this workspace database.", {
          ownerId: existing.owner_id,
          expiresAt: new Date(existing.expires_at).toISOString(),
        });
      }
      const owner: RuntimeOwnerHandle = {
        ownerId: this.#ownerId,
        fencingToken: (existing?.fencing_token ?? 0) + 1,
        expiresAt: now + ttl,
      };
      this.#database.run(
        `INSERT INTO runtime_owners (singleton, owner_id, expires_at, fencing_token)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           owner_id = excluded.owner_id,
           expires_at = excluded.expires_at,
           fencing_token = excluded.fencing_token`,
        [owner.ownerId, owner.expiresAt, owner.fencingToken],
      );
      return owner;
    }).immediate();
  }

  #assertRuntimeOwner(now = this.#clock()): void {
    const current = this.#runtimeOwner;
    if (this.#runtimeOwnerTtlMs === undefined) return;
    const persisted = this.#database
      .query<RuntimeOwnerRow, []>(
        "SELECT owner_id, expires_at, fencing_token FROM runtime_owners WHERE singleton = 1",
      )
      .get();
    if (
      current === undefined ||
      persisted === null ||
      persisted.owner_id !== current.ownerId ||
      persisted.fencing_token !== current.fencingToken ||
      persisted.expires_at <= now
    ) {
      throw new AbcmError("DERIVED_STORE_OWNER_LOST", "This runtime no longer owns the workspace database.", {
        ownerId: current?.ownerId,
        fencingToken: current?.fencingToken,
      });
    }
  }

  #migrate(): void {
    this.#database.transaction(() => {
      this.#database.run("CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      const current = this.#database
        .query<{ value: string }, [string]>("SELECT value FROM schema_metadata WHERE key = ?")
        .get("schema_version");
      const currentVersion = current === null ? 0 : Number(current.value);
      if (!Number.isSafeInteger(currentVersion) || currentVersion < 0 || currentVersion > SCHEMA_VERSION) {
        throw new AbcmError("DERIVED_STORE_CORRUPT", `Unsupported SQLite schema version '${current?.value ?? "missing"}'.`);
      }
      if (currentVersion < 1) {
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
      }
      if (currentVersion < 2) {
        this.#database.run(`CREATE TABLE runtime_owners (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          owner_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          fencing_token INTEGER NOT NULL CHECK(fencing_token > 0)
        )`);
      }
      if (currentVersion < 3) {
        this.#database.run(`CREATE TABLE IF NOT EXISTS map_files (
          workspace_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          size INTEGER NOT NULL,
          mtime INTEGER NOT NULL,
          checksum TEXT NOT NULL,
          parse_status TEXT NOT NULL,
          classification TEXT NOT NULL,
          storage_mode TEXT NOT NULL,
          source_id TEXT,
          PRIMARY KEY (workspace_id, revision, relative_path),
          FOREIGN KEY (workspace_id, revision) REFERENCES map_revisions(workspace_id, revision) ON DELETE CASCADE
        )`);
        this.#database.run(`CREATE TABLE IF NOT EXISTS map_documents (
          workspace_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          document_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          checksum TEXT NOT NULL,
          lifecycle TEXT NOT NULL,
          required_selectors_json TEXT NOT NULL,
          role_selectors_json TEXT NOT NULL,
          task_selectors_json TEXT NOT NULL,
          links_json TEXT NOT NULL,
          context_policy TEXT NOT NULL,
          storage_mode TEXT NOT NULL,
          PRIMARY KEY (workspace_id, revision, document_id),
          FOREIGN KEY (workspace_id, revision) REFERENCES map_revisions(workspace_id, revision) ON DELETE CASCADE
        )`);
        this.#database.run(`CREATE TABLE IF NOT EXISTS map_executable_resources (
          workspace_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          language TEXT NOT NULL,
          checksum TEXT NOT NULL,
          activation_status TEXT NOT NULL,
          permissions_profile TEXT NOT NULL,
          PRIMARY KEY (workspace_id, revision, resource_id),
          FOREIGN KEY (workspace_id, revision) REFERENCES map_revisions(workspace_id, revision) ON DELETE CASCADE
        )`);
      }
      if (currentVersion < 4) {
        this.#database.run(`CREATE TABLE IF NOT EXISTS documentation_sources (
          workspace_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          connector_kind TEXT NOT NULL,
          target_base_path TEXT NOT NULL,
          storage_mode TEXT NOT NULL CHECK(storage_mode IN ('mirror', 'managed')),
          status TEXT NOT NULL,
          PRIMARY KEY (workspace_id, source_id)
        )`);
        this.#database.run(`CREATE TABLE IF NOT EXISTS document_provenance (
          workspace_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_path TEXT NOT NULL,
          target_path TEXT NOT NULL,
          source_checksum TEXT NOT NULL,
          target_checksum TEXT NOT NULL,
          last_synchronized_at TEXT NOT NULL,
          active INTEGER NOT NULL CHECK(active IN (0, 1)),
          PRIMARY KEY (workspace_id, source_id, source_path),
          FOREIGN KEY (workspace_id, source_id) REFERENCES documentation_sources(workspace_id, source_id)
        )`);
        this.#database.run(
          "CREATE UNIQUE INDEX IF NOT EXISTS active_document_target ON document_provenance(workspace_id, target_path) WHERE active = 1",
        );
        this.#database.run(`CREATE TABLE IF NOT EXISTS sync_runs (
          sync_run_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          created INTEGER NOT NULL,
          updated INTEGER NOT NULL,
          moved INTEGER NOT NULL,
          deleted INTEGER NOT NULL,
          conflicts INTEGER NOT NULL,
          status TEXT NOT NULL,
          FOREIGN KEY (workspace_id, source_id) REFERENCES documentation_sources(workspace_id, source_id)
        )`);
        this.#database.run(`CREATE TABLE IF NOT EXISTS tombstones (
          resource_id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          former_path TEXT NOT NULL,
          checksum TEXT NOT NULL,
          deleted_at TEXT NOT NULL,
          reason TEXT NOT NULL,
          FOREIGN KEY (workspace_id, source_id) REFERENCES documentation_sources(workspace_id, source_id)
        )`);
      }
      if (currentVersion < 5) {
        this.#database.run(`CREATE TABLE IF NOT EXISTS map_nodes (
          workspace_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          name TEXT NOT NULL,
          aliases_json TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          parent_scope_id TEXT,
          rank INTEGER NOT NULL,
          status TEXT NOT NULL,
          readiness TEXT NOT NULL,
          PRIMARY KEY (workspace_id, revision, scope_id),
          FOREIGN KEY (workspace_id, revision) REFERENCES map_revisions(workspace_id, revision) ON DELETE CASCADE
        )`);
        this.#database.run(`CREATE TABLE IF NOT EXISTS map_relations (
          workspace_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          from_id TEXT NOT NULL,
          to_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          PRIMARY KEY (workspace_id, revision, from_id, to_id, relation_type, source),
          FOREIGN KEY (workspace_id, revision) REFERENCES map_revisions(workspace_id, revision) ON DELETE CASCADE
        )`);
        this.#database.run(`CREATE TABLE IF NOT EXISTS map_diagnostics (
          workspace_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          diagnostic_index INTEGER NOT NULL,
          code TEXT NOT NULL,
          severity TEXT NOT NULL,
          path TEXT NOT NULL,
          message TEXT NOT NULL,
          scope_id TEXT,
          PRIMARY KEY (workspace_id, revision, diagnostic_index),
          FOREIGN KEY (workspace_id, revision) REFERENCES map_revisions(workspace_id, revision) ON DELETE CASCADE
        )`);
        const revisions = this.#database
          .query<{ workspace_id: string; payload_json: string }, []>("SELECT workspace_id, payload_json FROM map_revisions")
          .all();
        for (const row of revisions) {
          let revision: MapRevision;
          try {
            revision = JSON.parse(row.payload_json) as MapRevision;
          } catch {
            throw new AbcmError("DERIVED_STORE_CORRUPT", "A persisted MapRevision payload cannot be migrated to schema v5.");
          }
          this.#persistNormalizedGraph(row.workspace_id, revision);
        }
      }
      this.#database.run(
        `INSERT INTO schema_metadata (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [String(SCHEMA_VERSION)],
      );
    }).immediate();
  }

  #persistNormalizedGraph(workspaceId: string, revision: MapRevision): void {
    for (const node of revision.nodes) {
      this.#database.run(
        `INSERT OR IGNORE INTO map_nodes
          (workspace_id, revision, scope_id, kind, name, aliases_json, relative_path, parent_scope_id, rank, status, readiness)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          revision.revision,
          node.scopeId,
          node.kind,
          node.name,
          JSON.stringify(node.aliases),
          node.relativePath,
          node.parentScopeId ?? null,
          node.rank,
          node.status,
          node.readiness,
        ],
      );
    }
    for (const relation of revision.relations) {
      const source = relation.source ?? (relation.relationType === "parent-child" ? "physical-hierarchy" : "legacy-map-payload");
      const status = relation.status ?? "resolved";
      this.#database.run(
        `INSERT OR IGNORE INTO map_relations
          (workspace_id, revision, from_id, to_id, relation_type, source, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [workspaceId, revision.revision, relation.fromId, relation.toId, relation.relationType, source, status],
      );
    }
    for (const [index, diagnostic] of revision.diagnostics.entries()) {
      this.#database.run(
        `INSERT OR IGNORE INTO map_diagnostics
          (workspace_id, revision, diagnostic_index, code, severity, path, message, scope_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          workspaceId,
          revision.revision,
          index,
          diagnostic.code,
          diagnostic.severity,
          diagnostic.path,
          diagnostic.message,
          diagnostic.scopeId ?? null,
        ],
      );
    }
  }
}
