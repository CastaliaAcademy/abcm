import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { runDirectSearchBaseline } from "../src/evaluation/direct-search-baseline.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const root = resolve("benchmarks/fixtures/context-efficiency-v1/workspace");
const files = new WorkspaceFileService(new WorkspaceRegistry([{ id: "benchmark", root }]));

describe("воспроизводимый baseline прямого поиска", () => {
  test("сохраняет реальный read trace и находит известный gold set только внутри разрешённого scope", async () => {
    const request = {
      workspaceId: "benchmark",
      queryTerms: ["отмена", "заказа", "idempotency", "tenant", "retry", "cancel"],
      allowedPathPrefixes: ["commerce/orders"],
      claimChecks: [
        { id: "idempotency-reuses-result", allTerms: ["idempotency key", "прежний результат"] },
        { id: "tenant-boundary", allTerms: ["своего tenant", "не должен раскрываться"] },
      ],
    } as const;
    const first = await runDirectSearchBaseline(files, request);
    const second = await runDirectSearchBaseline(files, request);

    expect(first.mode).toBe("actual-search-trace");
    expect(first.selectedDocuments.map(document => document.documentId).sort()).toEqual([
      "order-api", "order-contract", "order-retry", "order-security",
    ]);
    expect(first.trace.candidateCount).toBe(5);
    expect(first.trace.reads).toHaveLength(5);
    expect(first.totalInputTokens).toBeGreaterThan(0);
    expect(first.retrievedClaimIds).toEqual(["idempotency-reuses-result", "tenant-boundary"]);
    expect(second.resultDigest).toBe(first.resultDigest);
    expect(JSON.stringify(first)).not.toContain("FOREIGN-WORKSPACE-SECRET");
    expect(JSON.stringify(first)).not.toContain("foreign-secret");
  });

  test("отклоняет traversal и ограничивает объём фактического чтения", async () => {
    await expect(runDirectSearchBaseline(files, { workspaceId: "benchmark", queryTerms: ["secret"], allowedPathPrefixes: ["../foreign"] })).rejects.toThrow("safe workspace-relative path");
    await expect(runDirectSearchBaseline(files, { workspaceId: "benchmark", queryTerms: ["отмена"], allowedPathPrefixes: ["commerce/orders"], maxFiles: 1 })).rejects.toThrow("exceeds limit");
    await expect(runDirectSearchBaseline(files, { workspaceId: "benchmark", queryTerms: ["отмена"], allowedPathPrefixes: ["commerce/orders"], maxReadBytes: 1 })).rejects.toThrow("read bytes exceed limit");
  });
});
