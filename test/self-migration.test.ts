import { expect, test } from "bun:test";
import { access, readFile } from "node:fs/promises";

test("keeps canonical documentation outside the source checkout", async () => {
  for (const path of ["agents", "artifacts", "config", "docs", "domain-language", "examples", "CHANGELOG.md", "scope.yaml"]) {
    await expect(access(path)).rejects.toThrow();
  }

  const readme = await readFile("README.md", "utf8");
  expect(readme).toContain("castalia-public");
  expect(readme).toContain("bun run documentation:export");

  const lock = JSON.parse(await readFile("abcm-documentation.lock.json", "utf8")) as Record<string, unknown>;
  expect(lock).toEqual(expect.objectContaining({
    schemaVersion: 1,
    workspaceId: "castalia-public",
    projectPath: "abcm",
    layoutPath: "config/documentation-layout.json",
    fileCount: expect.any(Number),
    aggregateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    scopeMapDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
  }));
});
