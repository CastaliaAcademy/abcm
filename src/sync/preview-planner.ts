import { portablePathKey } from "./contracts.js";

export interface SyncBaseStateEntry {
  objectId: string;
  path: string;
  checksum: string;
}

export interface SyncPreviewInventoryEntry {
  path: string;
  checksum: string;
  size: number;
}

export interface SyncLocalIdentityHint {
  objectId: string;
  previousPath: string;
  path: string;
}

export interface SyncPreviewServerEntry extends SyncPreviewInventoryEntry {
  objectId: string;
}

export interface PlannedSyncPreviewItem {
  action: "create-local" | "create-server" | "update-local" | "update-server" | "delete-local" | "delete-server" | "move-local" | "move-server" | "conflict" | "noop";
  objectId: string;
  path: string;
  previousPath?: string;
  localChecksum: string | null;
  serverChecksum: string | null;
  size: number | null;
}

interface PlannerInput {
  base: readonly SyncBaseStateEntry[];
  local: readonly SyncPreviewInventoryEntry[];
  server: readonly SyncPreviewServerEntry[];
  identityHints?: readonly SyncLocalIdentityHint[];
  objectIdForPath(path: string): string;
}

function samePath(left: string, right: string): boolean {
  return portablePathKey(left) === portablePathKey(right);
}

function planKnownObject(
  base: SyncBaseStateEntry,
  local: SyncPreviewInventoryEntry | undefined,
  server: SyncPreviewServerEntry | undefined,
  identityHinted = false,
): PlannedSyncPreviewItem | undefined {
  if (local === undefined && server === undefined) return undefined;
  if (local === undefined) {
    const serverUnchanged = samePath(server!.path, base.path) && server!.checksum === base.checksum;
    return {
      action: serverUnchanged ? "delete-server" : "conflict",
      objectId: base.objectId,
      path: server!.path,
      localChecksum: null,
      serverChecksum: server!.checksum,
      size: server!.size,
    };
  }
  if (server === undefined) {
    const localUnchanged = samePath(local.path, base.path) && local.checksum === base.checksum;
    return {
      action: localUnchanged ? "delete-local" : "conflict",
      objectId: base.objectId,
      path: local.path,
      localChecksum: local.checksum,
      serverChecksum: null,
      size: local.size,
    };
  }

  const localUnchanged = samePath(local.path, base.path) && local.checksum === base.checksum;
  const serverUnchanged = samePath(server.path, base.path) && server.checksum === base.checksum;
  const converged = samePath(local.path, server.path) && local.checksum === server.checksum;
  if (converged) {
    return {
      action: "noop",
      objectId: base.objectId,
      path: server.path,
      localChecksum: local.checksum,
      serverChecksum: server.checksum,
      size: server.size,
    };
  }
  if (localUnchanged && !serverUnchanged) {
    const moved = !samePath(server.path, base.path);
    return {
      action: moved ? "move-local" : "update-local",
      objectId: base.objectId,
      path: server.path,
      ...(moved ? { previousPath: local.path } : {}),
      localChecksum: local.checksum,
      serverChecksum: server.checksum,
      size: server.size,
    };
  }
  if (!localUnchanged && serverUnchanged) {
    const moved = !samePath(local.path, base.path);
    const moveOnly = moved && local.checksum === base.checksum;
    const updateOnly = !moved;
    return {
      action: moved && (moveOnly || identityHinted) ? "move-server" : updateOnly ? "update-server" : "conflict",
      objectId: base.objectId,
      path: local.path,
      ...(moved ? { previousPath: server.path } : {}),
      localChecksum: local.checksum,
      serverChecksum: server.checksum,
      size: local.size,
    };
  }
  return {
    action: "conflict",
    objectId: base.objectId,
    path: local.path,
    ...(!samePath(local.path, server.path) ? { previousPath: server.path } : {}),
    localChecksum: local.checksum,
    serverChecksum: server.checksum,
    size: local.size,
  };
}

export function planIdentityAwarePreview(input: PlannerInput): PlannedSyncPreviewItem[] {
  const localByPath = new Map(input.local.map(entry => [portablePathKey(entry.path), entry]));
  const serverByObject = new Map(input.server.map(entry => [entry.objectId, entry]));
  const hintsByObject = new Map((input.identityHints ?? []).map(hint => [hint.objectId, hint]));
  const usedLocal = new Set<SyncPreviewInventoryEntry>();
  const usedServer = new Set<SyncPreviewServerEntry>();
  const items: PlannedSyncPreviewItem[] = [];

  for (const base of input.base) {
    const hint = hintsByObject.get(base.objectId);
    let local = hint === undefined
      ? localByPath.get(portablePathKey(base.path))
      : localByPath.get(portablePathKey(hint.path));
    if (local === undefined && hint === undefined) {
      const candidates = input.local.filter(candidate => !usedLocal.has(candidate) && candidate.checksum === base.checksum);
      if (candidates.length === 1) local = candidates[0];
    }
    const server = serverByObject.get(base.objectId);
    if (local !== undefined) usedLocal.add(local);
    if (server !== undefined) usedServer.add(server);
    const item = planKnownObject(base, local, server, hint !== undefined);
    if (item !== undefined) items.push(item);
  }

  const remainingLocal = input.local.filter(entry => !usedLocal.has(entry));
  const remainingServer = input.server.filter(entry => !usedServer.has(entry));
  const remainingServerByPath = new Map(remainingServer.map(entry => [portablePathKey(entry.path), entry]));
  for (const local of remainingLocal) {
    const server = remainingServerByPath.get(portablePathKey(local.path));
    if (server !== undefined) {
      usedServer.add(server);
      items.push({
        action: local.checksum === server.checksum ? "noop" : "conflict",
        objectId: server.objectId,
        path: local.path,
        localChecksum: local.checksum,
        serverChecksum: server.checksum,
        size: local.size,
      });
    } else {
      items.push({
        action: "create-server",
        objectId: input.objectIdForPath(local.path),
        path: local.path,
        localChecksum: local.checksum,
        serverChecksum: null,
        size: local.size,
      });
    }
  }
  for (const server of remainingServer) {
    if (usedServer.has(server)) continue;
    items.push({
      action: "create-local",
      objectId: server.objectId,
      path: server.path,
      localChecksum: null,
      serverChecksum: server.checksum,
      size: server.size,
    });
  }
  return items.sort((left, right) => portablePathKey(left.path).localeCompare(portablePathKey(right.path)));
}
