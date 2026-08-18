import { describe, expect, test } from "bun:test";

import { parseSafeYaml } from "../src/core/safe-yaml.js";
import {
  contextEfficiencyManifestSchema,
  retrievalRunReceiptSchema,
} from "../src/evaluation/context-efficiency-contracts.js";
import { evaluateContextEfficiency } from "../src/evaluation/context-efficiency-evaluator.js";

const manifestPath = "test/fixtures/context-efficiency/evaluation-manifest-v1.yaml";
const sha = (value: string) => `sha256:${value.padEnd(64, "0")}`;

function receipt(input: {
  variant: "direct" | "abcmAutomatic" | "abcmGuided";
  selected: string[];
  tokens: number;
  success?: boolean;
  repeatedDigests?: string[];
  unauthorizedDisclosureCount?: number;
  fallback?: { availableModes: string[]; usedMode?: string; recoveredDocumentIds?: string[]; addedTokens?: number };
}) {
  return retrievalRunReceiptSchema.parse({
    schemaVersion: "abcm.eval.retrieval-run/v1",
    scenarioId: "synthetic-relevance",
    variant: input.variant,
    runId: `${input.variant}-run`,
    inputIdentity: {
      workspaceSnapshotDigest: sha("1"),
      principalAccessDigest: sha("2"),
      requestDigest: sha("3"),
      policyDigest: sha("4"),
    },
    selectedDocuments: input.selected.map((documentId, index) => ({
      documentId,
      tokenEstimate: Math.floor(input.tokens / input.selected.length) + (index === 0 ? input.tokens % input.selected.length : 0),
    })),
    totalInputTokens: input.tokens,
    taskSucceeded: input.success ?? true,
    totalCost: input.tokens / 1_000_000,
    repeatedResultDigests: input.repeatedDigests ?? Array.from({ length: 10 }, () => sha("a")),
    unauthorizedDisclosureCount: input.unauthorizedDisclosureCount ?? 0,
    fallback: input.fallback ?? { availableModes: ["direct-search", "explicit-documents", "bounded-resource-read"] },
  });
}

async function manifest() {
  return contextEfficiencyManifestSchema.parse(parseSafeYaml(await Bun.file(manifestPath).text()));
}

describe("сравнение ABCM с прямым чтением и поиском", () => {
  test("принимает меньший релевантный пакет только после паритета качества, fallback, determinism и isolation", async () => {
    const report = evaluateContextEfficiency(await manifest(), [
      receipt({ variant: "direct", selected: ["gold-a", "gold-b", "gold-c", "gold-d", "noise"], tokens: 12_000 }),
      receipt({ variant: "abcmAutomatic", selected: ["gold-a", "gold-b", "gold-c", "gold-d"], tokens: 7_000 }),
    ]);

    expect(report.variants.abcmAutomatic.gates).toEqual({
      taskRelevance: "pass",
      fallbackFlexibility: "pass",
      determinism: "pass",
      workspaceIsolation: "pass",
      contextEfficiency: "pass",
    });
    expect(report.variants.abcmAutomatic.metrics).toEqual(expect.objectContaining({
      mandatoryRecall: 1,
      precision: 1,
      deterministicResultRate: 1,
      unauthorizedDisclosureCount: 0,
      tokenReductionVsDirect: expect.closeTo(5 / 12, 8),
    }));
    expect(report.variants.abcmAutomatic.overall).toBe("pass");
  });

  test("не засчитывает сокращение токенов, если ABCM уступает прямому поиску по обязательному контексту", async () => {
    const report = evaluateContextEfficiency(await manifest(), [
      receipt({ variant: "direct", selected: ["gold-a", "gold-b", "gold-c", "gold-d"], tokens: 12_000 }),
      receipt({ variant: "abcmAutomatic", selected: ["gold-a", "gold-b", "gold-c"], tokens: 2_000 }),
    ]);
    const result = report.variants.abcmAutomatic;

    expect(result.gates.taskRelevance).toBe("fail");
    expect(result.gates.contextEfficiency).toBe("not_evaluable");
    expect(result.metrics.tokenReductionVsDirect).toBeUndefined();
    expect(result.overall).toBe("fail");
  });

  test("показывает восстановление через fallback, не скрывая отказ автоматического resolver", async () => {
    const report = evaluateContextEfficiency(await manifest(), [
      receipt({ variant: "direct", selected: ["gold-a", "gold-b", "gold-c", "gold-d"], tokens: 12_000 }),
      receipt({
        variant: "abcmGuided",
        selected: ["gold-a", "gold-b", "gold-c"],
        tokens: 5_000,
        fallback: {
          availableModes: ["direct-search", "explicit-documents", "bounded-resource-read"],
          usedMode: "bounded-resource-read",
          recoveredDocumentIds: ["gold-d"],
          addedTokens: 1_000,
        },
      }),
    ]);
    const result = report.variants.abcmGuided;

    expect(result.primary.taskRelevance).toBe("fail");
    expect(result.effective.taskRelevance).toBe("pass");
    expect(result.fallback).toEqual(expect.objectContaining({ usedMode: "bounded-resource-read", recoveredCount: 1 }));
    expect(result.metrics.effectiveInputTokens).toBe(6_000);
  });

  test("блокирует вариант при недетерминизме или раскрытии чужого workspace независимо от качества и размера", async () => {
    const baseline = receipt({ variant: "direct", selected: ["gold-a", "gold-b", "gold-c", "gold-d"], tokens: 12_000 });
    const unstable = evaluateContextEfficiency(await manifest(), [
      baseline,
      receipt({ variant: "abcmAutomatic", selected: ["gold-a", "gold-b", "gold-c", "gold-d"], tokens: 7_000, repeatedDigests: [sha("a"), sha("b")] }),
    ]).variants.abcmAutomatic;
    const leaking = evaluateContextEfficiency(await manifest(), [
      baseline,
      receipt({ variant: "abcmAutomatic", selected: ["gold-a", "gold-b", "gold-c", "gold-d"], tokens: 7_000, unauthorizedDisclosureCount: 1 }),
    ]).variants.abcmAutomatic;

    expect(unstable.gates.determinism).toBe("fail");
    expect(unstable.overall).toBe("fail");
    expect(leaking.gates.workspaceIsolation).toBe("fail");
    expect(leaking.overall).toBe("fail");
    expect(JSON.stringify(leaking)).not.toContain("hidden-a");
  });

  test("не вычисляет cost per successful task при отсутствии успешных задач", async () => {
    const report = evaluateContextEfficiency(await manifest(), [
      receipt({ variant: "direct", selected: ["gold-a", "gold-b", "gold-c", "gold-d"], tokens: 12_000 }),
      receipt({ variant: "abcmAutomatic", selected: ["gold-a", "gold-b", "gold-c", "gold-d"], tokens: 7_000, success: false }),
    ]).variants.abcmAutomatic;

    expect(report.metrics.costPerSuccessfulTask).toBeUndefined();
    expect(report.gates.contextEfficiency).toBe("not_evaluable");
  });
});
