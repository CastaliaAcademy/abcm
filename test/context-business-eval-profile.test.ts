import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import {
  businessEvaluationExecutionProfileSchema,
  serverOwnedBusinessEvaluationRunRequestSchema,
} from "../src/evaluation/context-business-eval-profile.js";

const sha = (value: string) => `sha256:${value.padEnd(64, "0")}` as const;
const fixtureSource = resolve("benchmarks/fixtures/context-efficiency-v1/workspace");

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "abcm-business-profile-workspace-"));
  await cp(fixtureSource, root, { recursive: true });
  return root;
}

const dataset = {
  schemaVersion: "abcm.eval.business.v1" as const,
  id: "server-profile-dataset",
  title: "Server-owned profile dataset",
  status: "approved",
  language: "ru",
  ownerScope: "abcm",
  sourceBaseline: { path: "baseline.md", sourceCommit: "a".repeat(40), sourceChecksum: sha("1") },
  metrics: { mandatoryRecall: "known gold" },
  proposedGates: { correctness: true },
  scenarios: [{
    id: "BIZ-PROFILE-001",
    title: "Order context",
    fixture: "known-data",
    when: "Order retry task",
    then: ["Mandatory context is selected"],
  }],
};

const fixtures = {
  schemaVersion: "abcm.eval.fixtures.v1" as const,
  id: "server-profile-fixtures",
  title: "Server-owned fixtures",
  status: "approved",
  language: "ru",
  ownerScope: "abcm",
  reproducibility: { pin: ["workspace snapshot"], rawEvidence: ["body-free receipt"] },
  real: [],
  synthetic: [{ id: "known-data", scopes: 3, files: 10, documents: 6, skills: 0 }],
  adversarial: [],
};

const gatePolicy = {
  mandatoryRecallMin: 1,
  precisionMin: 0.5,
  relevantTokenRatioMin: 0.5,
  taskSuccessRateMaxDegradationVsV0: 0.02,
  deterministicBundleRateMin: 1,
  stableErrorClassificationRateMin: 1,
  unauthorizedLeakageMax: 0,
  tokenReductionMin: 0,
  costPerSuccessfulTaskReductionMin: 0,
  requiredFallbackModes: ["direct-search", "explicit-documents", "bounded-resource-read", "explainable-preview"] as const,
};

const profile = {
  schemaVersion: "abcm.eval.execution-profile/v1" as const,
  id: "known-data-retrieval-v1",
  version: "1.0.0",
  status: "approved",
  workspaceId: "benchmark",
  phase: "retrieval" as const,
  dataset,
  fixtures,
  repetitions: 2,
  blindSeedDigest: sha("2"),
  baselineIdentityDigest: sha("3"),
  executionEnvironmentDigest: sha("4"),
  measurementWindowDigest: sha("5"),
  gatePolicy,
  scenarios: [{
    scenarioId: "BIZ-PROFILE-001",
    directSearch: {
      queryTerms: ["order", "idempotency"],
      allowedPathPrefixes: ["commerce"],
    },
    context: {
      projectId: "commerce",
      roleId: "implementation-agent",
      taskType: "implementation",
      goal: "Изменить обработку заказов и сохранить безопасность, повторные попытки и API-контракт.",
      keywords: ["order", "security", "retry", "api"],
      exactScopeIds: ["orders"],
      budgetProfile: "expanded",
    },
    goldDocumentIds: ["order-contract", "order-security", "order-retry", "order-api"],
    mandatoryDocumentIds: ["order-contract", "order-security", "order-retry", "order-api"],
    goldClaims: [
      { id: "claim-idempotency", allTerms: ["idempotency"] },
      { id: "claim-retry", allTerms: ["retry"] },
    ],
    forbiddenMarkers: ["FOREIGN_SECRET_MARKER"],
  }],
};

