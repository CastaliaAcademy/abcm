# PLAN-0021 — REST request boundaries

Status: complete
Target: `0.2.0-alpha.19`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and REST request boundaries extension 0.1.0.

## Outcome

The REST adapter bounds authenticated request rate, streamed body bytes, request lifetime, and caller cancellation while preserving the same application commit semantics as MCP.

## Work units

1. WU-01 — RED tests for rate exhaustion, body streaming, deadline, cancellation, configuration, and no pre-commit mutation.
2. WU-02 — validated REST limit configuration, runtime wiring, and CLI environment parsing.
3. WU-03 — fixed-window protected-request limiter with stable 429 Problem Details and Retry-After.
4. WU-04 — incremental abort-aware request-body reader and cooperative deadline propagation through every asynchronous REST use case.
5. WU-05 — OpenAPI response contract, operator/API documentation, full regression, production image, and final-image smoke.

## Boundary

The limiter is process-local because the MVP supports one server owner and not distributed multi-writer coordination. Reverse-proxy or multi-replica aggregate limiting remains deployment-owned. Filesystem calls already executing in the kernel are not forcibly terminated; commit-boundary semantics match PLAN-0019.

## Verification result

- PASS — RED boundaries, configuration, rate/body/deadline/cancellation behavior, no-pre-commit mutation, OpenAPI, Docker 130/130, production image, final-image smoke, and Compose validation.
