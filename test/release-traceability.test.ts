import { expect, test } from "bun:test";

import { isReleaseTraceabilityExtension, validateReleaseTraceability } from "../scripts/check-traceability.js";

test("release traceability excludes proposed, withdrawn and superseded extensions", () => {
  expect(isReleaseTraceabilityExtension({ metadata: { status: "proposed" } })).toBe(false);
  expect(isReleaseTraceabilityExtension({ extension: { status: "proposed" } })).toBe(false);
  expect(isReleaseTraceabilityExtension({ metadata: { status: "withdrawn" } })).toBe(false);
  expect(isReleaseTraceabilityExtension({ metadata: { status: "superseded" } })).toBe(false);
  expect(isReleaseTraceabilityExtension({ metadata: { status: "approved-for-alpha" } })).toBe(true);
  expect(isReleaseTraceabilityExtension({ metadata: { status: "draft" } })).toBe(true);
});

const documentationRoot = process.env.ABCM_DOCUMENTATION_ROOT;
const documentationTest = documentationRoot === undefined ? test.skip : test;

documentationTest("release traceability covers the complete normative baseline and every extension", async () => {
  expect(await validateReleaseTraceability(documentationRoot)).toEqual({
    release: "0.1.0",
    baselineRequirements: 78,
    baselineMandatory: 76,
    baselineMay: 2,
    baselineAcceptance: 22,
    extensionSpecifications: 32,
    extensionRequirements: 256,
    extensionAcceptance: 77,
  });
});
