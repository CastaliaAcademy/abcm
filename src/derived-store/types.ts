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
  readonly scanLeaseRenewalIntervalMs: number;
  beginScan(workspaceId: string): ScanLeaseHandle;
  renew(lease: ScanLeaseHandle): ScanLeaseHandle;
  publish(lease: ScanLeaseHandle, revision: MapRevision): void;
  fail(lease: ScanLeaseHandle): void;
  getActive(workspaceId: string): MapRevision | undefined;
  close(): void;
}

export interface SqliteScopeMapStoreOptions {
  ownerId?: string;
  leaseTtlMs?: number;
  scanLeaseRenewalIntervalMs?: number;
  runtimeOwnerTtlMs?: number;
  clock?: () => number;
}

export interface SqliteWorkspaceMapStoreOptions extends SqliteScopeMapStoreOptions {
  runtimeOwnerRenewalIntervalMs?: number;
}
