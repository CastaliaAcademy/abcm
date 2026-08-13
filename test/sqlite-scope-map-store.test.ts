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
    files: [],
    documents: [],
    executableResources: [],
    skills: [],
    diagnostics: [],
  };
}

describe("SqliteScopeMapStore", () => {
  test("creates a versioned rollback-journal database and reopens idempotently", () => {
    const first = new SqliteScopeMapStore(databasePath, { ownerId: "owner-a", clock: () => now });
    expect(first.schemaVersion()).toBe(7);
    expect(first.journalMode().toLowerCase()).toBe("delete");
    first.close();

    const second = new SqliteScopeMapStore(databasePath, { ownerId: "owner-b", clock: () => now });
    expect(second.schemaVersion()).toBe(7);
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
        "map_files",
        "map_documents",
        "map_executable_resources",
        "map_nodes",
        "map_relations",
        "map_diagnostics",
        "documentation_sources",
        "document_provenance",
        "sync_runs",
        "tombstones",
        "pending_documentation_syncs",
        "documentation_cutovers",
        "context_bundles",
        "context_fingerprints",
      ]),
    );
    database.close();
  });

  test("upgrades schema v1 to v7 transactionally", () => {
    const initial = new SqliteScopeMapStore(databasePath);
    const lease = initial.beginScan("workspace");
    initial.publish(lease, revision("sha256:before-upgrade"));
    initial.close();
    const legacy = new Database(databasePath);
    legacy.run("DROP TABLE runtime_owners");
    legacy.run("UPDATE schema_metadata SET value = '1' WHERE key = 'schema_version'");
    legacy.close();

    const upgraded = new SqliteScopeMapStore(databasePath);
    expect(upgraded.schemaVersion()).toBe(7);
    expect(upgraded.getActive("workspace")).toEqual(revision("sha256:before-upgrade"));
    upgraded.close();
    const check = new Database(databasePath, { readonly: true });
    expect(check.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'runtime_owners'").get()?.name).toBe(
      "runtime_owners",
    );
    check.close();
  });

  test("upgrades schema v2 to v7 without replacing the active revision", () => {
    const initial = new SqliteScopeMapStore(databasePath);
    const lease = initial.beginScan("workspace");
    initial.publish(lease, revision("sha256:before-v3"));
    initial.close();
    const legacy = new Database(databasePath);
    legacy.run("DROP TABLE map_executable_resources");
    legacy.run("DROP TABLE map_documents");
    legacy.run("DROP TABLE map_files");
    legacy.run("UPDATE schema_metadata SET value = '2' WHERE key = 'schema_version'");
    legacy.close();

    const upgraded = new SqliteScopeMapStore(databasePath);
    expect(upgraded.schemaVersion()).toBe(7);
    expect(upgraded.getActive("workspace")).toEqual(revision("sha256:before-v3"));
    upgraded.close();
  });

  test("upgrades schema v3 to v7 without replacing the active revision", () => {
    const initial = new SqliteScopeMapStore(databasePath);
    const lease = initial.beginScan("workspace");
    initial.publish(lease, revision("sha256:before-v4"));
    initial.close();
    const legacy = new Database(databasePath);
    legacy.run("DROP TABLE tombstones");
    legacy.run("DROP TABLE sync_runs");
    legacy.run("DROP INDEX active_document_target");
    legacy.run("DROP TABLE document_provenance");
    legacy.run("DROP TABLE documentation_sources");
    legacy.run("UPDATE schema_metadata SET value = '3' WHERE key = 'schema_version'");
    legacy.close();

    const upgraded = new SqliteScopeMapStore(databasePath);
    expect(upgraded.schemaVersion()).toBe(7);
    expect(upgraded.getActive("workspace")).toEqual(revision("sha256:before-v4"));
    upgraded.close();
  });

  test("upgrades schema v4 to v7 and normalizes graph metadata without replacing the active revision", () => {
    const initial = new SqliteScopeMapStore(databasePath);
    const mapped = revision("sha256:before-v5");
    mapped.relations = [
      { fromId: "workflow", toId: "child", relationType: "parent-child" } as MapRevision["relations"][number],
      { fromId: "workflow", toId: "missing", relationType: "depends-on", source: "relations:missing", status: "unresolved_required" },
    ];
    mapped.diagnostics = [
      { code: "EXPLICIT_LINK_UNRESOLVED", severity: "warning", path: "config/relations.yaml", message: "missing", scopeId: "workflow" },
    ];
    const lease = initial.beginScan("workspace");
    initial.publish(lease, mapped);
    initial.close();
    const legacy = new Database(databasePath);
    legacy.run("DROP TABLE map_diagnostics");
    legacy.run("DROP TABLE map_relations");
    legacy.run("DROP TABLE map_nodes");
    legacy.run("UPDATE schema_metadata SET value = '4' WHERE key = 'schema_version'");
    legacy.close();

    const upgraded = new SqliteScopeMapStore(databasePath);
    expect(upgraded.schemaVersion()).toBe(7);
    expect(upgraded.getActive("workspace")).toEqual(mapped);
    upgraded.close();
    const normalized = new Database(databasePath, { readonly: true });
    expect(normalized.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM map_nodes").get()?.count).toBe(1);
    expect(normalized.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM map_relations").get()?.count).toBe(2);
    expect(normalized.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM map_diagnostics").get()?.count).toBe(1);
    const relationColumns = normalized
      .query<{ name: string }, []>("SELECT name FROM pragma_table_info('map_relations') ORDER BY name")
      .all()
      .map(row => row.name);
    expect(relationColumns).not.toContain("body");
    expect(
      normalized
        .query<{ source: string; status: string }, []>("SELECT source, status FROM map_relations WHERE relation_type = 'parent-child'")
        .get(),
    ).toEqual({ source: "physical-hierarchy", status: "resolved" });
    normalized.close();
  });

  test("upgrades schema v5 to v7 with durable sync, cutover journals, and context catalog", () => {
    const initial = new SqliteScopeMapStore(databasePath);
    initial.close();
    const legacy = new Database(databasePath);
    legacy.run("DROP TABLE context_fingerprints");
    legacy.run("DROP TABLE context_bundles");
    legacy.run("DROP TABLE documentation_cutovers");
    legacy.run("DROP TABLE pending_documentation_syncs");
    legacy.run("UPDATE schema_metadata SET value = '5' WHERE key = 'schema_version'");
    legacy.close();

    const upgraded = new SqliteScopeMapStore(databasePath);
    expect(upgraded.schemaVersion()).toBe(7);
    upgraded.close();
    const check = new Database(databasePath, { readonly: true });
    expect(check.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'pending_documentation_syncs'").get()?.name).toBe(
      "pending_documentation_syncs",
    );
    expect(check.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'documentation_cutovers'").get()?.name).toBe(
      "documentation_cutovers",
    );
    check.close();
  });

  test("upgrades schema v6 to v7 without replacing the active revision", () => {
    const initial = new SqliteScopeMapStore(databasePath);
    const lease = initial.beginScan("workspace");
    initial.publish(lease, revision("sha256:before-v7"));
    initial.close();
    const legacy = new Database(databasePath);
    legacy.run("DROP TABLE context_fingerprints");
    legacy.run("DROP TABLE context_bundles");
    legacy.run("UPDATE schema_metadata SET value = '6' WHERE key = 'schema_version'");
    legacy.close();

    const upgraded = new SqliteScopeMapStore(databasePath);
    expect(upgraded.schemaVersion()).toBe(7);
    expect(upgraded.getActive("workspace")).toEqual(revision("sha256:before-v7"));
    upgraded.close();
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

  test("renews a live scan lease without changing its fencing token", () => {
    const store = new SqliteScopeMapStore(databasePath, {
      ownerId: "owner",
      leaseTtlMs: 1_000,
      scanLeaseRenewalIntervalMs: 200,
      clock: () => now,
    });
    const acquired = store.beginScan("workspace");
    now += 400;
    const renewed = store.renew(acquired);
    expect(renewed.fencingToken).toBe(acquired.fencingToken);
    expect(renewed.scanId).toBe(acquired.scanId);
    expect(renewed.expiresAt).toBeGreaterThan(acquired.expiresAt);

    now = renewed.expiresAt + 1;
    expect(() => store.renew(renewed)).toThrow(expect.objectContaining({ code: "SCAN_FENCING_STALE" }));
    store.close();
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
    const replacement: MapRevision = {
      ...revision("sha256:replacement"),
      files: [
        {
          scopeId: "workflow",
          relativePath: "README.md",
          size: 4,
          mtime: now,
          checksum: "sha256:file",
          parseStatus: "not_applicable",
          classification: "context_document",
          storageMode: "managed",
        },
      ],
    };
    expect(() => store.publish(replacementLease, replacement)).toThrow("injected publication failure");
    expect(store.getActive("workspace")).toEqual(revision("sha256:first"));

    const check = new Database(databasePath, { readonly: true });
    expect(check.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM map_revisions").get()?.count).toBe(1);
    expect(check.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM map_files").get()?.count).toBe(0);
    check.close();
    store.fail(replacementLease);
    store.close();
  });
});
