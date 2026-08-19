import { describe, expect, test } from "bun:test";

import { CANONICAL_REMOTE_EVIDENCE_PATHS } from "../scripts/documentation-contract-paths.js";

describe("canonical remote documentation evidence", () => {
  test("business dataset, fixtures, baseline, protocol and recommendations remain in the pinned export", () => {
    expect(CANONICAL_REMOTE_EVIDENCE_PATHS).toEqual([
      "artifacts/evals/README.md",
      "artifacts/evals/capability/castalia-context-efficiency-baseline-2026-08-18.md",
      "artifacts/evals/datasets/context-retrieval-business-scenarios-v1.yaml",
      "artifacts/evals/fixtures/context-retrieval-business-fixtures-v1.yaml",
      "artifacts/evals/regression/context-bundle-business-regression-v1.md",
      "artifacts/reports/architecture/context-resolver-functional-recommendations-2026-08-18.md",
    ]);
    expect(new Set(CANONICAL_REMOTE_EVIDENCE_PATHS).size).toBe(CANONICAL_REMOTE_EVIDENCE_PATHS.length);
  });

  test("sync tooling keeps PLAN-0028 and PLAN-0031 normative evidence in the canonical layout", async () => {
    const source = await Bun.file("scripts/sync-abcm-contracts.ts").text();
    for (const path of [
      "docs/release/known-gaps-v0.1.0.md",
      "docs/plans/v0.27/plan.md",
      "docs/plans/v0.27/traceability.yaml",
      "docs/plans/v0.27/features/obsidian-bidirectional-sync.md",
      "artifacts/plans/PLAN-0028/evidence/WU-09-github-draft-pr.md",
      "docs/spec/extensions/context-efficiency-evaluation-v0.1.yaml",
      "artifacts/plans/PLAN-0031/evidence/server-owned-business-eval-2026-08-19.md",
    ]) {
      expect(source).toContain(`[\"${path}\"`);
    }
  });
});
