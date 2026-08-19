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
});
