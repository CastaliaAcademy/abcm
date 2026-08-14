import { describe, expect, test } from "bun:test";

import {
  syncConflictResolutionSchema,
  syncConflictSchema,
  syncOperationReceiptSchema,
} from "../src/sync/contracts.js";

const checksum = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("Obsidian conflict contracts", () => {
  test("represents deletion conflicts without inventing missing bytes", () => {
    expect(syncConflictSchema.parse({
      conflictId: "conflict_01JABCDEF0123456789",
      objectId: "obj_01JABCDEF0123456789",
      kind: "delete-update",
      path: "note.md",
      local: { state: "present", checksum, size: 12, contentType: "text/markdown" },
      server: { state: "deleted", baseChecksum: checksum },
      baseChecksum: checksum,
      status: "open",
    }).server.state).toBe("deleted");
    expect(syncConflictResolutionSchema.parse({
      operationId: "op_01JABCDEF0123456789",
      resolution: "keep-server",
      localChecksum: checksum,
      serverChecksum: null,
    }).resolution).toBe("keep-server");
  });

  test("requires a conflict id in conflict receipts", () => {
    expect(() => syncOperationReceiptSchema.parse({
      operationId: "op_01JABCDEF0123456789",
      status: "conflict",
      cursor: "cur_0000000000000001",
      objectId: "obj_01JABCDEF0123456789",
      checksum: null,
    })).toThrow();
  });
});
