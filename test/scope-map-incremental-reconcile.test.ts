import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexScopeContent } from "../src/scope-map/content-indexer.js";
import type { ScanLeaseHandle, ScopeMapStore } from "../src/derived-store/types.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import type { MapRevision, ScopeMapChanged } from "../src/scope-map/types.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function scope(root: string, path: string, kind: string, id: string): Promise<void> {
  await mkdir(join(root, path, "domain-language"), { recursive: true });
  await writeFile(join(root, path, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  await writeFile(join(root, path, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
}

async function fixture(): Promise<{
  root: string;
  service: ScopeMapService;
  indexedScopeIds: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "abcm-incremental-"));
  roots.push(root);
  await scope(root, "", "workflow", "workflow");
  await scope(root, "project", "project", "project");
  await scope(root, "project/changed", "service", "changed");
  await scope(root, "project/reverse", "service", "reverse");
  await scope(root, "project/unrelated", "service", "unrelated");
  await mkdir(join(root, "project/changed/artifacts/adr"), { recursive: true });
  await writeFile(
    join(root, "project/changed/artifacts/adr/ADR-TARGET.md"),
    "---\nid: ADR-TARGET\nkind: adr\ntitle: Target\n---\nv1\n",
  );
  await mkdir(join(root, "project/reverse/artifacts/adr"), { recursive: true });
  await writeFile(
    join(root, "project/reverse/artifacts/adr/ADR-REVERSE.md"),
    "---\nid: ADR-REVERSE\nkind: adr\ntitle: Reverse\nlinks: [abcm://artifact/ADR-TARGET, abcm://artifact/ADR-NEW]\n---\nreverse\n",
  );
  await writeFile(join(root, "project/unrelated/README.md"), "unrelated\n");

  const indexedScopeIds: string[] = [];
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const service = new ScopeMapService(registry, undefined, undefined, {
    contentIndexer: async (workspace, node) => {
      indexedScopeIds.push(node.scopeId);
      return indexScopeContent(workspace, node);
    },
  });
  return { root, service, indexedScopeIds };
}

describe("incremental ScopeMap reconcile", () => {
  test("reindexes changed and reverse-reference scopes while reusing unrelated content", async () => {
    const { root, service, indexedScopeIds } = await fixture();
    const initial = await service.scan("test");
    const unrelatedBefore = initial.files.find(file => file.relativePath === "project/unrelated/README.md")!;
    indexedScopeIds.length = 0;
    await writeFile(
      join(root, "project/changed/artifacts/adr/ADR-TARGET.md"),
      "---\nid: ADR-TARGET\nkind: adr\ntitle: Target\n---\nv2\n",
    );

    const reconciled = await service.reconcile("test", ["project/changed/artifacts/adr/ADR-TARGET.md"]);

    expect(indexedScopeIds.sort()).toEqual(["changed", "reverse"]);
    expect(reconciled.files.find(file => file.relativePath === "project/unrelated/README.md")).toEqual(unrelatedBefore);
    expect(reconciled.files).toHaveLength(initial.files.length);
    expect(reconciled.digest).not.toBe(initial.digest);
  });

  test("falls back to a full scan for topology changes and before an active revision exists", async () => {
    const { root, service, indexedScopeIds } = await fixture();
    await service.reconcile("test", ["project/changed/README.md"]);
    expect(new Set(indexedScopeIds)).toEqual(new Set(["workflow", "project", "changed", "reverse", "unrelated"]));

    indexedScopeIds.length = 0;
    await writeFile(join(root, "project/changed/scope.yaml"), "apiVersion: abcm/v1\nkind: service\nid: changed\nname: Changed name\n");
    await service.reconcile("test", ["project/changed/scope.yaml"]);
    expect(new Set(indexedScopeIds)).toEqual(new Set(["workflow", "project", "changed", "reverse", "unrelated"]));

    indexedScopeIds.length = 0;
    await service.reconcile("test", ["../outside"]);
    expect(new Set(indexedScopeIds)).toEqual(new Set(["workflow", "project", "changed", "reverse", "unrelated"]));
  });

  test("expands unresolved reverse links and domain-language readiness dependants", async () => {
    const { root, service, indexedScopeIds } = await fixture();
    await service.scan("test");
    indexedScopeIds.length = 0;
    await writeFile(
      join(root, "project/changed/artifacts/adr/ADR-NEW.md"),
      "---\nid: ADR-NEW\nkind: adr\ntitle: New target\n---\nnew\n",
    );
    const resolved = await service.reconcile("test", ["project/changed/artifacts/adr/ADR-NEW.md"]);
    expect(indexedScopeIds.sort()).toEqual(["changed", "reverse"]);
    expect(resolved.relations).toContainEqual(expect.objectContaining({ fromId: "reverse", toId: "ADR-NEW", status: "resolved" }));

    indexedScopeIds.length = 0;
    await writeFile(join(root, "project/README.md"), "project change\n");
    await service.reconcile("test", ["project/README.md"]);
    expect(new Set(indexedScopeIds)).toEqual(new Set(["project", "changed", "reverse", "unrelated"]));

    indexedScopeIds.length = 0;
    await unlink(join(root, "domain-language/DomainLanguageConvention.md"));
    const readiness = await service.reconcile("test", ["domain-language/DomainLanguageConvention.md"]);
    expect(new Set(indexedScopeIds)).toEqual(new Set(["workflow", "project", "changed", "reverse", "unrelated"]));
    expect(readiness.nodes.find(node => node.scopeId === "workflow")?.readiness).toBe("warning");
  });

  test("emits one isolated post-publication event for a changed digest", async () => {
    const { root, service } = await fixture();
    await service.scan("test");
    const events: ScopeMapChanged[] = [];
    service.subscribe(() => {
      throw new Error("listener failure");
    });
    service.subscribe(async () => Promise.reject(new Error("async listener failure")));
    const unsubscribe = service.subscribe(event => {
      events.push(event);
    });
    await writeFile(join(root, "project/unrelated/README.md"), "changed\n");
    const changed = await service.reconcile("test", ["project/unrelated/README.md"]);
    await service.reconcile("test", ["project/unrelated/README.md"]);
    unsubscribe();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      workspaceId: "test",
      revision: changed.revision,
      digest: changed.digest,
      changedScopeIds: ["unrelated"],
      diagnosticsSummary: { branchErrors: 0, scopeErrors: 0, warnings: 1 },
    });
  });

  test("does not emit when atomic publication fails", async () => {
    const { root } = await fixture();
    class RejectingStore implements ScopeMapStore {
      readonly scanLeaseRenewalIntervalMs = 10_000;
      failures = 0;
      beginScan(workspaceId: string): ScanLeaseHandle {
        return { workspaceId, scanId: "scan", ownerId: "owner", fencingToken: 1, expiresAt: Date.now() + 60_000 };
      }
      renew(lease: ScanLeaseHandle): ScanLeaseHandle {
        return lease;
      }
      publish(_lease: ScanLeaseHandle, _revision: MapRevision): void {
        throw new Error("injected publication failure");
      }
      fail(_lease: ScanLeaseHandle): void {
        this.failures++;
      }
      getActive(_workspaceId: string): MapRevision | undefined {
        return undefined;
      }
      close(): void {}
    }
    const store = new RejectingStore();
    const service = new ScopeMapService(new WorkspaceRegistry([{ id: "test", root }]), store);
    const events: ScopeMapChanged[] = [];
    service.subscribe(event => {
      events.push(event);
    });
    await expect(service.scan("test")).rejects.toThrow("injected publication failure");
    expect(store.failures).toBe(1);
    expect(events).toEqual([]);
  });
});
