# PLAN-0020 verification plan

## Contract gates

- RED: REST owns duplicate request schemas and no OpenAPI document or snapshot exists.
- Schema: generated request components retain strict additionalProperties=false from the MCP registry.
- Coverage: every implemented v1 route has one stable operationId, responses, security, and Problem Details.
- Snapshot: generation output equals the committed artifact byte-for-byte.
- Parity: one runtime exposes equal canonical bytes/checksums/map digest and ABCM errors through REST and MCP.
- Boundary: cutover is absent until M10.
- Regression: targeted tests, full Linux check, production build/image, final-image OpenAPI smoke.

## Result

- PASS — deterministic snapshot, shared strict schemas, route coverage, semantic parity, Docker 124/124, production build, and final-image smoke.
- Environment note — the managed local sandbox rejected three ephemeral TCP listeners; the same cases passed in Docker.
