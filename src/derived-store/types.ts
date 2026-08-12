import type { MapRevision } from "../scope-map/types.js";

export interface ScanLeaseHandle {
  workspaceId: string;
  scanId: string;
  ownerId: string;
  fencingToken: number;
  expiresAt: number;
  previousMapRevision?: string;
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
  clock?: () => number;
}
