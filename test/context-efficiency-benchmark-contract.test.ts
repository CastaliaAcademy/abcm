import { describe, expect, test } from "bun:test";

import { parseSafeYaml } from "../src/core/safe-yaml.js";

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

  test("поднимает runtime без централизованного evaluation-профиля", async () => {
    const compose = await Bun.file("deploy/compose.context-efficiency-benchmark.yaml").text();
    const benchmark = await Bun.file("benchmarks/context-efficiency.ts").text();
    expect(compose).not.toContain("ABCM_BUSINESS_EVALUATION_PROFILES");
    expect(compose).not.toContain("server-owned-profile.yaml");
    expect(compose).toContain("ABCM_DERIVED_STORE_ENABLED: \"true\"");
    expect(compose).toContain("target: /workspace\n        read_only: true");
    expect(compose).toContain("/workspace/.abcm:size=64m,mode=0700,uid=1000,gid=1000");
    expect(await Bun.file("benchmarks/fixtures/context-efficiency-v1/workspace/.abcm/.gitkeep").exists()).toBe(true);
    expect(benchmark).not.toContain("/v1/context/business-evaluations");
    expect(benchmark).not.toContain("serverOwnedBusinessEvaluation");
  });

  test("принимает traversal denial только как стабильный typed domain result", async () => {
    const benchmark = await Bun.file("benchmarks/context-efficiency.ts").text();
    expect(benchmark).toContain('traversalErrorCode !== "FILE_PATH_INVALID"');
    expect(benchmark).toContain("traversal.isError ||");
    expect(benchmark).toContain("judgeProtocolDigest: null");
    expect(benchmark).not.toContain('if (!traversal.isError) throw new Error("Workspace traversal unexpectedly succeeded.")');
  });
});
