# PLAN-0024 — Runtime observability and hardening

Status: complete
Milestone: M11
Requirements: OBS-001..003, SEC-001..003, AC-OBS-BODY-FREE, AC-OVERSIZED-INDEX

## Outcome

ABCM exposes a failure-isolated structured telemetry port, records bounded audit/metric facts for the critical application operations, and refuses to materialize oversized indexed files while continuing safe sibling indexing.

## Work units

1. WU-01 — RED contract tests for body-free event schemas, sink isolation, operation metrics, and oversized indexing.
2. WU-02 — fixed audit/metric contracts plus no-op and in-memory adapters.
3. WU-03 — scan, resolver, context, documentation, file-mutation, and authentication instrumentation.
4. WU-04 — maxIndexBytes enforcement, metadata-only diagnostic, and malicious YAML/frontmatter regression fixtures.
5. WU-05 — threat model, operator documentation, traceability, full Docker gate, and final-image smoke.

## Boundaries

- Telemetry has no arbitrary attribute bag and never records requests, response bodies, headers, document ids, paths, goals, or content.
- Metrics have a fixed name set and bounded labels.
- Resource activation remains metadata-only and outside this plan.
- No external telemetry backend is selected; callers inject the port.

## Gate result

- Focused hardening/observability: 3 tests, 19 assertions, 0 failures.
- Full Docker check: 140 tests, 680 assertions, 0 failures.
- Production image and final `dist` import/telemetry smoke: PASS.
