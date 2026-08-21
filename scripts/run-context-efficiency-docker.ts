import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const compose = ["docker", "compose", "-p", "abcm-context-efficiency-benchmark", "-f", "deploy/compose.context-efficiency-benchmark.yaml"];
async function run(command: string[], options: { stdout?: "inherit" | "pipe"; env?: Record<string, string | undefined>; allowFailure?: boolean } = {}) {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stdout: options.stdout ?? "inherit",
    stderr: "inherit",
    env: { ...process.env, ...options.env },
  });
  const exitCode = await child.exited;
  if (exitCode !== 0 && options.allowFailure !== true) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  return child;
}

const outputPath = process.env.ABCM_BENCH_OUTPUT_PATH === undefined
  ? undefined
  : resolve(process.env.ABCM_BENCH_OUTPUT_PATH);
let stage = "compose-up";

async function writeInfrastructureReceipt(error: unknown): Promise<void> {
  if (outputPath === undefined || await Bun.file(outputPath).exists()) return;
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify({
    schemaVersion: "abcm.benchmark.feature-completion/v1",
    benchmark: "context-efficiency-docker-v1",
    status: "infrastructure_error",
    execution: {
      trigger: process.env.ABCM_BENCH_TRIGGER ?? "local",
      sourceSha: process.env.ABCM_BENCH_SOURCE_SHA ?? null,
      repository: process.env.GITHUB_REPOSITORY ?? null,
      workflowRunId: process.env.GITHUB_RUN_ID ?? null,
      generatedAt: new Date().toISOString(),
    },
    failure: {
      stage,
      message: error instanceof Error ? error.message : "Unknown benchmark infrastructure failure.",
    },
  }, null, 2)}\n`);
}

try {
  await run([...compose, "up", "-d", "--build", "--wait", "--wait-timeout", "180"]);
  stage = "host-health-probe";
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const response = await fetch("http://127.0.0.1:8791/health");
      if (response.ok) break;
    } catch {}
    if (Date.now() >= deadline) throw new Error("Healthy Docker benchmark service was not reachable through its bound host port within 15 seconds.");
    await Bun.sleep(250);
  }
  stage = "benchmark-execution";
  await run(["bun", "run", "benchmarks/context-efficiency.ts"], {
    env: {
      ABCM_BENCH_BASE_URL: "http://127.0.0.1:8791",
      ABCM_BENCH_TOKEN: "benchmark-token-123456789",
      ABCM_BENCH_ENFORCE: process.env.ABCM_BENCH_ENFORCE,
      ABCM_BENCH_OUTPUT_PATH: outputPath,
      ABCM_BENCH_TRIGGER: process.env.ABCM_BENCH_TRIGGER,
      ABCM_BENCH_SOURCE_SHA: process.env.ABCM_BENCH_SOURCE_SHA,
    },
  });
} catch (error) {
  await writeInfrastructureReceipt(error);
  await run([...compose, "ps"], { allowFailure: true });
  await run([...compose, "logs", "--no-color"], { allowFailure: true });
  throw error;
} finally {
  await run([...compose, "down", "--remove-orphans"], { allowFailure: true });
}
