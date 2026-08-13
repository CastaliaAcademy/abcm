import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteScopeMapStore } from "../src/derived-store/sqlite-scope-map-store.js";
import type { ScanLeaseHandle, ScopeMapStore } from "../src/derived-store/types.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import type { MapRevision } from "../src/scope-map/types.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

class ObservedStore implements ScopeMapStore {
  readonly scanLeaseRenewalIntervalMs = 1;
  renewals = 0;
  publications = 0;
  failRenewal = false;

  constructor(readonly delegate: SqliteScopeMapStore) {}

  beginScan(workspaceId: string): ScanLeaseHandle {
    return this.delegate.beginScan(workspaceId);
  }

  renew(lease: ScanLeaseHandle): ScanLeaseHandle {
    this.renewals++;
    if (this.failRenewal) throw new Error("injected renewal failure");
    return this.delegate.renew(lease);
  }

  publish(lease: ScanLeaseHandle, revision: MapRevision): void {
    this.publications++;
    this.delegate.publish(lease, revision);
  }

  fail(lease: ScanLeaseHandle): void {
    this.delegate.fail(lease);
  }

  getActive(workspaceId: string): MapRevision | undefined {
    return this.delegate.getActive(workspaceId);
  }

  close(): void {
    this.delegate.close();
  }
}

async function fixture(): Promise<{ root: string; registry: WorkspaceRegistry }> {
  const root = await mkdtemp(join(tmpdir(), "abcm-scan-renewal-"));
  roots.push(root);
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  for (let index = 0; index < 40; index++) {
    const id = `project-${index.toString().padStart(2, "0")}`;
    await mkdir(join(root, id, "domain-language"), { recursive: true });
    await writeFile(join(root, id, "scope.yaml"), `apiVersion: abcm/v1\nkind: project\nid: ${id}\nname: ${id}\n`);
    await writeFile(join(root, id, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  }
  return { root, registry: new WorkspaceRegistry([{ id: "test", root }]) };
}

describe("ScopeMap scan lease heartbeat", () => {
  test("renews while filesystem scanning yields and stops after publication", async () => {
    const { root, registry } = await fixture();
    const store = new ObservedStore(
      new SqliteScopeMapStore(join(root, ".abcm", "abcm.sqlite"), {
        leaseTtlMs: 1_000,
        scanLeaseRenewalIntervalMs: 1,
      }),
    );
    const service = new ScopeMapService(registry, store);
    const revision = await service.scan("test");
    expect(revision.nodes).toHaveLength(41);
    expect(store.renewals).toBeGreaterThan(0);
    expect(store.publications).toBe(1);
    const renewalsAfterPublish = store.renewals;
    await Bun.sleep(15);
    expect(store.renewals).toBe(renewalsAfterPublish);
    store.close();
  }, 15_000);

  test("blocks publication when heartbeat renewal fails", async () => {
    const { root, registry } = await fixture();
    const delegate = new SqliteScopeMapStore(join(root, ".abcm", "abcm.sqlite"), {
      leaseTtlMs: 1_000,
      scanLeaseRenewalIntervalMs: 1,
    });
    const initialService = new ScopeMapService(registry, delegate);
    const initial = await initialService.scan("test");

    const store = new ObservedStore(delegate);
    store.failRenewal = true;
    const service = new ScopeMapService(registry, store);
    await expect(service.scan("test")).rejects.toThrow("injected renewal failure");
    expect(store.renewals).toBeGreaterThan(0);
    expect(store.publications).toBe(0);
    expect(store.getActive("test")?.digest).toBe(initial.digest);
    store.close();
  }, 15_000);
});
