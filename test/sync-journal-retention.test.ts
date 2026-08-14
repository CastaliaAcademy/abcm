import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteSyncJournal } from "../src/sync/sqlite-sync-journal.js";

const checksum = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("sync journal keeps its monotonic cursor after compacting every event", async () => {
  const root = await mkdtemp(join(tmpdir(), "abcm-sync-retention-"));
  try {
    const store = new SqliteSyncJournal(join(root, "sync.sqlite"));
    const event = store.record({
      operationId: "op_full_compact_001",
      originDeviceId: null,
      kind: "create",
      path: "compact.md",
      checksum,
      size: 1,
      contentType: "text/markdown",
    }).event;
    store.compactThrough(event.cursor);
    expect(store.currentCursor()).toBe(event.cursor);
    expect(store.changesAfter(event.cursor, 10)).toEqual({ changes: [], nextCursor: event.cursor, hasMore: false });
    store.close();

    const reopened = new SqliteSyncJournal(join(root, "sync.sqlite"));
    expect(reopened.currentCursor()).toBe(event.cursor);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
