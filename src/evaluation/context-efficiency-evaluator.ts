import type { ContextEfficiencyManifest, RetrievalRunReceipt } from "./context-efficiency-contracts.js";

type Gate = "pass" | "fail" | "not_evaluable";

export interface ContextEfficiencyVariantResult {
  primary: { taskRelevance: Gate };
  effective: { taskRelevance: Gate };
  fallback: {
    availableModes: string[];
    usedMode?: string;
    recoveredCount: number;
    addedTokens: number;
  };
  gates: {
    taskRelevance: Gate;
    fallbackFlexibility: Gate;
    determinism: Gate;
    workspaceIsolation: Gate;
    contextEfficiency: Gate;
  };
  metrics: {
    mandatoryRecall: number;
    precision: number;
    claimRecall: number;
    deterministicResultRate: number;
    unauthorizedDisclosureCount: number;
    effectiveInputTokens: number;
    taskSuccessRate: number;
    tokenReductionVsDirect?: number;
    costPerSuccessfulTask?: number;
    costPerSuccessfulTaskReductionVsDirect?: number;
  };
  overall: "pass" | "fail";
}

export interface ContextEfficiencyReport {
  manifestId: string;
  variants: Record<string, ContextEfficiencyVariantResult>;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function selectedIds(receipt: RetrievalRunReceipt): string[] {
  return receipt.selectedDocuments.map(document => document.documentId);
}

function relevance(ids: readonly string[], gold: ReadonlySet<string>, mandatory: ReadonlySet<string>) {
  const unique = new Set(ids);
  const relevant = [...unique].filter(id => gold.has(id)).length;
  const required = [...unique].filter(id => mandatory.has(id)).length;
  return {
    mandatoryRecall: ratio(required, mandatory.size),
    precision: ratio(relevant, unique.size),
  };
}

function claimRecall(ids: readonly string[], gold: ReadonlySet<string>): number {
  const retrieved = new Set(ids);
  return ratio([...gold].filter(id => retrieved.has(id)).length, gold.size);
}

function deterministicRate(digests: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const digest of digests) counts.set(digest, (counts.get(digest) ?? 0) + 1);
  return Math.max(...counts.values()) / digests.length;
}

function sameIdentity(left: RetrievalRunReceipt, right: RetrievalRunReceipt): boolean {
  return JSON.stringify(left.inputIdentity) === JSON.stringify(right.inputIdentity);
}

