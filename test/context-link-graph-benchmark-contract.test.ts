import { describe, expect, test } from "bun:test";

import { parseSafeYaml } from "../src/core/safe-yaml.js";

describe("контракт сравнительного benchmark link-graph", () => {
  test("фиксирует известный маршрут ссылок, десять повторов и приоритетные gates", async () => {
    const manifest = parseSafeYaml(await Bun.file(
      "benchmarks/fixtures/context-efficiency-v1/link-graph-qualification.yaml",
    ).text()) as {
      schemaVersion: string;
      seedDocumentIds: string[];
      expectedInitialCandidates: string[];
      expectedExpandedCandidates: string[];
      confirmedDocumentIds: string[];
      requiredFallbackModes: string[];
      repetitions: number;
      gates: Record<string, unknown>;
    };

    expect(manifest.schemaVersion).toBe("abcm.benchmark.link-graph-context/v1");
    expect(manifest.seedDocumentIds).toEqual(["order-contract"]);
    expect(manifest.expectedInitialCandidates).toEqual(["order-retry", "order-security"]);
    expect(manifest.expectedExpandedCandidates).toEqual(["order-api", "order-retry", "order-security"]);
    expect(manifest.confirmedDocumentIds).toEqual(["order-api", "order-retry", "order-security"]);
    expect(manifest.requiredFallbackModes).toEqual(["direct-search", "explicit-documents", "bounded-resource-read"]);
    expect(manifest.repetitions).toBe(10);
    expect(Object.keys(manifest.gates)).toEqual([
      "relevance",
      "fallback",
      "determinism",
      "isolation",
      "contextEfficiency",
    ]);
  });

  test("сравнивает direct, automatic и graph-assisted режимы на одном corpus", async () => {
    const benchmark = await Bun.file("benchmarks/context-efficiency.ts").text();
    const contract = await Bun.file(
      "benchmarks/fixtures/context-efficiency-v1/workspace/commerce/orders/artifacts/order-contract.md",
    ).text();
    const retry = await Bun.file(
      "benchmarks/fixtures/context-efficiency-v1/workspace/commerce/orders/artifacts/order-retry.md",
    ).text();

    expect(contract).toContain("[[order-security]]");
    expect(contract).toContain("[[order-retry]]");
    expect(retry).toContain("[[order-api]]");
    expect(benchmark).toContain('name: "context.start_link_graph_session"');
    expect(benchmark).toContain('name: "context.step_link_graph_session"');
    expect(benchmark).toContain('name: "context.finalize_link_graph_session"');
    expect(benchmark).toContain("linkGraphPriorityEvaluation");
    expect(benchmark).toContain("graphUnauthorizedDisclosureCount");
  });
});
