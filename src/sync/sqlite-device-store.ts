import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Database } from "bun:sqlite";

import { AbcmError } from "../core/errors.js";
import {
  syncPairingCreateSchema,
  syncPairingRedeemSchema,
  type SyncDeviceGrant,
} from "./contracts.js";

const DEFAULT_PAIRING_TTL_SECONDS = 300;

type SyncCapability = "read" | "write";

export interface DeviceAuthenticationScope {
  workspaceId: string;
  projectId: string;
  capability: SyncCapability;
}

export interface ObsidianProjectScope {
  projectId: string;
  projectPrefix: string | null;
}

export interface ObsidianDevicePrincipal {
  deviceId: string;
  deviceName: string;
  platform: "windows" | "linux" | "ipados";
  workspaceId: string;
  projectId: string;
  projectPrefix: string | null;
  capabilities: SyncCapability[];
}

export interface SqliteObsidianDeviceStoreOptions {
  clock?: () => number;
  credentialTtlSeconds?: number;
}

interface PairingRow {
  code_hash: string;
  workspace_id: string;
  project_id: string;
  project_prefix: string | null;
  capabilities_json: string;
  expires_at_ms: number;
  redeemed_at_ms: number | null;
}

interface DeviceRow {
  credential_hash: string;
  device_id: string;
  device_name: string;
  platform: "windows" | "linux" | "ipados";
  workspace_id: string;
  project_id: string;
  project_prefix: string | null;
  capabilities_json: string;
  expires_at_ms: number | null;
  revoked_at_ms: number | null;
}

function secretHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function randomSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function capabilities(json: string): SyncCapability[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed) || parsed.some(value => value !== "read" && value !== "write")) throw new Error("invalid capabilities");
    return parsed as SyncCapability[];
  } catch {
    throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Obsidian device capabilities are invalid.");
  }
}

export class SqliteObsidianDeviceStore {
  readonly #database: Database;
  readonly #clock: () => number;
  readonly #credentialTtlSeconds: number | undefined;

