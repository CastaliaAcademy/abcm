import { describe, expect, test } from "bun:test";

import { parseScopeMapReconcileEnvironment } from "../src/scope-map/reconcile-config.js";
import { ScopeMapReconcileCoordinator } from "../src/scope-map/reconcile-coordinator.js";
import type { MapRevision } from "../src/scope-map/types.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

function revision(id: number): MapRevision {
  return {
    revision: `sha256:${id}`,
    digest: `sha256:${id}`,
    createdAt: new Date(id).toISOString(),
    nodes: [],
    relations: [],
    files: [],
    documents: [],
    executableResources: [],
    skills: [],
    linkGraph: {
      apiVersion: "abcm/link-graph/v1",
      policyVersion: "v1",
      digest: "sha256:empty-link-graph",
      nodes: [],
      edges: [],
    },
    diagnostics: [],
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for reconcile condition.");
    await Bun.sleep(5);
  }
}

class ObservedScanner {
  calls: string[] = [];
  changedPaths: string[][] = [];
  active = 0;
  maxActive = 0;
  failuresRemaining = 0;
  delayMs = 0;

  async scan(workspaceId: string): Promise<MapRevision> {
    this.calls.push(workspaceId);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs > 0) await Bun.sleep(this.delayMs);
      if (this.failuresRemaining > 0) {
        this.failuresRemaining--;
        throw new Error("injected periodic failure");
      }
      return revision(this.calls.length);
    } finally {
      this.active--;
    }
  }

  async reconcile(workspaceId: string, changedPaths: readonly string[]): Promise<MapRevision> {
    this.changedPaths.push([...changedPaths]);
    return this.scan(workspaceId);
  }
}

describe("ScopeMapReconcileCoordinator", () => {
  test("coalesces mutation requests inside one debounce window", async () => {
    const registry = new WorkspaceRegistry([{ id: "test", root: "/tmp/test" }]);
    const scanner = new ObservedScanner();
    const coordinator = new ScopeMapReconcileCoordinator(registry, scanner, {
      debounceMs: 20,
      fullReconcileIntervalMs: 60_000,
    });
    try {
      const results = await Promise.all([
        coordinator.requestMutation("test", ["b.md"]),
        coordinator.requestMutation("test", ["a.md", "b.md"]),
        coordinator.requestMutation("test", ["c.md"]),
      ]);
      expect(scanner.calls).toEqual(["test"]);
      expect(scanner.changedPaths).toEqual([["a.md", "b.md", "c.md"]]);
      expect(results.map(result => result.digest)).toEqual(["sha256:1", "sha256:1", "sha256:1"]);
    } finally {
      await coordinator.close();
    }
  });

  test("queues a later mutation behind in-flight work instead of reusing the older result", async () => {
    const registry = new WorkspaceRegistry([{ id: "test", root: "/tmp/test" }]);
    const scanner = new ObservedScanner();
    scanner.delayMs = 30;
    const coordinator = new ScopeMapReconcileCoordinator(registry, scanner, {
      debounceMs: 0,
      fullReconcileIntervalMs: 60_000,
    });
    try {
      const first = coordinator.requestMutation("test", ["first.md"]);
      await waitFor(() => scanner.active === 1);
      const second = coordinator.requestMutation("test", ["second.md"]);
      expect((await first).digest).toBe("sha256:1");
      expect((await second).digest).toBe("sha256:2");
      expect(scanner.changedPaths).toEqual([["first.md"], ["second.md"]]);
      expect(scanner.maxActive).toBe(1);
    } finally {
      await coordinator.close();
    }
  });

  test("keeps explicit reconcileNow as a full-scan safety path when a mutation is pending", async () => {
    const registry = new WorkspaceRegistry([{ id: "test", root: "/tmp/test" }]);
    const scanner = new ObservedScanner();
    const coordinator = new ScopeMapReconcileCoordinator(registry, scanner, {
      debounceMs: 10_000,
      fullReconcileIntervalMs: 60_000,
    });
    try {
      const pending = coordinator.requestMutation("test", ["changed.md"]);
      const full = coordinator.reconcileNow("test");
      expect((await full).digest).toBe("sha256:1");
      expect((await pending).digest).toBe("sha256:1");
      expect(scanner.changedPaths).toEqual([]);
      expect(scanner.calls).toEqual(["test"]);
    } finally {
      await coordinator.close();
    }
  });

  test("periodically scans current registry entries and recovers after a reported failure", async () => {
    const registry = new WorkspaceRegistry([{ id: "first", root: "/tmp/first" }]);
    const scanner = new ObservedScanner();
    scanner.failuresRemaining = 1;
    scanner.delayMs = 25;
    const failures: Array<{ workspaceId: string; message: string }> = [];
    const coordinator = new ScopeMapReconcileCoordinator(registry, scanner, {
      debounceMs: 1,
      fullReconcileIntervalMs: 15,
      onBackgroundError: (error, workspaceId) => failures.push({ workspaceId, message: error.message }),
    });
    try {
      await waitFor(() => failures.length === 1 && scanner.calls.length >= 2);
      registry.register({ id: "second", root: "/tmp/second" });
      await waitFor(() => scanner.calls.includes("second"));
      expect(failures).toEqual([{ workspaceId: "first", message: "injected periodic failure" }]);
      expect(scanner.calls.filter(workspaceId => workspaceId === "first").length).toBeGreaterThanOrEqual(2);
    } finally {
      await coordinator.close();
    }
  });

  test("flushes pending work and prevents post-close scans", async () => {
    const registry = new WorkspaceRegistry([{ id: "test", root: "/tmp/test" }]);
    const scanner = new ObservedScanner();
    const coordinator = new ScopeMapReconcileCoordinator(registry, scanner, {
      debounceMs: 10_000,
      fullReconcileIntervalMs: 10_000,
    });
    const pending = coordinator.requestMutation("test");
    await coordinator.close();
    expect((await pending).digest).toBe("sha256:1");
    await Bun.sleep(30);
    expect(scanner.calls).toEqual(["test"]);
    await expect(coordinator.requestMutation("test")).rejects.toThrow("closed");
  });

  test("validates and parses reconcile timing configuration", () => {
    expect(
      parseScopeMapReconcileEnvironment({
        ABCM_SCOPE_MAP_RECONCILE_DEBOUNCE_MS: "0",
        ABCM_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS: "120000",
      }),
    ).toEqual({ debounceMs: 0, fullReconcileIntervalMs: 120_000 });
    expect(() => parseScopeMapReconcileEnvironment({ ABCM_SCOPE_MAP_RECONCILE_DEBOUNCE_MS: "-1" })).toThrow(
      "non-negative safe integer",
    );
    expect(() => parseScopeMapReconcileEnvironment({ ABCM_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS: "0" })).toThrow(
      "positive safe integer",
    );
  });
});
