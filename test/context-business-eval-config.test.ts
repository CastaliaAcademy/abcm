import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadBusinessEvaluationProfiles } from "../src/evaluation/context-business-eval-config.js";

describe("business evaluation profile configuration", () => {
  test("не включает capability без env и загружает только строгий серверный YAML", async () => {
    expect(await loadBusinessEvaluationProfiles(undefined)).toBeUndefined();
    const root = await mkdtemp(join(tmpdir(), "abcm-eval-profile-config-"));
    try {
      const path = join(root, "profiles.yaml");
      await writeFile(path, `profiles:\n  - schemaVersion: abcm.eval.execution-profile/v1\n    id: invalid-profile\n    version: 1.0.0\n    status: approved\n    workspaceId: test\n    phase: retrieval\n    unexpectedClientExecutor: /tmp/run.sh\n`);
      await expect(loadBusinessEvaluationProfiles(path)).rejects.toThrow("Unrecognized key");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
