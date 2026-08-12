import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { SqliteScopeMapStore } from "../src/derived-store/sqlite-scope-map-store.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "abcm-periodic-reconcile-"));
  roots.push(root);
  await mkdir(join(root, "domain-language"));
  await mkdir(join(root, "artifacts"));
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  return root;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for periodic ScopeMap reconciliation.");
    await Bun.sleep(10);
  }
}

describe("periodic ScopeMap runtime reconciliation", () => {
  test("repairs an unannounced canonical filesystem change", async () => {
    const root = await fixture();
    const runtime = createAbcmRuntime(
      { id: "test", root },
      { scopeMapReconcile: { debounceMs: 5, fullReconcileIntervalMs: 20 } },
    );
    try {
      await runtime.scopeMap.scan("test");
      const before = runtime.scopeMap.getProjection("test").resourceSummary.indexedFiles;
      await writeFile(join(root, "artifacts", "missed.md"), "missed event\n");
      await waitFor(() => runtime.scopeMap.getProjection("test").resourceSummary.indexedFiles === before + 1);
    } finally {
      await runtime.close();
    }
  });

  test("serializes concurrent direct scans before acquiring the SQLite lease", async () => {
    const root = await fixture();
    const registry = new WorkspaceRegistry([{ id: "test", root }]);
    const store = new SqliteScopeMapStore(join(root, ".abcm", "abcm.sqlite"), {
      ownerId: "serialized-scans",
      leaseTtlMs: 1_000,
    });
    const service = new ScopeMapService(registry, store);
    try {
      const revisions = await Promise.all([service.scan("test"), service.scan("test"), service.scan("test")]);
      expect(new Set(revisions.map(revision => revision.digest)).size).toBe(1);
    } finally {
      store.close();
    }
  });
});
