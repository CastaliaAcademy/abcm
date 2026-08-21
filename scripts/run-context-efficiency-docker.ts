import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const compose = ["docker", "compose", "-p", "abcm-context-efficiency-benchmark", "-f", "deploy/compose.context-efficiency-benchmark.yaml"];
async function run(command: string[], options: { stdout?: "inherit" | "pipe"; env?: Record<string, string | undefined> } = {}) {
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    stdout: options.stdout ?? "inherit",
    stderr: "inherit",
    env: { ...process.env, ...options.env },
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  return child;
}

try {
  await run([...compose, "up", "-d", "--build"]);
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      const response = await fetch("http://127.0.0.1:8791/health");
      if (response.ok) break;
    } catch {}
    if (Date.now() >= deadline) throw new Error("Docker benchmark service did not become healthy within 60 seconds.");
    await Bun.sleep(250);
  }
  await run(["bun", "run", "benchmarks/context-efficiency.ts"], {
    env: {
      ABCM_BENCH_BASE_URL: "http://127.0.0.1:8791",
      ABCM_BENCH_TOKEN: "benchmark-token-123456789",
      ABCM_BENCH_ENFORCE: process.env.ABCM_BENCH_ENFORCE,
      ABCM_BENCH_OUTPUT_PATH: process.env.ABCM_BENCH_OUTPUT_PATH,
      ABCM_BENCH_TRIGGER: process.env.ABCM_BENCH_TRIGGER,
      ABCM_BENCH_SOURCE_SHA: process.env.ABCM_BENCH_SOURCE_SHA,
    },
  });
} finally {
  await run([...compose, "down", "--remove-orphans"]);
  await rm(resolve("benchmarks/fixtures/context-efficiency-v1/workspace/.abcm"), { recursive: true, force: true });
}
