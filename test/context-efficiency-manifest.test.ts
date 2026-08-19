import { describe, expect, test } from "bun:test";

import { parseSafeYaml } from "../src/core/safe-yaml.js";
import { contextEfficiencyManifestSchema } from "../src/evaluation/context-efficiency-contracts.js";

const fixture = "test/fixtures/context-efficiency/evaluation-manifest-v1.yaml";

describe("контракт manifest оценки эффективности контекста", () => {
  test("фиксирует пользовательский порядок gate и отделяет качество от экономии", async () => {
    const parsed = contextEfficiencyManifestSchema.parse(parseSafeYaml(await Bun.file(fixture).text()));

    expect(parsed.priorityOrder).toEqual([
      "task_relevance",
      "fallback_flexibility",
      "determinism",
      "workspace_isolation",
      "context_efficiency",
    ]);
    expect(parsed.gates.taskRelevance).toEqual(expect.objectContaining({
      mandatoryRecallVsDirect: "gte",
      precisionVsDirect: "gte",
    }));
    expect(parsed.gates.contextEfficiency.evaluateOnlySuccessfulTasks).toBe(true);
  });

  test("отклоняет перестановку приоритетов, небезопасные границы и дубли сценариев", async () => {
    const source = parseSafeYaml(await Bun.file(fixture).text()) as Record<string, unknown>;
    const priorities = source.priorityOrder as string[];
    expect(contextEfficiencyManifestSchema.safeParse({ ...source, priorityOrder: [priorities[4], ...priorities.slice(0, 4)] }).success).toBe(false);
    expect(contextEfficiencyManifestSchema.safeParse({
      ...source,
      gates: { ...(source.gates as object), workspaceIsolation: { unauthorizedDisclosureMax: 1 } },
    }).success).toBe(false);
    const scenarios = source.scenarios as unknown[];
    expect(contextEfficiencyManifestSchema.safeParse({ ...source, scenarios: [scenarios[0], scenarios[0]] }).success).toBe(false);
  });
});
