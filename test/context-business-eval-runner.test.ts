import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ContextBusinessEvalRunner,
  InMemoryBusinessEvaluationCatalog,
  businessEvaluationReceiptSchema,
  businessFixtureCatalogSchema,
  businessScenarioDatasetSchema,
  contextBusinessVariants,
} from "../src/evaluation/context-business-eval-runner.js";
import { SqliteScopeMapStore } from "../src/derived-store/sqlite-scope-map-store.js";
import { createAbcmRestHandler } from "../src/rest/create-rest-handler.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const sha = (value: string) => `sha256:${value.padEnd(64, "0")}` as const;
const scenarios = Array.from({ length: 16 }, (_, index) => ({
  id: `BIZ-CTX-${String(index + 1).padStart(3, "0")}`,
  title: `Сценарий ${index + 1}`,
  fixture: `fixture-${index + 1}`,
  when: `Условие ${index + 1}`,
  then: [`Результат ${index + 1}`],
  gates: ["mandatoryRecall=1.0"],
}));
const dataset = businessScenarioDatasetSchema.parse({
  schemaVersion: "abcm.eval.business.v1",
  id: "business-16",
  title: "16 business scenarios",
  status: "approved",
  language: "ru",
  ownerScope: "abcm",
  sourceBaseline: { path: "external/baseline.md", sourceCommit: "a".repeat(40), sourceChecksum: sha("1") },
  metrics: { mandatoryRecall: "recall" },
  proposedGates: { correctness: { mandatoryRecall: 1 } },
  scenarios,
});
const fixtures = businessFixtureCatalogSchema.parse({
  schemaVersion: "abcm.eval.fixtures.v1",
  id: "fixtures-16",
  title: "Fixtures",
  status: "approved",
  language: "ru",
  ownerScope: "abcm",
  reproducibility: { pin: ["snapshot"], rawEvidence: ["receipt"] },
  real: [],
  synthetic: scenarios.map((scenario, index) => ({ id: scenario.fixture, scopes: index + 1, files: 10, documents: 2, skills: 0 })),
  adversarial: [],
});

function input(policyDigest = sha("4")) {
  return {
    workspaceId: "test-workspace",
    phase: "retrieval" as const,
    repetitions: 2,
    blindSeedDigest: sha("9"),
    inputIdentity: {
      workspaceSnapshotDigest: sha("1"),
      principalAccessDigest: sha("2"),
      requestSetDigest: sha("3"),
      policyDigest,
      selectionPolicyVersion: "context-selection/v3",
      cachePolicyDigest: sha("7"),
      cachePolicyVersion: "context-build-cache/v1",
      projectionPolicyVersion: "document-projection/v1",
      budgetProfileDigest: sha("8"),
      baselineIdentityDigest: sha("5"),
      modelIdentityDigest: null,
      judgeRubricDigest: null,
      judgeIdentityClass: null,
    },
  };
}

