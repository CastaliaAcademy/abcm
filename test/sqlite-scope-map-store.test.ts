import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { SqliteScopeMapStore } from "../src/derived-store/sqlite-scope-map-store.js";
import type { MapRevision } from "../src/scope-map/types.js";

let root: string;
let databasePath: string;
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "abcm-sqlite-store-"));
  databasePath = join(root, ".abcm", "abcm.sqlite");
  now = Date.parse("2026-08-12T00:00:00.000Z");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function revision(id: string): MapRevision {
  return {
    revision: id,
    digest: id,
    createdAt: new Date(now).toISOString(),
    nodes: [
      {
        scopeId: "workflow",
        kind: "workflow",
        name: "Workflow",
        aliases: [],
        relativePath: "",
        rank: 0,
        status: "valid",
        readiness: "ready",
      },
    ],
    relations: [],
    diagnostics: [],
  };
}

describe("SqliteScopeMapStore", () => {
  test("creates a versioned rollback-journal database and reopens idempotently", () => {
    const first = new SqliteScopeMapStore(databasePath, { ownerId: "owner-a", clock: () => now });
    expect(first.schemaVersion()).toBe(2);
    expect(first.journalMode().toLowerCase()).toBe("delete");
    first.close();

    const second = new SqliteScopeMapStore(databasePath, { ownerId: "owner-b", clock: () => now });
    expect(second.schemaVersion()).toBe(2);
    second.close();

    const database = new Database(databasePath, { readonly: true });
    const tables = database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map(row => row.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_metadata",
        "runtime_owners",
        "scan_leases",
        "scan_sessions",
        "map_revisions",
        "active_map_revisions",
      ]),
    );
    database.close();
  });

  test("upgrades schema v1 to v2 transactionally", () => {
    const initial = new SqliteScopeMapStore(databasePath);
    const lease = initial.beginScan("workspace");
    initial.publish(lease, revision("sha256:before-upgrade"));
    initial.close();
    const legacy = new Database(databasePath);
    legacy.run("DROP TABLE runtime_owners");
    legacy.run("UPDATE schema_metadata SET value = '1' WHERE key = 'schema_version'");
    legacy.close();

    const upgraded = new SqliteScopeMapStore(databasePath);
    expect(upgraded.schemaVersion()).toBe(2);
    expect(upgraded.getActive("workspace")).toEqual(revision("sha256:before-upgrade"));
    upgraded.close();
    const check = new Database(databasePath, { readonly: true });
    expect(check.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'runtime_owners'").get()?.name).toBe(
      "runtime_owners",
    );
    check.close();
  });

  test("renews one exclusive runtime owner and recovers with greater fencing after release", () => {
    const first = new SqliteScopeMapStore(databasePath, {
      ownerId: "runtime-a",
      runtimeOwnerTtlMs: 1_000,
      clock: () => now,
    });
    const acquired = first.runtimeOwner();
    expect(acquired).toEqual(expect.objectContaining({ ownerId: "runtime-a", fencingToken: 1 }));
    if (acquired === undefined) throw new Error("Runtime owner was not acquired.");
    expect(
      () =>
        new SqliteScopeMapStore(databasePath, {
          ownerId: "runtime-b",
          runtimeOwnerTtlMs: 1_000,
          clock: () => now,
        }),
    ).toThrow(expect.objectContaining({ code: "DERIVED_STORE_OWNER_BUSY" }));

    now += 400;
    const renewed = first.renewRuntimeOwner();
    expect(renewed.fencingToken).toBe(acquired.fencingToken);
    expect(renewed.expiresAt).toBeGreaterThan(acquired.expiresAt);
    first.releaseRuntimeOwner();

    const second = new SqliteScopeMapStore(databasePath, {
      ownerId: "runtime-b",
      runtimeOwnerTtlMs: 1_000,
      clock: () => now,
    });
    expect(second.runtimeOwner()?.fencingToken).toBeGreaterThan(renewed.fencingToken);
    second.close();
    first.close();
  });

  test("fences an expired runtime owner after takeover", () => {
    const stale = new SqliteScopeMapStore(databasePath, {
      ownerId: "runtime-a",
      runtimeOwnerTtlMs: 1_000,
      clock: () => now,
    });
    const staleToken = stale.runtimeOwner()?.fencingToken ?? 0;
    now += 1_001;
    const current = new SqliteScopeMapStore(databasePath, {
      ownerId: "runtime-b",
      runtimeOwnerTtlMs: 1_000,
      clock: () => now,
    });
    expect(current.runtimeOwner()?.fencingToken).toBeGreaterThan(staleToken);
    expect(() => stale.beginScan("workspace")).toThrow(expect.objectContaining({ code: "DERIVED_STORE_OWNER_LOST" }));
    expect(() => stale.getActive("workspace")).toThrow(expect.objectContaining({ code: "DERIVED_STORE_OWNER_LOST" }));
    stale.close();
    expect(current.renewRuntimeOwner().ownerId).toBe("runtime-b");
    current.close();
  });

  test("rejects an unsupported schema version instead of mutating it", () => {
    const first = new SqliteScopeMapStore(databasePath);
    first.close();
    const database = new Database(databasePath);
    database.run("UPDATE schema_metadata SET value = '999' WHERE key = 'schema_version'");
    database.close();

    expect(() => new SqliteScopeMapStore(databasePath)).toThrow(
      expect.objectContaining({ code: "DERIVED_STORE_CORRUPT" }),
    );
    const check = new Database(databasePath, { readonly: true });
    expect(check.query<{ value: string }, []>("SELECT value FROM schema_metadata WHERE key = 'schema_version'").get()?.value).toBe(
      "999",
    );
    check.close();
  });

  test("rejects a busy lease and stale fencing without changing the active revision", () => {
    const first = new SqliteScopeMapStore(databasePath, {
      ownerId: "owner-a",
      leaseTtlMs: 1_000,
      clock: () => now,
    });
    const second = new SqliteScopeMapStore(databasePath, {
      ownerId: "owner-b",
      leaseTtlMs: 1_000,
      clock: () => now,
    });

    const stale = first.beginScan("workspace");
    expect(() => second.beginScan("workspace")).toThrow(expect.objectContaining({ code: "SCAN_LEASE_BUSY" }));

    now += 1_001;
    const current = second.beginScan("workspace");
    expect(current.fencingToken).toBeGreaterThan(stale.fencingToken);
    second.publish(current, revision("sha256:current"));

    expect(() => first.publish(stale, revision("sha256:stale"))).toThrow(
      expect.objectContaining({ code: "SCAN_FENCING_STALE" }),
    );
    expect(first.getActive("workspace")).toEqual(revision("sha256:current"));
    first.close();
    second.close();
  });

  test("rolls back a staged revision when active-pointer publication fails", () => {
    const store = new SqliteScopeMapStore(databasePath, { ownerId: "owner", clock: () => now });
    const firstLease = store.beginScan("workspace");
    store.publish(firstLease, revision("sha256:first"));

    const faultConnection = new Database(databasePath);
    faultConnection.run(`CREATE TRIGGER reject_active_update
      BEFORE UPDATE ON active_map_revisions
      BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END`);
    faultConnection.close();

    const replacementLease = store.beginScan("workspace");
    expect(() => store.publish(replacementLease, revision("sha256:replacement"))).toThrow("injected publication failure");
    expect(store.getActive("workspace")).toEqual(revision("sha256:first"));

    const check = new Database(databasePath, { readonly: true });
    expect(check.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM map_revisions").get()?.count).toBe(1);
    check.close();
    store.fail(replacementLease);
    store.close();
  });
});
