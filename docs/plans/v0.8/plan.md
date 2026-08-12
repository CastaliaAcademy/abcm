# PLAN-0009 — Periodic ScopeMap reconciliation

Status: complete
Target: `0.2.0-alpha.7`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and Periodic ScopeMap reconcile extension 0.1.0.

## Outcome

Every ABCM runtime periodically rebuilds a complete ScopeMap for all registered workspaces, repairs changes missed by filesystem notifications, coalesces mutation bursts, and shuts down without racing SQLite closure.

## Work units

1. WU-01 — per-workspace in-process serialization in `ScopeMapService`.
2. WU-02 — runtime-owned reconcile coordinator with mutation debounce and periodic full scans.
3. WU-03 — interval configuration, background error reporting, and close ordering.
4. WU-04 — deterministic digest, missed-event, concurrency, shutdown, regression, and runtime gates.

## Exclusions

Native filesystem watchers, incremental impact-set scanning, reverse-link dependency analysis, document-source auto-sync, distributed scheduling, persisted job queues, cron syntax, and adaptive intervals remain outside this slice.

## Verification result

- Per-workspace serialization, mutation debounce, dynamic registry, failure recovery, and shutdown: PASS.
- Missed-event repair and equivalent digest across unchanged periodic scans: PASS.
- Full Linux/Docker gate: 74 tests, 268 assertions, 0 failures.
- Package build, production image, direct bind-mount change detection, and graceful SQLite owner release: PASS.
