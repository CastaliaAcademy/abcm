import { expect, test } from "bun:test";

import { validateReleaseTraceability } from "../scripts/check-traceability.js";

const documentationRoot = process.env.ABCM_DOCUMENTATION_ROOT;
const documentationTest = documentationRoot === undefined ? test.skip : test;

documentationTest("release traceability covers the complete normative baseline and every extension", async () => {
  expect(await validateReleaseTraceability(documentationRoot)).toEqual({
    release: "0.1.0",
    baselineRequirements: 78,
    baselineMandatory: 76,
    baselineMay: 2,
    baselineAcceptance: 22,
    extensionSpecifications: 27,
    extensionRequirements: 196,
    extensionAcceptance: 56,
  });
});