export function evaluateContextEfficiency(
  manifest: ContextEfficiencyManifest,
  receipts: readonly RetrievalRunReceipt[],
): ContextEfficiencyReport {
  const scenarios = new Map(manifest.scenarios.map(scenario => [scenario.id, scenario]));
  const variants: Record<string, ContextEfficiencyVariantResult> = {};
  const directByScenario = new Map(receipts.filter(receipt => receipt.variant === "direct").map(receipt => [receipt.scenarioId, receipt]));

  for (const receipt of receipts) {
    if (receipt.variant === "direct") continue;
    const scenario = scenarios.get(receipt.scenarioId);
    const direct = directByScenario.get(receipt.scenarioId);
    if (scenario === undefined || direct === undefined) throw new Error(`Comparison requires a declared scenario and direct receipt for '${receipt.scenarioId}'.`);
    if (!sameIdentity(receipt, direct)) throw new Error(`Comparison input identity differs for '${receipt.scenarioId}'.`);

    const gold = new Set(scenario.goldDocumentIds);
    const mandatory = new Set(scenario.mandatoryDocumentIds);
    const goldClaims = new Set(scenario.goldClaimIds ?? []);
    const directRelevance = relevance(selectedIds(direct), gold, mandatory);
    const directClaimRecall = claimRecall(direct.retrievedClaimIds, goldClaims);
    const primaryIds = selectedIds(receipt);
    const recovered = receipt.fallback.recoveredDocumentIds ?? [];
    const effectiveIds = [...new Set([...primaryIds, ...recovered])];
    const primaryClaimRecall = claimRecall(receipt.retrievedClaimIds, goldClaims);
    const effectiveClaimRecall = claimRecall([...receipt.retrievedClaimIds, ...(receipt.fallback.recoveredClaimIds ?? [])], goldClaims);
    const primaryRelevance = relevance(primaryIds, gold, mandatory);
    const effectiveRelevance = relevance(effectiveIds, gold, mandatory);
    const allowedDegradation = manifest.gates.taskRelevance.taskSuccessRateMaxDegradation;
    const primaryTaskSuccess = Number(receipt.taskSucceeded) >= Number(direct.taskSucceeded) - allowedDegradation;
    const relevancePasses = (value: typeof effectiveRelevance, claims: number) =>
      value.mandatoryRecall >= directRelevance.mandatoryRecall &&
      value.precision >= directRelevance.precision &&
      claims >= directClaimRecall &&
      primaryTaskSuccess;
    const primaryGate: Gate = relevancePasses(primaryRelevance, primaryClaimRecall) ? "pass" : "fail";
    const effectiveGate: Gate = relevancePasses(effectiveRelevance, effectiveClaimRecall) ? "pass" : "fail";

    const requiredFallback = manifest.gates.fallbackFlexibility.requiredModes;
    const fallbackGate: Gate = requiredFallback.every(mode => receipt.fallback.availableModes.includes(mode)) ? "pass" : "fail";
    const deterministicResultRate = deterministicRate(receipt.repeatedResultDigests);
    const determinismGate: Gate = deterministicResultRate >= manifest.gates.determinism.identicalResultRate ? "pass" : "fail";
    const isolationGate: Gate = receipt.unauthorizedDisclosureCount <= manifest.gates.workspaceIsolation.unauthorizedDisclosureMax ? "pass" : "fail";
    const effectiveInputTokens = receipt.totalInputTokens + (receipt.fallback.addedTokens ?? 0);
    const higherPriorityPassed = effectiveGate === "pass" && fallbackGate === "pass" && determinismGate === "pass" && isolationGate === "pass";
    const successful = receipt.taskSucceeded && direct.taskSucceeded;
    let efficiencyGate: Gate = "not_evaluable";
    let tokenReductionVsDirect: number | undefined;
    let costPerSuccessfulTask: number | undefined;
    let costPerSuccessfulTaskReductionVsDirect: number | undefined;
    if (higherPriorityPassed && successful && direct.totalInputTokens > 0 && direct.totalCost > 0) {
      tokenReductionVsDirect = (direct.totalInputTokens - effectiveInputTokens) / direct.totalInputTokens;
      costPerSuccessfulTask = receipt.totalCost + (receipt.fallback.addedTokens ?? 0) / 1_000_000;
      costPerSuccessfulTaskReductionVsDirect = (direct.totalCost - costPerSuccessfulTask) / direct.totalCost;
      efficiencyGate =
        tokenReductionVsDirect >= manifest.gates.contextEfficiency.medianTokenReductionMin &&
        costPerSuccessfulTaskReductionVsDirect >= manifest.gates.contextEfficiency.costPerSuccessfulTaskReductionMin
          ? "pass"
          : "fail";
    }

    const gates = {
      taskRelevance: effectiveGate,
      fallbackFlexibility: fallbackGate,
      determinism: determinismGate,
      workspaceIsolation: isolationGate,
      contextEfficiency: efficiencyGate,
    };
    variants[receipt.variant] = {
      primary: { taskRelevance: primaryGate },
      effective: { taskRelevance: effectiveGate },
      fallback: {
        availableModes: [...receipt.fallback.availableModes],
        ...(receipt.fallback.usedMode === undefined ? {} : { usedMode: receipt.fallback.usedMode }),
        recoveredCount: recovered.length,
        addedTokens: receipt.fallback.addedTokens ?? 0,
      },
      gates,
      metrics: {
        mandatoryRecall: effectiveRelevance.mandatoryRecall,
        precision: effectiveRelevance.precision,
        claimRecall: effectiveClaimRecall,
        deterministicResultRate,
        unauthorizedDisclosureCount: receipt.unauthorizedDisclosureCount,
        effectiveInputTokens,
        taskSuccessRate: Number(receipt.taskSucceeded),
        ...(tokenReductionVsDirect === undefined ? {} : { tokenReductionVsDirect }),
        ...(costPerSuccessfulTask === undefined ? {} : { costPerSuccessfulTask }),
        ...(costPerSuccessfulTaskReductionVsDirect === undefined ? {} : { costPerSuccessfulTaskReductionVsDirect }),
      },
      overall: Object.values(gates).every(gate => gate === "pass") ? "pass" : "fail",
    };
  }

  return { manifestId: manifest.id, variants };
}
