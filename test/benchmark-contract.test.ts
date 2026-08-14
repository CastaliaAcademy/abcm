import { describe, expect, test } from "bun:test";

import { runLargeFixtureBenchmark } from "../benchmarks/large-fixture.js";

describe("large fixture benchmark contract", () => {
  test("reports isolated non-negative phase timings and deterministic fixture counts", async () => {
    const result = await runLargeFixtureBenchmark({ services: 2, featuresPerService: 2, iterations: 2 });
    expect(result.fixture).toEqual({ scopes: 8, documents: 4, bytes: expect.any(Number) });
    expect(result.fixture.bytes).toBeGreaterThan(0);
    expect(Object.keys(result.phasesMs).sort()).toEqual([
      "fixtureWrite", "projection", "rawHash", "resolver", "scopeMapScan", "sqlitePublish", "yamlParse",
    ]);
    expect(Object.values(result.phasesMs).every(value => Number.isFinite(value) && value >= 0)).toBe(true);
  });
});
