import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SafeWorkspacePath } from "../src/workspace/safe-path.js";

describe("SafeWorkspacePath", () => {
  test("accepts canonical relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-safe-path-"));
    const safePath = await SafeWorkspacePath.create(root);

    expect((await safePath.resolve("docs/plan.md", { allowMissing: true })).relativePath).toBe("docs/plan.md");
  });

  test.each(["../secret", "/etc/passwd", "C:/secret", "a/../../secret", "a\\..\\secret", "%2e%2e/secret", "a\0b"])(
    "rejects unsafe path %s",
    async candidate => {
      const root = await mkdtemp(join(tmpdir(), "abcm-safe-path-"));
      const safePath = await SafeWorkspacePath.create(root);

      expect(safePath.resolve(candidate, { allowMissing: true })).rejects.toMatchObject({
        code: "FILE_PATH_INVALID",
      });
    },
  );

  test.each([".git/config", ".abcm/abcm.sqlite", "node_modules/pkg/index.js", "dist/index.js", ".env"])(
    "rejects reserved path %s",
    async candidate => {
      const root = await mkdtemp(join(tmpdir(), "abcm-safe-path-"));
      const safePath = await SafeWorkspacePath.create(root);

      expect(safePath.resolve(candidate, { allowMissing: true })).rejects.toMatchObject({
        code: "FILE_PATH_FORBIDDEN",
      });
    },
  );

  test("rejects symlink components", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-safe-path-"));
    const outside = await mkdtemp(join(tmpdir(), "abcm-outside-"));
    await mkdir(join(root, "docs"));
    await symlink(outside, join(root, "docs", "escape"), "dir");
    const safePath = await SafeWorkspacePath.create(root);

    expect(safePath.resolve("docs/escape/secret.md", { allowMissing: true })).rejects.toMatchObject({
      code: "FILE_PATH_FORBIDDEN",
    });
  });
});
