# PLAN-0018 — Structured MCP tool and stable error contract

Status: complete
Target: `0.2.0-alpha.16`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and MCP tool contract extension 0.1.0.

## Outcome

All twelve MCP tools publish strict structured input/output schemas from one exported registry, expose versioned ABCM capability metadata, and distinguish SDK schema rejection, expected ABCM execution errors, cancellation, and redacted internal failures.

## Work units

1. WU-01 — common Zod contracts for file, map, language, context, and documentation operations.
2. WU-02 — exported operation-name schema registry and registration-time output validation.
3. WU-03 — stable expected/cancelled/internal error envelopes and capability/version metadata.
4. WU-04 — real-client happy/schema/error mapping coverage for all public tools.
5. WU-05 — regression, build, production image, and final-image adapter smoke.

## Exclusions

Cooperative cancellation and timeout propagation through application-service commit boundaries are completed in the next M8 plan. REST/OpenAPI consumption of the exported schemas belongs to M9.

## Verification result

- Twelve strict input/output schema pairs and public registry: PASS.
- 2025-11-25 negotiation plus versioned `abcm.dev/contract` capability metadata: PASS.
- All-tool schema rejection and stable expected-error mapping: PASS.
- MCP happy paths across workspace, ScopeMap, language, context, and documentation operations: PASS.
- Full isolated Linux/Docker gate: 114 tests, 552 assertions, 0 failures.
- Production image and final-image exported-contract smoke: PASS.