  constructor(databasePath: string, options: SqliteObsidianDeviceStoreOptions = {}) {
    if (options.credentialTtlSeconds !== undefined && (!Number.isSafeInteger(options.credentialTtlSeconds) || options.credentialTtlSeconds < 60)) {
      throw new Error("Obsidian device credential TTL must be at least 60 seconds.");
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    this.#database = new Database(databasePath, { create: true, readwrite: true });
    this.#clock = options.clock ?? Date.now;
    this.#credentialTtlSeconds = options.credentialTtlSeconds;
    this.#database.run("PRAGMA foreign_keys = ON");
    this.#database.run("PRAGMA busy_timeout = 5000");
    this.#database.run("PRAGMA journal_mode = DELETE");
    this.#migrate();
  }

  createPairing(rawInput: unknown): { pairingCode: string; expiresAt: string } {
    const input = syncPairingCreateSchema.parse(rawInput);
    const pairingCode = randomSecret("pair_");
    const expiresAtMs = this.#clock() + (input.expiresInSeconds ?? DEFAULT_PAIRING_TTL_SECONDS) * 1_000;
    this.#database.run(
      `INSERT INTO obsidian_pairings
       (code_hash, workspace_id, project_id, project_prefix, capabilities_json, expires_at_ms)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        secretHash(pairingCode),
        input.workspaceId,
        input.projectId,
        input.projectPrefix ?? null,
        JSON.stringify(input.capabilities),
        expiresAtMs,
      ],
    );
    return { pairingCode, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  redeemPairing(rawInput: unknown): SyncDeviceGrant {
    const input = syncPairingRedeemSchema.parse(rawInput);
    return this.#database.transaction(() => {
      const row = this.#database.query<PairingRow, [string]>(
        `SELECT code_hash, workspace_id, project_id, project_prefix, capabilities_json, expires_at_ms, redeemed_at_ms
         FROM obsidian_pairings WHERE code_hash = ?`,
      ).get(secretHash(input.pairingCode));
      const now = this.#clock();
      if (row === null || row.redeemed_at_ms !== null || row.expires_at_ms <= now) {
        throw new AbcmError("AUTHENTICATION_REQUIRED", "Pairing code is invalid, expired, or already redeemed.");
      }
      const claimed = this.#database.run(
        "UPDATE obsidian_pairings SET redeemed_at_ms = ? WHERE code_hash = ? AND redeemed_at_ms IS NULL AND expires_at_ms > ?",
        [now, row.code_hash, now],
      );
      if (claimed.changes !== 1) throw new AbcmError("AUTHENTICATION_REQUIRED", "Pairing code could not be redeemed.");

      const credential = randomSecret("obs_device_");
      const expiresAtMs = this.#credentialTtlSeconds === undefined ? null : now + this.#credentialTtlSeconds * 1_000;
      const existingDevice = this.#database.query<{ revoked_at_ms: number | null }, [string]>(
        "SELECT revoked_at_ms FROM obsidian_devices WHERE device_id = ?",
      ).get(input.device.id);
      if (existingDevice !== null && existingDevice.revoked_at_ms === null) {
        throw new AbcmError("ACCESS_DENIED", "Device id is already paired.");
      }
      if (existingDevice === null) {
        this.#database.run(
          `INSERT INTO obsidian_devices
           (credential_hash, device_id, device_name, platform, workspace_id, project_id, project_prefix, capabilities_json, created_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            secretHash(credential),
            input.device.id,
            input.device.name,
            input.device.platform,
            row.workspace_id,
            row.project_id,
            row.project_prefix,
            row.capabilities_json,
            now,
            expiresAtMs,
          ],
        );
      } else {
        const replaced = this.#database.run(
          `UPDATE obsidian_devices
           SET credential_hash = ?, device_name = ?, platform = ?, workspace_id = ?, project_id = ?, project_prefix = ?,
               capabilities_json = ?, created_at_ms = ?, expires_at_ms = ?, revoked_at_ms = NULL
           WHERE device_id = ? AND revoked_at_ms IS NOT NULL`,
          [
            secretHash(credential),
            input.device.name,
            input.device.platform,
            row.workspace_id,
            row.project_id,
            row.project_prefix,
            row.capabilities_json,
            now,
            expiresAtMs,
            input.device.id,
          ],
        );
        if (replaced.changes !== 1) throw new AbcmError("ACCESS_DENIED", "Device id is already paired.");
      }
      return {
        deviceId: input.device.id,
        credential,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        projectPrefix: row.project_prefix,
        capabilities: capabilities(row.capabilities_json),
        expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs).toISOString(),
      };
    }).immediate();
  }

  authenticate(credential: string, scope: DeviceAuthenticationScope): ObsidianDevicePrincipal {
    if (!credential.startsWith("obs_device_") || credential.length < 32) {
      throw new AbcmError("AUTHENTICATION_REQUIRED", "A valid Obsidian device credential is required.");
    }
    const row = this.#database.query<DeviceRow, [string]>(
      `SELECT credential_hash, device_id, device_name, platform, workspace_id, project_id, project_prefix,
              capabilities_json, expires_at_ms, revoked_at_ms
       FROM obsidian_devices WHERE credential_hash = ?`,
    ).get(secretHash(credential));
    const now = this.#clock();
    if (row === null || row.revoked_at_ms !== null || (row.expires_at_ms !== null && row.expires_at_ms <= now)) {
      throw new AbcmError("AUTHENTICATION_REQUIRED", "Obsidian device credential is invalid, expired, or revoked.");
    }
    const grantedCapabilities = capabilities(row.capabilities_json);
    if (row.workspace_id !== scope.workspaceId || row.project_id !== scope.projectId || !grantedCapabilities.includes(scope.capability)) {
      throw new AbcmError("ACCESS_DENIED", "Obsidian device credential does not grant the requested synchronization scope.");
    }
    return {
      deviceId: row.device_id,
      deviceName: row.device_name,
      platform: row.platform,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      projectPrefix: row.project_prefix,
      capabilities: grantedCapabilities,
    };
  }

  revokeDevice(deviceId: string): void {
    const result = this.#database.run(
      "UPDATE obsidian_devices SET revoked_at_ms = ? WHERE device_id = ? AND revoked_at_ms IS NULL",
      [this.#clock(), deviceId],
    );
    if (result.changes !== 1) throw new AbcmError("SYNC_OBJECT_NOT_FOUND", "Obsidian device grant was not found.", { deviceId });
  }

  listActiveProjectScopes(workspaceId: string): ObsidianProjectScope[] {
    const rows = this.#database.query<{ project_id: string; project_prefix: string | null }, [string, number]>(
      `SELECT DISTINCT project_id, project_prefix FROM obsidian_devices
       WHERE workspace_id = ? AND revoked_at_ms IS NULL AND (expires_at_ms IS NULL OR expires_at_ms > ?)
       ORDER BY project_id, project_prefix`,
    ).all(workspaceId, this.#clock());
    return rows.map(row => ({ projectId: row.project_id, projectPrefix: row.project_prefix }));
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.transaction(() => {
      this.#database.run("CREATE TABLE IF NOT EXISTS obsidian_device_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.#database.run("INSERT OR IGNORE INTO obsidian_device_metadata (key, value) VALUES ('schema_version', '1')");
      const version = this.#database.query<{ value: string }, []>("SELECT value FROM obsidian_device_metadata WHERE key = 'schema_version'").get();
      if (version?.value !== "1") throw new AbcmError("SYNC_JOURNAL_CORRUPT", "Unsupported Obsidian device store schema version.");
      this.#database.run(`CREATE TABLE IF NOT EXISTS obsidian_pairings (
        code_hash TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_prefix TEXT,
        capabilities_json TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        redeemed_at_ms INTEGER
      )`);
      this.#database.run(`CREATE TABLE IF NOT EXISTS obsidian_devices (
        credential_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('windows', 'linux', 'ipados')),
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_prefix TEXT,
        capabilities_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER,
        revoked_at_ms INTEGER
      )`);
      this.#database.run("CREATE INDEX IF NOT EXISTS obsidian_devices_scope ON obsidian_devices(workspace_id, project_id)");
    }).immediate();
  }
}
