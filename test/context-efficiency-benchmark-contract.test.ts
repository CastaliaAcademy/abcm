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
});
