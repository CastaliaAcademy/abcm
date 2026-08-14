import { describe, expect, test } from "bun:test";

import {
  syncApplyBatchSchema,
  syncChangeEventSchema,
  syncConflictResolutionSchema,
  syncPairingRedeemSchema,
  syncPortableInventorySchema,
  syncPreviewRequestSchema,
} from "../src/sync/contracts.js";

const checksum = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("Obsidian synchronization contracts", () => {
  test("accepts a scoped pairing redemption without accepting a client-selected project", () => {
    expect(syncPairingRedeemSchema.parse({
      pairingCode: "pair_7Yk2Wm9Q",
      device: { id: "device_01JABCDEF0123456789", name: "Egor iPad", platform: "ipados" },
    })).toEqual({
      pairingCode: "pair_7Yk2Wm9Q",
      device: { id: "device_01JABCDEF0123456789", name: "Egor iPad", platform: "ipados" },
    });
    expect(() => syncPairingRedeemSchema.parse({
      pairingCode: "pair_7Yk2Wm9Q",
      workspaceId: "other",
      projectId: "other",
      device: { id: "device_01JABCDEF0123456789", name: "Egor iPad", platform: "ipados" },
    })).toThrow();
  });

  test("validates ordered changes with stable identity, origin, operation id, and tombstone", () => {
    expect(syncChangeEventSchema.parse({
      cursor: "cur_0000000000000001",
      objectId: "obj_01JABCDEF0123456789",
      operationId: "op_01JABCDEF0123456789",
      originDeviceId: "device_01JABCDEF0123456789",
      kind: "delete",
      path: "notes/Architecture.md",
      baseChecksum: checksum,
      tombstone: true,
      occurredAt: "2026-08-14T00:00:00.000Z",
    }).kind).toBe("delete");
    expect(() => syncChangeEventSchema.parse({
      cursor: "cur_2",
      objectId: "obj_01JABCDEF0123456789",
      operationId: "op_01JABCDEF0123456789",
      kind: "delete",
      path: "notes/Architecture.md",
      tombstone: false,
      occurredAt: "2026-08-14T00:00:00.000Z",
    })).toThrow();
  });

  test("rejects non-portable, reserved, and colliding inventory paths", () => {
    for (const path of ["../escape.md", "/absolute.md", "folder\\note.md", ".obsidian/app.json", "_ABCM Conflicts/server.md", "CON.md", "notes/trailing. "]) {
      expect(() => syncPreviewRequestSchema.parse({ cursor: null, inventory: [{ path, checksum, size: 1 }] })).toThrow();
    }
    expect(() => syncPortableInventorySchema.parse([
      { path: "Notes/Cafe\u0301.md", checksum, size: 1 },
      { path: "notes/Caf\u00e9.md", checksum, size: 1 },
    ])).toThrow();
  });

  test("requires checksummed idempotent mutations and explicit conflict policy", () => {
    expect(() => syncApplyBatchSchema.parse({
      cursor: "cur_0000000000000001",
      operations: [{ operationId: "op_01JABCDEF0123456789", kind: "update", objectId: "obj_01JABCDEF0123456789", path: "note.md" }],
    })).toThrow();
    expect(syncConflictResolutionSchema.parse({
      operationId: "op_01JABCDEF0123456789",
      resolution: "keep-both",
      localChecksum: checksum,
      serverChecksum: checksum,
      keepBothPath: "note.server.md",
    }).resolution).toBe("keep-both");
    expect(() => syncConflictResolutionSchema.parse({
      operationId: "op_01JABCDEF0123456789",
      resolution: "last-write-wins",
      localChecksum: checksum,
      serverChecksum: checksum,
    })).toThrow();
  });
});
