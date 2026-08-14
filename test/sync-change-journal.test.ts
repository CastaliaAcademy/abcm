import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteSyncJournal } from "../src/sync/sqlite-sync-journal.js";

const checksumA = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const checksumB = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const roots: string[] = [];

async function journal() {
  const root = await mkdtemp(join(tmpdir(), "abcm-sync-journal-"));
  roots.push(root);
  return { databasePath: join(root, "sync.sqlite"), store: new SqliteSyncJournal(join(root, "sync.sqlite")) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("SqliteSyncJournal", () => {
  test("persists ordered create, update, move, and tombstone events with one stable object id", async () => {
    const { databasePath, store } = await journal();
    const initialCursor = store.currentCursor();
    const created = store.record({
      operationId: "op_create_00000001",
      originDeviceId: "device_00000001",
      kind: "create",
      path: "notes/one.md",
      checksum: checksumA,
      size: 1,
      contentType: "text/markdown",
    });
    const updated = store.record({
      operationId: "op_update_00000001",
      originDeviceId: "device_00000001",
      kind: "update",
      objectId: created.event.objectId,
      path: "notes/one.md",
      baseChecksum: checksumA,
      checksum: checksumB,
      size: 2,
      contentType: "text/markdown",
    });
    const moved = store.record({
      operationId: "op_move_000000001",
      originDeviceId: "device_00000001",
      kind: "move",
      objectId: created.event.objectId,
      previousPath: "notes/one.md",
      path: "notes/two.md",
      baseChecksum: checksumB,
      checksum: checksumB,
      size: 2,
      contentType: "text/markdown",
    });
    const deleted = store.record({
      operationId: "op_delete_0000001",
      originDeviceId: null,
      kind: "delete",
      objectId: created.event.objectId,
      path: "notes/two.md",
      baseChecksum: checksumB,
    });

    expect([created, updated, moved, deleted].map(result => result.status)).toEqual(["applied", "applied", "applied", "applied"]);
    expect([created, updated, moved, deleted].map(result => result.event.objectId)).toEqual(Array(4).fill(created.event.objectId));
    expect(deleted.event.tombstone).toBe(true);
    expect(store.changesAfter(initialCursor, 10).changes.map(change => change.kind)).toEqual(["create", "update", "move", "delete"]);
    expect(store.getObject(created.event.objectId)).toEqual(expect.objectContaining({ path: "notes/two.md", deleted: true }));
    expect(store.listTombstones()).toEqual([expect.objectContaining({ objectId: created.event.objectId, path: "notes/two.md" })]);
    const cursorAfterCreate = created.event.cursor;
    store.close();

    const reopened = new SqliteSyncJournal(databasePath);
    expect(reopened.changesAfter(cursorAfterCreate, 10).changes.map(change => change.kind)).toEqual(["update", "move", "delete"]);
    reopened.close();
  });

  test("returns the same receipt for an identical retry and rejects operation id reuse", async () => {
    const { store } = await journal();
    const input = {
      operationId: "op_retry_000000001",
      originDeviceId: "device_00000001",
      kind: "create" as const,
      path: "retry.md",
      checksum: checksumA,
      size: 1,
      contentType: "text/markdown",
    };
    const applied = store.record(input);
    const duplicate = store.record(input);
    expect(duplicate).toEqual({ ...applied, status: "duplicate" });
    expect(store.changesAfter(store.cursorBefore(applied.event.cursor), 10).changes).toHaveLength(1);
    expect(() => store.record({ ...input, path: "different.md" })).toThrow(expect.objectContaining({ code: "SYNC_IDEMPOTENCY_CONFLICT" }));
    store.close();
  });

  test("rejects stale object state without appending an event", async () => {
    const { store } = await journal();
    const before = store.currentCursor();
    const created = store.record({
      operationId: "op_cas_create_0001",
      originDeviceId: "device_00000001",
      kind: "create",
      path: "cas.md",
      checksum: checksumA,
      size: 1,
      contentType: "text/markdown",
    });
    expect(() => store.record({
      operationId: "op_cas_update_0001",
      originDeviceId: "device_00000001",
      kind: "update",
      objectId: created.event.objectId,
      path: "cas.md",
      baseChecksum: checksumB,
      checksum: checksumA,
      size: 1,
      contentType: "text/markdown",
    })).toThrow(expect.objectContaining({ code: "SYNC_OBJECT_CONFLICT" }));
    expect(store.changesAfter(before, 10).changes).toHaveLength(1);
    store.close();
  });

  test("authenticates opaque cursors and expires only compacted history", async () => {
    const { store } = await journal();
    const original = store.currentCursor();
    const first = store.record({ operationId: "op_compact_000001", originDeviceId: null, kind: "create", path: "a.md", checksum: checksumA, size: 1, contentType: "text/markdown" });
    const second = store.record({ operationId: "op_compact_000002", originDeviceId: null, kind: "update", objectId: first.event.objectId, path: "a.md", baseChecksum: checksumA, checksum: checksumB, size: 2, contentType: "text/markdown" });

    expect(() => store.changesAfter(`${first.event.cursor}tampered`, 10)).toThrow(expect.objectContaining({ code: "SYNC_CURSOR_INVALID" }));
    store.compactThrough(first.event.cursor);
    expect(() => store.changesAfter(original, 10)).toThrow(expect.objectContaining({ code: "SYNC_CURSOR_EXPIRED" }));
    expect(store.changesAfter(first.event.cursor, 10).changes.map(change => change.cursor)).toEqual([second.event.cursor]);
    store.close();
  });
});
