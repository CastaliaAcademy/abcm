import type { MapRevision } from "../scope-map/types.js";

export interface ScanLeaseHandle {
  workspaceId: string;
  scanId: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: number;
  previousMapRevision?: string;
}

export interface RuntimeOwnerHandle {
  ownerId: string;
  fencingToken: number;
  expiresAt: number;
}

export interface ScopeMapStore {
  beginScan(workspaceId: string): ScanLeaseHandle;
  publish(lease: ScanLeaseHandle, revision: MapRevision): void;
  fail(lease: ScanLeaseHandle): void;
  getActive(workspaceId: string): MapRevision | undefined;
  close(): void;
}

export interface SqliteScopeMapStoreOptions {
  ownerId?: string;
  leaseTtlMs?: number;
  runtimeOwnerTtlMs?: number;
  clock?: () => number;
}

export interface SqliteWorkspaceMapStoreOptions extends SqliteScopeMapStoreOptions {
  runtimeOwnerRenewalIntervalMs?: number;
}
