import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteSyncJournal } from "../src/sync/sqlite-sync-journal.js";

const checksum = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("sync journal preserves idempotency receipts across restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "abcm-sync-retry-"));
  const databasePath = join(root, "sync.sqlite");
  const input = {
    operationId: "op_restart_retry_01",
    originDeviceId: "device_00000001",
    kind: "create" as const,
    path: "restart.md",
    checksum,
    size: 1,
    contentType: "text/markdown",
  };
  try {
    const first = new SqliteSyncJournal(databasePath);
    const applied = first.record(input);
    first.close();

    const reopened = new SqliteSyncJournal(databasePath);
    expect(reopened.record(input)).toEqual({ ...applied, status: "duplicate" });
    expect(reopened.changesAfter(reopened.cursorBefore(applied.event.cursor), 10).changes).toHaveLength(1);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
