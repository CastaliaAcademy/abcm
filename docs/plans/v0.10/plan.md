# PLAN-0011 — Incremental ScopeMap reconciliation and change events

Status: complete
Target: `0.2.0-alpha.9`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and Incremental ScopeMap reconcile extension 0.1.0.

## Outcome

File mutations drive a deterministic targeted ScopeMap reconcile over the normative impact set, while periodic and topology-changing work retains the full-scan safety net. Every changed atomic publication emits a bounded in-process `ScopeMapChanged` event.

## Work units

1. WU-01 — retain debounced changed paths and serialize mutations arriving during in-flight work.
2. WU-02 — nearest-scope and impact-set computation with topology fallback.
3. WU-03 — reuse unaffected indexes while rebuilding a complete immutable revision.
4. WU-04 — post-publication `ScopeMapChanged` subscription and failure isolation.
5. WU-05 — RED/GREEN, reverse-link, readiness, queueing, event, full regression, build, and runtime gates.

## Exclusions

Native filesystem watchers, event persistence/brokers, REST/SSE event streaming, distributed subscribers, partial SQLite revisions, and incremental scope-topology discovery remain outside this slice.

## Verification result

- Debounced path retention, in-flight queueing, nearest-scope resolution, reverse/readiness impact expansion, and topology fallback: PASS.
- Complete immutable revision publication and isolated post-publication `ScopeMapChanged`: PASS.
- Full Linux/Docker gate: 84 tests, 321 assertions, 0 failures.
- Package build, production image, real REST mutation, SQLite, equivalent-digest, and event runtime smoke: PASS.
