# PLAN-0020 — Shared REST schemas, OpenAPI 3.1, and MCP parity

Status: complete
Target: `0.2.0-alpha.18`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and REST OpenAPI parity extension 0.1.0.

## Outcome

The REST adapter consumes schemas derived from the same Zod contracts as MCP, serves a deterministic OpenAPI 3.1 document, and has explicit semantic parity tests for files, ScopeMap, context, documentation authorization, and stable error codes.

## Work units

1. WU-01 — extract shared REST request/output schema registry from MCP operation contracts.
2. WU-02 — deterministic OpenAPI 3.1 generation for every implemented v1 endpoint and Problem Details.
3. WU-03 — `/openapi.json`, generation CLI, committed snapshot, and byte-drift test.
4. WU-04 — real REST/MCP semantic parity for canonical bytes, metadata, map digest, and application errors.
5. WU-05 — regression, package build, production image, and final-image OpenAPI smoke.

## Boundary

The normative documentation-source cutover endpoint remains absent from OpenAPI because M10 owns the application use case and its transactional verification. Rate/request timeout limits are completed in the next M9 plan.

## Verification result

- Shared strict JSON schemas and deterministic OpenAPI snapshot: PASS.
- REST/MCP file/map/error and mirror-authorization parity: PASS.
- Existing exact domain-language and ContextBundle parity suites: PASS.
