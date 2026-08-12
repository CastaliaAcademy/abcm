import { join } from "node:path";

import type { MapRevision } from "../scope-map/types.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { SqliteScopeMapStore } from "./sqlite-scope-map-store.js";
import type { ScanLeaseHandle, ScopeMapStore, SqliteScopeMapStoreOptions } from "./types.js";

export class SqliteWorkspaceMapStore implements ScopeMapStore {
  readonly #registry: WorkspaceRegistry;
  readonly #options: SqliteScopeMapStoreOptions;
  readonly #stores = new Map<string, SqliteScopeMapStore>();

  constructor(registry: WorkspaceRegistry, options: SqliteScopeMapStoreOptions = {}) {
    this.#registry = registry;
    this.#options = options;
  }

  beginScan(workspaceId: string): ScanLeaseHandle {
    return this.#store(workspaceId).beginScan(workspaceId);
  }

  publish(lease: ScanLeaseHandle, revision: MapRevision): void {
    this.#store(lease.workspaceId).publish(lease, revision);
  }

  fail(lease: ScanLeaseHandle): void {
    this.#store(lease.workspaceId).fail(lease);
  }

  getActive(workspaceId: string): MapRevision | undefined {
    return this.#store(workspaceId).getActive(workspaceId);
  }

  close(): void {
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }

  #store(workspaceId: string): SqliteScopeMapStore {
    const existing = this.#stores.get(workspaceId);
    if (existing !== undefined) return existing;
    const workspace = this.#registry.get(workspaceId);
    const store = new SqliteScopeMapStore(join(workspace.root, ".abcm", "abcm.sqlite"), this.#options);
    this.#stores.set(workspaceId, store);
    return store;
  }
}
