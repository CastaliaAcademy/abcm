import { describe, expect, test } from "bun:test";

import type { ContextBudgetAllocation, ContextSelectionPreview } from "../src/context/types.js";

describe("explainable preview and budget taxonomy", () => {
  test("preview contract publishes requested, reserved, consumed and omitted tokens", () => {
    const allocation: ContextBudgetAllocation = {
      bucketId: "feature",
      requestedTokens: 120,
      reservedTokens: 80,
      consumedTokens: 100,
      selectedTokens: 100,
      omittedTokens: 20,
    };
    const preview = { budgetAllocation: [allocation] } as unknown as ContextSelectionPreview;
    expect(preview.budgetAllocation[0]).toEqual({
      bucketId: "feature",
      requestedTokens: 120,
      reservedTokens: 80,
      consumedTokens: 100,
      selectedTokens: 100,
      omittedTokens: 20,
    });
  });
});
