# PLAN-0005 — SQLite runtime owner lease and recovery

Status: completed
Target: `0.2.0-alpha.3`
Completed: 2026-08-12
Normative sources: specification 0.5.0, SQLite derived map store extension 0.1.0, and SQLite runtime owner lease extension 0.1.0.

## Outcome

Every SQLite-enabled workspace has one renewable runtime owner. A concurrent process is rejected, a stale owner is fenced, and ownership can recover after crash expiry or graceful close.

## Work units

1. WU-01 — schema v2 migration and runtime owner record.
2. WU-02 — acquire, renew, release, loss detection, and monotonically increasing fencing.
3. WU-03 — multi-workspace heartbeat lifecycle in the reference runtime.
4. WU-04 — owner-conflict and crash/restart Docker smoke, traceability, and evidence.

## Exclusions

Distributed consensus, multi-host writers, external process supervision, file/document indexing, and lease renewal for an individual long-running scan remain outside this slice.

## Gate result

- Targeted ownership/ScopeMap tests: PASS — 14 tests, 47 assertions.
- Full Docker gate: PASS — 54 tests, 160 assertions, 0 failures.
- Package and Docker image build: PASS.
- Two-process owner conflict: PASS — second runtime exited with `DERIVED_STORE_OWNER_BUSY` while heartbeat kept the first lease live.
- Crash-expiry recovery: PASS — replacement acquired fencing token 2 and returned the same filesystem-derived map digest.

Detailed evidence is stored in `artifacts/plans/PLAN-0005/evidence/runtime-owner-lease.md`.
