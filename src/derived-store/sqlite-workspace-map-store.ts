import { join } from "node:path";

import type { MapRevision } from "../scope-map/types.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { SqliteScopeMapStore } from "./sqlite-scope-map-store.js";
import type { ScanLeaseHandle, ScopeMapStore, SqliteWorkspaceMapStoreOptions } from "./types.js";

export class SqliteWorkspaceMapStore implements ScopeMapStore {
  readonly scanLeaseRenewalIntervalMs: number;
  readonly #registry: WorkspaceRegistry;
  readonly #options: SqliteWorkspaceMapStoreOptions;
  readonly #stores = new Map<string, SqliteScopeMapStore>();
  readonly #runtimeOwnerTtlMs: number;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  #ownershipError: unknown;

  constructor(registry: WorkspaceRegistry, options: SqliteWorkspaceMapStoreOptions = {}) {
    this.#registry = registry;
    this.#options = options;
    this.#runtimeOwnerTtlMs = options.runtimeOwnerTtlMs ?? 30_000;
    const scanLeaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.scanLeaseRenewalIntervalMs = options.scanLeaseRenewalIntervalMs ?? Math.floor(scanLeaseTtlMs / 3);
    if (
      !Number.isSafeInteger(this.scanLeaseRenewalIntervalMs) ||
      this.scanLeaseRenewalIntervalMs <= 0 ||
      this.scanLeaseRenewalIntervalMs >= scanLeaseTtlMs
    ) {
      throw new Error("scanLeaseRenewalIntervalMs must be a positive integer smaller than leaseTtlMs.");
    }
    const renewalIntervalMs = options.runtimeOwnerRenewalIntervalMs ?? Math.floor(this.#runtimeOwnerTtlMs / 3);
    if (!Number.isSafeInteger(renewalIntervalMs) || renewalIntervalMs <= 0 || renewalIntervalMs >= this.#runtimeOwnerTtlMs) {
      throw new Error("runtimeOwnerRenewalIntervalMs must be a positive integer smaller than runtimeOwnerTtlMs.");
    }
    this.#heartbeat = setInterval(() => {
      try {
        this.renewOwnership();
      } catch (error) {
        this.#ownershipError = error;
      }
    }, renewalIntervalMs);
    this.#heartbeat.unref();
  }

  beginScan(workspaceId: string): ScanLeaseHandle {
    this.#assertHealthy();
    return this.#store(workspaceId).beginScan(workspaceId);
  }

  publish(lease: ScanLeaseHandle, revision: MapRevision): void {
    this.#assertHealthy();
    this.#store(lease.workspaceId).publish(lease, revision);
  }

  renew(lease: ScanLeaseHandle): ScanLeaseHandle {
    this.#assertHealthy();
    return this.#store(lease.workspaceId).renew(lease);
  }

  fail(lease: ScanLeaseHandle): void {
    this.#assertHealthy();
    this.#store(lease.workspaceId).fail(lease);
  }

  getActive(workspaceId: string): MapRevision | undefined {
    this.#assertHealthy();
    return this.#store(workspaceId).getActive(workspaceId);
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }

  renewOwnership(): void {
    this.#assertHealthy();
    for (const store of this.#stores.values()) store.renewRuntimeOwner();
  }

  #store(workspaceId: string): SqliteScopeMapStore {
    this.#assertHealthy();
    const existing = this.#stores.get(workspaceId);
    if (existing !== undefined) return existing;
    const workspace = this.#registry.get(workspaceId);
    const store = new SqliteScopeMapStore(join(workspace.root, ".abcm", "abcm.sqlite"), {
      ...this.#options,
      runtimeOwnerTtlMs: this.#runtimeOwnerTtlMs,
    });
    this.#stores.set(workspaceId, store);
    return store;
  }

  #assertHealthy(): void {
    if (this.#ownershipError !== undefined) throw this.#ownershipError;
  }
}
