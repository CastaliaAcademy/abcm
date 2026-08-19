import { describe, expect, test } from "bun:test";

import { parseSafeYaml } from "../src/core/safe-yaml.js";
import { businessEvaluationExecutionProfileSchema } from "../src/evaluation/context-business-eval-profile.js";

describe("контракт Docker benchmark эффективности", () => {
  test("использует известный gold set, десять повторов и отдельный недоступный corpus", async () => {
    const manifest = parseSafeYaml(await Bun.file("benchmarks/fixtures/context-efficiency-v1/benchmark-manifest.yaml").text()) as {
      goldDocumentIds: string[];
      mandatoryDocumentIds: string[];
      claims: Array<{ id: string; allTerms: string[] }>;
      forbiddenMarkers: string[];
      repetitions: number;
      allowedPathPrefixes: string[];
    };
    expect(manifest.goldDocumentIds).toEqual(["order-contract", "order-security", "order-retry", "order-api"]);
    expect(manifest.mandatoryDocumentIds).toEqual(manifest.goldDocumentIds);
    expect(manifest.claims).toHaveLength(4);
    expect(manifest.repetitions).toBe(10);
    expect(manifest.allowedPathPrefixes).toEqual(["commerce/orders"]);
    expect(manifest.forbiddenMarkers).toContain("FOREIGN-WORKSPACE-SECRET");
    expect(await Bun.file("benchmarks/fixtures/context-efficiency-v1/foreign/secret.md").text()).toContain("FOREIGN-WORKSPACE-SECRET");
    expect(await Bun.file("deploy/compose.context-efficiency-benchmark.yaml").text()).not.toContain("/foreign");
  });

  test("фиксирует manifest для 16-scenario V0-V5 business receipt и приоритетные gates", async () => {
    const manifest = parseSafeYaml(await Bun.file("benchmarks/fixtures/context-efficiency-v1/business-qualification.yaml").text()) as {
      schemaVersion: string;
      repetitions: number;
      scenarioIds: string[];
      gatePolicy: Record<string, unknown> & { requiredFallbackModes: string[] };
      sourceBaseline: { sourceCommit: string; sourceChecksum: string };
    };
    expect(manifest.schemaVersion).toBe("abcm.benchmark.context-business/v1");
    expect(manifest.scenarioIds).toHaveLength(16);
    expect(new Set(manifest.scenarioIds).size).toBe(16);
    expect(manifest.repetitions).toBe(2);
    expect(manifest.gatePolicy).toEqual(expect.objectContaining({
      mandatoryRecallMin: 1,
      deterministicBundleRateMin: 1,
      unauthorizedLeakageMax: 0,
      tokenReductionMin: 0.25,
      costPerSuccessfulTaskReductionMin: 0.2,
      requiredFallbackModes: ["direct-search", "explicit-documents", "bounded-resource-read"],
    }));
    expect(manifest.sourceBaseline.sourceCommit).toHaveLength(40);
    expect(manifest.sourceBaseline.sourceChecksum).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("поднимает production-like runner только с server-owned профилем", async () => {
    const profile = businessEvaluationExecutionProfileSchema.parse(parseSafeYaml(
      await Bun.file("benchmarks/fixtures/context-efficiency-v1/server-owned-profile.yaml").text(),
    ));
    expect(profile.dataset.scenarios).toHaveLength(16);
    expect(profile.scenarios).toHaveLength(16);
    expect(profile.scenarios.every(scenario => scenario.directSearch.allowedPathPrefixes.every(path => !path.startsWith("/") && !path.includes("..")))).toBe(true);
    const compose = await Bun.file("deploy/compose.context-efficiency-benchmark.yaml").text();
    expect(compose).toContain("ABCM_BUSINESS_EVALUATION_PROFILES: /config/server-owned-profile.yaml");
    expect(compose).toContain("ABCM_DERIVED_STORE_ENABLED: \"true\"");
  });
});
