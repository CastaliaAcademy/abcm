import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { SqliteWorkspaceMapStore } from "../src/derived-store/sqlite-workspace-map-store.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("ScopeMap SQLite rebuild", () => {
  test("recreates a deleted derived database from canonical filesystem bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-sqlite-rebuild-"));
    roots.push(root);
    await mkdir(join(root, "domain-language"));
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    const registry = new WorkspaceRegistry([{ id: "test", root }]);

    const firstStore = new SqliteWorkspaceMapStore(registry, { ownerId: "first" });
    const firstService = new ScopeMapService(registry, firstStore);
    const first = await firstService.scan("test");
    expect(firstStore.getActive("test")?.digest).toBe(first.digest);
    firstStore.close();

    await rm(join(root, ".abcm", "abcm.sqlite"), { force: true });

    const rebuiltStore = new SqliteWorkspaceMapStore(registry, { ownerId: "rebuilt" });
    const rebuiltService = new ScopeMapService(registry, rebuiltStore);
    const rebuilt = await rebuiltService.scan("test");
    expect(rebuilt.digest).toBe(first.digest);
    expect(rebuilt.nodes).toEqual(first.nodes);
    expect(rebuilt.relations).toEqual(first.relations);
    expect(rebuilt.diagnostics).toEqual(first.diagnostics);
    expect(rebuiltStore.getActive("test")?.digest).toBe(first.digest);
    rebuiltStore.close();

    const database = new Database(join(root, ".abcm", "abcm.sqlite"), { readonly: true });
    const payload = database.query<{ payload_json: string }, []>("SELECT payload_json FROM map_revisions").get()?.payload_json;
    expect(payload).not.toContain("apiVersion: abcm/v1");
    expect(payload).not.toContain("mode: inherit-only");
    database.close();
  });

  test("reference runtime enables SQLite only by explicit option", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-sqlite-runtime-"));
    roots.push(root);
    await mkdir(join(root, "domain-language"));
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");

    const runtime = createAbcmRuntime({ id: "test", root }, { sqliteDerivedStoreEnabled: true });
    const revision = await runtime.scopeMap.scan("test");
    expect(runtime.scopeMap.getProjection("test").digest).toBe(revision.digest);
    expect(await Bun.file(join(root, ".abcm", "abcm.sqlite")).exists()).toBe(true);
    await runtime.close();
  });

  test("reference runtime renews ownership and releases it on close", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-sqlite-heartbeat-"));
    roots.push(root);
    await mkdir(join(root, "domain-language"));
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");

    const first = createAbcmRuntime(
      { id: "test", root },
      {
        sqliteDerivedStoreEnabled: true,
        sqliteDerivedStoreOptions: { ownerId: "first", runtimeOwnerTtlMs: 240, runtimeOwnerRenewalIntervalMs: 40 },
      },
    );
    await first.scopeMap.scan("test");
    await Bun.sleep(360);
    const blocked = createAbcmRuntime(
      { id: "test", root },
      {
        sqliteDerivedStoreEnabled: true,
        sqliteDerivedStoreOptions: { ownerId: "second", runtimeOwnerTtlMs: 240, runtimeOwnerRenewalIntervalMs: 40 },
      },
    );
    await expect(blocked.scopeMap.scan("test")).rejects.toEqual(
      expect.objectContaining({ code: "DERIVED_STORE_OWNER_BUSY" }),
    );
    await blocked.close();

    await first.close();
    const second = createAbcmRuntime(
      { id: "test", root },
      {
        sqliteDerivedStoreEnabled: true,
        sqliteDerivedStoreOptions: { ownerId: "second", runtimeOwnerTtlMs: 240, runtimeOwnerRenewalIntervalMs: 40 },
      },
    );
    await expect(second.scopeMap.scan("test")).resolves.toEqual(expect.objectContaining({ digest: expect.any(String) }));
    await second.close();
  });
});
