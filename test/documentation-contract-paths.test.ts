import { describe, expect, test } from "bun:test";

import { CANONICAL_PLAN_0033_PATHS, CANONICAL_PLAN_0034_PATHS, CANONICAL_PLAN_0035_PATHS, CANONICAL_PLAN_0036_PATHS, CANONICAL_PLAN_0037_PATHS, CANONICAL_PLAN_0038_PATHS, CANONICAL_PLAN_0039_PATHS, CANONICAL_REMOTE_EVIDENCE_PATHS } from "../scripts/documentation-contract-paths.js";

describe("canonical remote documentation evidence", () => {
  test("business dataset, fixtures, baseline, protocol and recommendations remain in the pinned export", () => {
    expect(CANONICAL_REMOTE_EVIDENCE_PATHS).toEqual([
      "artifacts/evals/README.md",
      "artifacts/evals/capability/castalia-context-efficiency-baseline-2026-08-18.md",
      "artifacts/evals/datasets/context-retrieval-business-scenarios-v1.yaml",
      "artifacts/evals/fixtures/context-retrieval-business-fixtures-v1.yaml",
      "artifacts/evals/regression/context-bundle-business-regression-v1.md",
      "artifacts/reports/architecture/context-resolver-functional-recommendations-2026-08-18.md",
      "docs/operations/audit-requirements.md",
    ]);
    expect(new Set(CANONICAL_REMOTE_EVIDENCE_PATHS).size).toBe(CANONICAL_REMOTE_EVIDENCE_PATHS.length);
  });

  test("PLAN-0034 specification, plan, verification, traceability and evidence stay in the pinned export", () => {
    expect(CANONICAL_PLAN_0034_PATHS).toEqual([
      "docs/spec/extensions/link-packages-artifact-amendments-v0.1.yaml",
      "artifacts/plans/PLAN-0034/plan.md",
      "artifacts/plans/PLAN-0034/verification-plan.md",
      "artifacts/plans/PLAN-0034/traceability.yaml",
      "artifacts/plans/PLAN-0034/evidence/implementation.md",
    ]);
    expect(new Set(CANONICAL_PLAN_0034_PATHS).size).toBe(CANONICAL_PLAN_0034_PATHS.length);
  });

  test("PLAN-0033 specification, plan, verification, traceability and evidence stay in the pinned export", () => {
    expect(CANONICAL_PLAN_0033_PATHS).toEqual([
      "docs/spec/extensions/interactive-link-graph-context-v0.1.yaml",
      "artifacts/plans/PLAN-0033/plan.md",
      "artifacts/plans/PLAN-0033/verification-plan.md",
      "artifacts/plans/PLAN-0033/traceability.yaml",
      "artifacts/plans/PLAN-0033/evidence/implementation.md",
    ]);
    expect(new Set(CANONICAL_PLAN_0033_PATHS).size).toBe(CANONICAL_PLAN_0033_PATHS.length);
  });

  test("PLAN-0035 specification, plan, verification, traceability and evidence stay in the pinned export", () => {
    expect(CANONICAL_PLAN_0035_PATHS).toEqual([
      "docs/spec/extensions/tag-derived-link-packages-and-operator-amendments-v0.1.yaml",
      "artifacts/plans/PLAN-0035/plan.md",
      "artifacts/plans/PLAN-0035/verification-plan.md",
      "artifacts/plans/PLAN-0035/traceability.yaml",
      "artifacts/plans/PLAN-0035/evidence/implementation.md",
    ]);
    expect(new Set(CANONICAL_PLAN_0035_PATHS).size).toBe(CANONICAL_PLAN_0035_PATHS.length);
  });

  test("PLAN-0036 specification, plan, verification, traceability and evidence stay in the pinned export", () => {
    expect(CANONICAL_PLAN_0036_PATHS).toEqual([
      "docs/spec/extensions/tag-derived-link-packages-hardening-v0.2.yaml",
      "artifacts/plans/PLAN-0036/plan.md",
      "artifacts/plans/PLAN-0036/verification-plan.md",
      "artifacts/plans/PLAN-0036/traceability.yaml",
      "artifacts/plans/PLAN-0036/evidence/implementation.md",
    ]);
    expect(new Set(CANONICAL_PLAN_0036_PATHS).size).toBe(CANONICAL_PLAN_0036_PATHS.length);
  });

  test("PLAN-0037 specification, plan, verification, traceability and evidence stay in the pinned export", () => {
    expect(CANONICAL_PLAN_0037_PATHS).toEqual([
      "docs/spec/extensions/connector-safe-errors-and-documentation-reconciliation-v0.1.yaml",
      "artifacts/plans/PLAN-0037/plan.md",
      "artifacts/plans/PLAN-0037/verification-plan.md",
      "artifacts/plans/PLAN-0037/traceability.yaml",
      "artifacts/plans/PLAN-0037/evidence/implementation.md",
    ]);
    expect(new Set(CANONICAL_PLAN_0037_PATHS).size).toBe(CANONICAL_PLAN_0037_PATHS.length);
  });

  test("PLAN-0038 specification, plan, verification, traceability and evidence stay in the pinned export", () => {
    expect(CANONICAL_PLAN_0038_PATHS).toEqual([
      "docs/spec/extensions/migration-report-context-precision-v0.1.yaml",
      "artifacts/plans/PLAN-0038/plan.md",
      "artifacts/plans/PLAN-0038/verification-plan.md",
      "artifacts/plans/PLAN-0038/traceability.yaml",
      "artifacts/plans/PLAN-0038/evidence/implementation.md",
    ]);
    expect(new Set(CANONICAL_PLAN_0038_PATHS).size).toBe(CANONICAL_PLAN_0038_PATHS.length);
  });

  test("PLAN-0039 feature-completion benchmark contract stays in the pinned export", () => {
    expect(CANONICAL_PLAN_0039_PATHS).toEqual([
      "docs/spec/extensions/feature-completion-context-benchmark-v0.1.yaml",
      "artifacts/plans/PLAN-0039/plan.md",
      "artifacts/plans/PLAN-0039/verification-plan.md",
      "artifacts/plans/PLAN-0039/traceability.yaml",
      "artifacts/plans/PLAN-0039/evidence/implementation.md",
    ]);
    expect(new Set(CANONICAL_PLAN_0039_PATHS).size).toBe(CANONICAL_PLAN_0039_PATHS.length);
  });

  test("sync tooling keeps normative plan evidence and threat controls in the canonical layout", async () => {
    const source = await Bun.file("scripts/sync-abcm-contracts.ts").text();
    for (const path of [
      "docs/release/known-gaps-v0.1.0.md",
      "docs/release/traceability-v0.1.0.yaml",
      "docs/integrations/obsidian.md",
      "artifacts/plans/PLAN-0028/plan.md",
      "artifacts/plans/PLAN-0028/traceability.yaml",
      "artifacts/plans/PLAN-0028/features/obsidian-bidirectional-sync.md",
      "artifacts/plans/PLAN-0028/evidence/WU-09-github-draft-pr.md",
      "docs/spec/extensions/context-efficiency-evaluation-v0.1.yaml",
      "artifacts/plans/PLAN-0031/evidence/server-owned-business-eval-2026-08-19.md",
      "docs/spec/extensions/file-architecture-policy-v0.1.yaml",
      "artifacts/plans/PLAN-0032/plan.md",
      "artifacts/plans/PLAN-0032/verification-plan.md",
      "artifacts/plans/PLAN-0032/traceability.yaml",
      "artifacts/plans/PLAN-0032/evidence/implementation.md",
    ]) {
      expect(source).toContain(`[\"${path}\"`);
    }
    expect(source).toContain("CANONICAL_PLAN_0033_PATHS");
    expect(source).toContain("CANONICAL_PLAN_0034_PATHS");
    expect(source).toContain("CANONICAL_PLAN_0035_PATHS");
    expect(source).toContain("CANONICAL_PLAN_0036_PATHS");
    expect(source).toContain("CANONICAL_PLAN_0037_PATHS");
    expect(source).toContain("CANONICAL_PLAN_0038_PATHS");
    expect(source).toContain("CANONICAL_PLAN_0039_PATHS");
    expect(source).toContain('["docs/security/threat-model.md"');
  });
});