describe("server-owned business evaluation profiles", () => {
  test("отклоняет пути вне workspace, неизвестные сценарии и клиентские manifests", () => {
    expect(() => businessEvaluationExecutionProfileSchema.parse({
      ...profile,
      scenarios: [{ ...profile.scenarios[0], directSearch: { ...profile.scenarios[0]!.directSearch, allowedPathPrefixes: ["/tmp/private"] } }],
    })).toThrow("safe workspace-relative path");
    expect(() => businessEvaluationExecutionProfileSchema.parse({
      ...profile,
      scenarios: [{ ...profile.scenarios[0], scenarioId: "BIZ-PROFILE-MISSING" }],
    })).toThrow("exactly one execution");
    expect(() => serverOwnedBusinessEvaluationRunRequestSchema.parse({ profileId: profile.id, dataset })).toThrow("Unrecognized key");
  });

  test("исполняет V0-V5 по зарегистрированному профилю и публикует только body-free receipt", async () => {
    const root = await fixtureRoot();
    const runtime = createAbcmRuntime({ id: "benchmark", root }, {
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: {
        principalId: "business-eval-runner",
        access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read", "executable_resource.read"] },
      },
      businessEvaluationProfiles: [profile],
    });
    try {
      await runtime.ready;
      await runtime.scopeMap.scan("benchmark");
      const summaries = runtime.contextBusinessEvaluations?.listProfiles();
      expect(summaries).toEqual([{ id: profile.id, version: profile.version, workspaceId: "benchmark", datasetId: dataset.id, phase: "retrieval", scenarioCount: 1 }]);
      const receipt = await runtime.contextBusinessEvaluations?.run({ profileId: profile.id });
      expect(receipt?.runs).toHaveLength(12);
      expect(receipt?.runs.filter(run => run.variant === "V3").every(run => run.cache.state === "miss")).toBe(true);
      expect(receipt?.runs.filter(run => run.variant === "V4").every(run => run.cache.state === "hit")).toBe(true);
      expect(receipt?.runs.every(run => run.unauthorizedDisclosureCount === 0)).toBe(true);
      expect(receipt?.variantAggregates.filter(aggregate => ["V3", "V4", "V5"].includes(aggregate.variant)).every(aggregate => aggregate.deterministicBundleRate === 1)).toBe(true);
      expect(JSON.stringify(receipt)).not.toContain("FOREIGN_SECRET_MARKER");
      expect(receipt?.inputIdentity.workspaceSnapshotDigest).toBe(runtime.scopeMap.getActiveRevision("benchmark").digest);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("разделяет ключ агента и ключ внешнего task-success worker", async () => {
    const taskStateRoot = await mkdtemp(join(tmpdir(), "abcm-task-worker-state-"));
    const root = await fixtureRoot();
    const taskProfile = {
      ...profile,
      id: "known-data-task-v1",
      phase: "task-success" as const,
      repetitions: 1,
      taskSuccess: {
        workerPoolId: "openai-dev",
        modelIdentityDigest: sha("a"),
        judgeRubricDigest: sha("b"),
        judgeIdentityClass: "blind-programmatic",
      },
    };
    const runtime = createAbcmRuntime({ id: "benchmark", root }, {
      bearerToken: "agent-token-123456789",
      businessEvaluationWorkerToken: "worker-token-123456789",
      businessEvaluationTaskStateRoot: taskStateRoot,
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: {
        principalId: "business-eval-runner",
        access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read", "executable_resource.read"] },
      },
      businessEvaluationProfiles: [taskProfile],
    });
    try {
      await runtime.ready;
      await runtime.scopeMap.scan("benchmark");
      const started = await runtime.httpHandler(new Request("http://localhost/v1/context/task-success-evaluations", {
        method: "POST",
        headers: { authorization: "Bearer agent-token-123456789", "content-type": "application/json" },
        body: JSON.stringify({ profileId: taskProfile.id }),
      }));
      expect(started.status).toBe(202);
      const rejected = await runtime.httpHandler(new Request("http://localhost/v1/context/task-success-worker/jobs/claim", {
        method: "POST",
        headers: { authorization: "Bearer agent-token-123456789", "content-type": "application/json" },
        body: JSON.stringify({ workerPoolId: "openai-dev", workerId: "worker-1", leaseSeconds: 60 }),
      }));
      expect(rejected.status).toBe(401);
      const claimed = await runtime.httpHandler(new Request("http://localhost/v1/context/task-success-worker/jobs/claim", {
        method: "POST",
        headers: { authorization: "Bearer worker-token-123456789", "content-type": "application/json" },
        body: JSON.stringify({ workerPoolId: "openai-dev", workerId: "worker-1", leaseSeconds: 60 }),
      }));
      expect(claimed.status).toBe(200);
      const payload = await claimed.json() as { job: unknown };
      expect(payload.job).not.toBeNull();
      expect(JSON.stringify(payload.job)).not.toContain("V0");
      expect(JSON.stringify(payload.job)).not.toContain("goldDocumentIds");
    } finally {
      await runtime.close();
      await rm(taskStateRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
