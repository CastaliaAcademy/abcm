# Feature plan — periodic ScopeMap reconciliation

Status: complete

Requirements: MAP-004, MAP-007, MAP-008, PRR-001..007. Acceptance: AC-MAP-ATOMIC and AC-PRR-*.

## TDD sequence

1. RED concurrent direct scans for one workspace never contend for their own ScanLease.
2. RED duplicate mutation requests inside one debounce window execute one full scan and share its result.
3. RED a periodic tick discovers a canonical filesystem change that emitted no mutation callback.
4. RED background failure is reported and a later periodic attempt succeeds.
5. RED close flushes pending mutation work, waits for it, and prevents later ticks.
6. GREEN coordinator, runtime/CLI configuration, full regression, build, and disposable runtime smoke.

All six steps completed on 2026-08-13. Detailed results are recorded in `artifacts/plans/PLAN-0009/evidence/periodic-scope-map-reconcile.md`.

## Safety boundaries

- Every reconcile delegates to the existing full `ScopeMapService.scan` and atomic store publication.
- The coordinator never edits canonical files or patches an active revision.
- Per-workspace work is serialized in-process; cross-process fencing remains enforced by SQLite.
- The periodic timer is runtime-owned, unreferenced, and stopped before the owned store closes.
