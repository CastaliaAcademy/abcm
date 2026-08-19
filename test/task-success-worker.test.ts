import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BusinessVariantObservation } from "../src/evaluation/context-business-eval-runner.js";
import { TaskSuccessWorkerCoordinator, taskSuccessSubmitRequestSchema } from "../src/evaluation/task-success-worker.js";

const sha = (value: string) => `sha256:${value.padEnd(64, "0")}` as const;

describe("external task-success worker", () => {
  test("выдаёт слепое задание без имени варианта и принимает только body-free результат", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "abcm-task-success-state-"));
    let finalized: ReadonlyMap<string, unknown> | undefined;
    const prepared = {
      profile: {
        id: "task-v1", workspaceId: "test", phase: "task-success", dataset: { id: "dataset" },
        taskSuccess: { workerPoolId: "openai-dev", modelIdentityDigest: sha("1"), judgeRubricDigest: sha("2"), judgeIdentityClass: "blind-programmatic" },
      },
      input: { inputIdentity: { requestSetDigest: sha("3") }, blindSeedDigest: sha("4") },
      jobs: [{
        scenarioId: "BIZ-001", variant: "V3", repeatIndex: 0, blindLabel: "blind-1234567890abcdef", prompt: "Решить задачу",
        contextDocuments: [{ documentId: "policy", content: "Правило" }],
        retrievalObservation: {
          resultDigest: sha("5"), selectorTraceDigest: sha("6"), selectedDocuments: [{ documentId: "policy", tokenEstimate: 2 }], retrievedClaimIds: [], totalInputTokens: 2,
          taskSucceeded: true, totalCostMicrounits: 2, unauthorizedDisclosureCount: 0, errorCode: null,
          cache: { state: "miss", policyVersion: "context-build-cache/v1" }, latencyMs: { total: 1 },
          fallback: { availableModes: ["direct-search"] },
          rawMetrics: { mandatoryRecall: 1, precision: 1, relevantTokenRatio: 1, firstAttemptSucceeded: true, explicitLinkResolutionRate: 1, stableErrorClassificationRate: 1, omissionCount: 0, outputTokens: 0, toolTokens: 0 },
        },
      }],
    } as any;
    const backend = {
      prepareTaskSuccess: async () => prepared,
      finalizeTaskSuccess: async (_profileId: string, observations: ReadonlyMap<string, BusinessVariantObservation>) => {
        finalized = observations;
        return { runId: "business-run-1234567890abcdef12345678", aggregateDigest: sha("7") } as any;
      },
    };
    const options = { clock: () => Date.parse("2026-08-19T00:00:00.000Z"), stateRoot };
    const coordinator = new TaskSuccessWorkerCoordinator(backend, options);
    const session = await coordinator.start({ profileId: "task-v1" });
    const claimed = await coordinator.claim({ workerPoolId: "openai-dev", workerId: "worker-1", leaseSeconds: 60 });
    expect(claimed.job).not.toBeNull();
    expect(JSON.stringify(claimed.job)).not.toContain("V3");
    expect(JSON.stringify(claimed.job)).not.toContain("gold");
    expect(claimed.job?.contextDocuments[0]?.content).toBe("Правило");
    expect(() => taskSuccessSubmitRequestSchema.parse({
      jobId: claimed.job!.jobId, leaseToken: claimed.job!.leaseToken, resultDigest: sha("8"), taskSucceeded: true, firstAttemptSucceeded: true,
      totalCostMicrounits: 10, outputTokens: 3, toolTokens: 1, verifiedClaimIds: ["claim"], errorCode: null, judgeVerdictDigest: sha("9"), modelOutput: "secret",
    })).toThrow("Unrecognized key");
    const completed = await coordinator.submit({
      jobId: claimed.job!.jobId, leaseToken: claimed.job!.leaseToken, resultDigest: sha("8"), taskSucceeded: true, firstAttemptSucceeded: true,
      totalCostMicrounits: 10, outputTokens: 3, toolTokens: 1, verifiedClaimIds: ["claim"], errorCode: null, judgeVerdictDigest: sha("9"),
    });
    expect(completed).toEqual(expect.objectContaining({ sessionId: session.sessionId, status: "completed", completedCount: 1 }));
    expect(finalized?.size).toBe(1);
    expect(JSON.stringify(completed)).not.toContain("Правило");
    const restored = await new TaskSuccessWorkerCoordinator(backend, options).start({ profileId: "task-v1" });
    expect(restored).toEqual(expect.objectContaining({ status: "completed", completedCount: 1, receiptRunId: "business-run-1234567890abcdef12345678" }));
    expect(await Bun.file(join(stateRoot, `${session.sessionId}.json`)).text()).not.toContain("Правило");
    await rm(stateRoot, { recursive: true, force: true });
  });
});
