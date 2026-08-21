import { describe, expect, test } from "bun:test";

import { parseSafeYaml } from "../src/core/safe-yaml.js";

describe("feature completion benchmark workflow", () => {
  test("runs once after every merged pull request to main and supports an operator retry", async () => {
    const workflow = parseSafeYaml(
      await Bun.file(".github/workflows/feature-completion-benchmark.yml").text(),
    ) as {
      on: {
        pull_request: { branches: string[]; types: string[] };
        workflow_dispatch: unknown;
      };
      permissions: { contents: string };
      jobs: Record<string, {
        if: string;
        "timeout-minutes": number;
        steps: Array<Record<string, unknown>>;
      }>;
    };

    expect(workflow.on.pull_request).toEqual({ branches: ["main"], types: ["closed"] });
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({ contents: "read" });
    const job = workflow.jobs["direct-search-vs-abcm"]!;
    expect(job.if).toContain("pull_request.merged == true");
    expect(job["timeout-minutes"]).toBe(20);
  });

  test("enforces priority gates and retains a machine-readable receipt even when they fail", async () => {
    const source = await Bun.file(".github/workflows/feature-completion-benchmark.yml").text();
    expect(source).toContain("ABCM_BENCH_ENFORCE: \"true\"");
    expect(source).toContain("bun run benchmark:context-efficiency:docker");
    expect(source).toContain("ABCM_BENCH_OUTPUT_PATH: .abcm-generated/benchmarks/context-efficiency.json");
    expect(source).toContain("if: always()");
    expect(source).toContain("actions/upload-artifact@v4");
    expect(source).toContain("retention-days: 30");
  });

  test("benchmark receipt records the feature identity without changing gate semantics", async () => {
    const benchmark = await Bun.file("benchmarks/context-efficiency.ts").text();
    const runner = await Bun.file("scripts/run-context-efficiency-docker.ts").text();
    expect(benchmark).toContain('schemaVersion: "abcm.benchmark.feature-completion/v1"');
    expect(benchmark).toContain("ABCM_BENCH_SOURCE_SHA");
    expect(benchmark).toContain("ABCM_BENCH_OUTPUT_PATH");
    expect(benchmark).toContain("if (process.env.ABCM_BENCH_ENFORCE === \"true\" && !enforcementPassed)");
    expect(runner).toContain("ABCM_BENCH_OUTPUT_PATH: process.env.ABCM_BENCH_OUTPUT_PATH");
    expect(runner).toContain('"down", "--remove-orphans"');
  });
});