describe("manifest-driven V0-V5 business evaluation runner", () => {
  test("не смешивает 16 сценариев, варианты и repeats и сохраняет body-free immutable receipt", async () => {
    const calls: string[] = [];
    const catalog = new InMemoryBusinessEvaluationCatalog();
    const runner = new ContextBusinessEvalRunner(catalog, async request => {
      calls.push(`${request.scenario.id}:${request.variant}:${request.repeatIndex}`);
      const index = contextBusinessVariants.indexOf(request.variant);
      return {
        resultDigest: sha(String(index + 1)),
        selectorTraceDigest: sha("a"),
        selectedDocuments: [{ documentId: `gold-${request.scenario.id}`, tokenEstimate: 100 + index }],
        retrievedClaimIds: [`claim-${request.scenario.id}`],
        totalInputTokens: 100 + index,
        taskSucceeded: true,
        totalCostMicrounits: 100 + index,
        unauthorizedDisclosureCount: 0,
        errorCode: null,
        cache: request.variant === "V3"
          ? { state: "miss", policyVersion: "context-build-cache/v1" }
          : request.variant === "V4"
            ? { state: "hit", policyVersion: "context-build-cache/v1" }
            : { state: "bypass", policyVersion: "variant-no-cache/v1" },
        latencyMs: { total: 10 + index },
        fallback: { availableModes: ["direct-search", "explicit-documents", "bounded-resource-read"] },
      };
    });

    const receipt = await runner.run(dataset, fixtures, input());
    expect(contextBusinessVariants).toEqual(["V0", "V1", "V2", "V3", "V4", "V5"]);
    expect(calls).toHaveLength(16 * 6 * 2);
    expect(receipt.runs).toHaveLength(16 * 6 * 2);
    expect(new Set(receipt.runs.map(run => `${run.scenarioId}:${run.variant}:${run.repeatIndex}`)).size).toBe(receipt.runs.length);
    expect(receipt.runs.filter(run => run.variant === "V3").every(run => run.cache.state === "miss")).toBe(true);
    expect(receipt.runs.filter(run => run.variant === "V4").every(run => run.cache.state === "hit")).toBe(true);
    for (const scenario of scenarios) {
      for (let repeatIndex = 0; repeatIndex < 2; repeatIndex++) {
        const cold = calls.indexOf(`${scenario.id}:V3:${repeatIndex}`);
        expect(calls[cold + 1]).toBe(`${scenario.id}:V4:${repeatIndex}`);
      }
    }
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(businessEvaluationReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain("documentBody");

    const repeated = await runner.run(dataset, fixtures, input());
    expect(repeated).toEqual(receipt);
    expect(catalog.listBusinessEvaluations("test-workspace", dataset.id)).toEqual([receipt]);

    const changed = await runner.run(dataset, fixtures, input(sha("6")));
    expect(changed.runId).not.toBe(receipt.runId);
    expect(catalog.listBusinessEvaluations("test-workspace", dataset.id)).toHaveLength(2);
  });

  test("отклоняет неизвестный fixture и observation с произвольным body", async () => {
    const missingFixtureDataset = businessScenarioDatasetSchema.parse({ ...dataset, scenarios: [{ ...dataset.scenarios[0], fixture: "missing" }] });
    const runner = new ContextBusinessEvalRunner(new InMemoryBusinessEvaluationCatalog(), async () => ({
      resultDigest: sha("1"), selectorTraceDigest: sha("a"), selectedDocuments: [], retrievedClaimIds: [], totalInputTokens: 0, taskSucceeded: false,
      totalCostMicrounits: 0, unauthorizedDisclosureCount: 0, errorCode: null,
      cache: { state: "bypass", policyVersion: "none/v1" }, latencyMs: { total: 1 }, fallback: { availableModes: [] },
    }));
    await expect(runner.run(missingFixtureDataset, fixtures, input())).rejects.toThrow("unknown fixture");

    const leaking = new ContextBusinessEvalRunner(new InMemoryBusinessEvaluationCatalog(), async () => ({
      resultDigest: sha("1"), selectorTraceDigest: sha("a"), selectedDocuments: [], retrievedClaimIds: [], totalInputTokens: 0, taskSucceeded: false,
      totalCostMicrounits: 0, unauthorizedDisclosureCount: 0, errorCode: null, documentBody: "SHOULD_NOT_PERSIST",
      cache: { state: "bypass", policyVersion: "none/v1" }, latencyMs: { total: 1 }, fallback: { availableModes: [] },
    }));
    await expect(leaking.run(dataset, fixtures, { ...input(), repetitions: 1 })).rejects.toThrow("Unrecognized key");
  });

  test("требует pinned judge для task-success и не публикует частичный receipt после отмены", async () => {
    const missingJudge = { ...input(), phase: "task-success" as const, repetitions: 1 };
    const unused = new ContextBusinessEvalRunner(new InMemoryBusinessEvaluationCatalog(), async () => ({}));
    await expect(unused.run(dataset, fixtures, missingJudge)).rejects.toThrow("pinned model and blind judge");

    const catalog = new InMemoryBusinessEvaluationCatalog();
    const controller = new AbortController();
    const runner = new ContextBusinessEvalRunner(catalog, async () => {
      controller.abort(new Error("cancelled"));
      return {
        resultDigest: sha("1"), selectorTraceDigest: sha("a"), selectedDocuments: [], retrievedClaimIds: [], totalInputTokens: 0,
        taskSucceeded: false, totalCostMicrounits: 0, unauthorizedDisclosureCount: 0, errorCode: "CANCELLED",
        cache: { state: "bypass", policyVersion: "none/v1" }, latencyMs: { total: 1 }, fallback: { availableModes: [] },
      };
    });
    await expect(runner.run(dataset, fixtures, { ...input(), repetitions: 1 }, controller.signal)).rejects.toThrow("cancelled");
    expect(catalog.listBusinessEvaluations("test-workspace", dataset.id)).toEqual([]);
  });

  test("сохраняет receipt в SQLite и не запускает variants повторно после рестарта", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-business-eval-"));
    const databasePath = join(root, ".abcm", "abcm.sqlite");
    let calls = 0;
    const execute = async (request: { variant: string }) => {
      calls += 1;
      return {
        resultDigest: sha("1"), selectorTraceDigest: sha("a"), selectedDocuments: [], retrievedClaimIds: [], totalInputTokens: 0, taskSucceeded: false,
        totalCostMicrounits: 0, unauthorizedDisclosureCount: 0, errorCode: "NO_RESULT",
        cache: request.variant === "V3"
          ? { state: "miss" as const, policyVersion: "context-build-cache/v1" }
          : request.variant === "V4"
            ? { state: "hit" as const, policyVersion: "context-build-cache/v1" }
            : { state: "bypass" as const, policyVersion: "none/v1" },
        latencyMs: { total: 1 }, fallback: { availableModes: [] },
      };
    };
    try {
      const firstStore = new SqliteScopeMapStore(databasePath);
      const first = await new ContextBusinessEvalRunner(firstStore, execute).run(dataset, fixtures, { ...input(), repetitions: 1 });
      expect(calls).toBe(16 * 6);
      firstStore.close();

      const reopened = new SqliteScopeMapStore(databasePath);
      const repeated = await new ContextBusinessEvalRunner(reopened, execute).run(dataset, fixtures, { ...input(), repetitions: 1 });
      expect(repeated).toEqual(first);
      expect(calls).toBe(16 * 6);
      expect(reopened.listBusinessEvaluations("test-workspace", dataset.id)).toEqual([first]);
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("публикует единый REST run/list контракт без тел документов", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-business-eval-rest-"));
    try {
      const registry = new WorkspaceRegistry([{ id: "test-workspace", root }]);
      const runner = new ContextBusinessEvalRunner(new InMemoryBusinessEvaluationCatalog(), async request => ({
        resultDigest: sha("1"), selectorTraceDigest: sha("a"), selectedDocuments: [], retrievedClaimIds: [], totalInputTokens: 0, taskSucceeded: false,
        totalCostMicrounits: 0, unauthorizedDisclosureCount: 0, errorCode: "NO_RESULT",
        cache: request.variant === "V3"
          ? { state: "miss", policyVersion: "context-build-cache/v1" }
          : request.variant === "V4"
            ? { state: "hit", policyVersion: "context-build-cache/v1" }
            : { state: "bypass", policyVersion: "none/v1" },
        latencyMs: { total: 1 }, fallback: { availableModes: [] },
      }));
      const handler = createAbcmRestHandler({
        files: new WorkspaceFileService(registry),
        scopeMap: new ScopeMapService(registry),
        contextBusinessEvaluations: runner,
      });
      const body = { dataset, fixtures, input: { ...input(), repetitions: 1 } };
      const created = await handler(new Request("http://localhost/v1/context/business-evaluations", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      expect(created.status).toBe(201);
      const receipt = await created.json() as { runId: string };
      expect(receipt.runId).toMatch(/^business-run-/);
      const listed = await handler(new Request("http://localhost/v1/context/business-evaluations?workspaceId=test-workspace&datasetId=business-16"));
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ evaluations: [expect.objectContaining({ runId: receipt.runId })] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
