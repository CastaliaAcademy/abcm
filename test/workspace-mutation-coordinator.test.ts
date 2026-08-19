import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceMutationCoordinator } from "../src/workspace/mutation-coordinator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("WorkspaceMutationCoordinator", () => {
  test("serializes different workspaces across coordinator instances through SQLite", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-mutation-lock-"));
    roots.push(root);
    const databasePath = join(root, "mutation-lock.sqlite");
    const firstCoordinator = new WorkspaceMutationCoordinator({ databasePath, retryDelayMs: 2 });
    const secondCoordinator = new WorkspaceMutationCoordinator({ databasePath, retryDelayMs: 2 });
    let releaseFirst!: () => void;
    const release = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>(resolve => { markFirstEntered = resolve; });
    let secondEntered = false;

    try {
      const first = firstCoordinator.run("workspace-a", async () => {
        markFirstEntered();
        await release;
        return "first";
      });
      await firstEntered;
      const second = secondCoordinator.run("workspace-b", async () => {
        secondEntered = true;
        return "second";
      });
      await Bun.sleep(30);
      expect(secondEntered).toBe(false);
      releaseFirst();
      expect(await first).toBe("first");
      expect(await second).toBe("second");
      expect(secondEntered).toBe(true);
    } finally {
      firstCoordinator.close();
      secondCoordinator.close();
    }
  });

  test("releases the external lock after a failed mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-mutation-lock-failure-"));
    roots.push(root);
    const databasePath = join(root, "mutation-lock.sqlite");
    const firstCoordinator = new WorkspaceMutationCoordinator({ databasePath, retryDelayMs: 2 });
    const secondCoordinator = new WorkspaceMutationCoordinator({ databasePath, retryDelayMs: 2 });
    try {
      await expect(firstCoordinator.run("workspace-a", async () => {
        throw new Error("expected failure");
      })).rejects.toThrow("expected failure");
      await expect(secondCoordinator.run("workspace-b", async () => "after-failure")).resolves.toBe("after-failure");
    } finally {
      firstCoordinator.close();
      secondCoordinator.close();
    }
  });
});
