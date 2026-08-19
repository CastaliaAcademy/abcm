import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";

import { parseSafeYaml } from "../src/core/safe-yaml.js";

const evidenceSchema = z.object({
  file: z.string().regex(/^test\/[a-z0-9-]+\.test\.ts$/),
  testCase: z.string().min(1),
}).strict();

const coverageSchema = z.object({
  schemaVersion: z.literal("abcm.benchmark.adversarial-coverage/v1"),
  datasetId: z.literal("context-retrieval-business-scenarios-v1"),
  fixtureCatalogId: z.literal("context-retrieval-business-fixtures-v1"),
  scope: z.literal("local-synthetic-and-adversarial"),
  excludedExternalScenarioIds: z.array(z.string()).min(1),
  cases: z.array(z.object({
    scenarioId: z.string().regex(/^BIZ-CTX-\d{3}$/),
    fixtureId: z.string().min(1),
    evidence: z.array(evidenceSchema).min(1),
  }).strict()).min(1),
}).strict();

const expectedCases = new Map([
  ["BIZ-CTX-003", "oversized-required-document"],
  ["BIZ-CTX-004", "multi-explicit-links"],
  ["BIZ-CTX-005", "repository-path-exact"],
  ["BIZ-CTX-006", "canonical-language-variants"],
  ["BIZ-CTX-007", "template-and-index-noise"],
  ["BIZ-CTX-009", "synthetic-medium"],
  ["BIZ-CTX-010", "stale-bootstrap"],
  ["BIZ-CTX-011", "cross-scope-access"],
  ["BIZ-CTX-012", "budget-contention"],
  ["BIZ-CTX-015", "failure-taxonomy"],
  ["BIZ-CTX-016", "omission-explainability"],
]);

describe("трассировка synthetic/adversarial business regression", () => {
  test("каждый локально исполнимый BIZ-сценарий связан с существующим именованным тестом", async () => {
    const raw = await Bun.file("benchmarks/fixtures/context-efficiency-v1/adversarial-coverage.yaml").text();
    const coverage = coverageSchema.parse(parseSafeYaml(raw));
    expect(coverage.excludedExternalScenarioIds).toEqual([
      "BIZ-CTX-001", "BIZ-CTX-002", "BIZ-CTX-008", "BIZ-CTX-013", "BIZ-CTX-014",
    ]);
    expect(new Map(coverage.cases.map(item => [item.scenarioId, item.fixtureId]))).toEqual(expectedCases);
    expect(new Set(coverage.cases.map(item => item.scenarioId)).size).toBe(coverage.cases.length);

    for (const item of coverage.cases) {
      for (const evidence of item.evidence) {
        const source = await readFile(evidence.file, "utf8");
        expect(source, `${item.scenarioId}: ${evidence.file}`).toContain(`test("${evidence.testCase}"`);
      }
    }
  });

  test("manifest не содержит document bodies, абсолютные пути или закрытые workspace identifiers", async () => {
    const raw = await Bun.file("benchmarks/fixtures/context-efficiency-v1/adversarial-coverage.yaml").text();
    expect(raw).not.toMatch(/(?:[A-Za-z]:\\|\/mnt\/|\/home\/|\.\.\/)/);
    expect(raw).not.toContain("castalia-private");
    expect(raw).not.toContain("FOREIGN-WORKSPACE-SECRET");
  });
});
