# PLAN-0004 — SQLite derived ScopeMap store foundation

Status: completed
Target: `0.2.0-alpha.2`
Completed: 2026-08-12
Normative sources: specification 0.5.0 and SQLite derived map store extension 0.1.0.

## Outcome

ABCM can publish ScopeMap revisions into a versioned, rebuildable SQLite database with rollback journaling, scan leases, fencing, and an atomic active-revision pointer while the filesystem remains canonical.

## Work units

1. WU-01 — repository port, schema migration, and journal policy.
2. WU-02 — lease/session lifecycle and stale-fencing rejection.
3. WU-03 — atomic revision publication and ScopeMap integration.
4. WU-04 — runtime opt-in, restart/rebuild smoke, traceability, and evidence.

## Exclusions

Document/source indexing, context cache, synchronization tables, tombstones, background full-reconcile scheduling, and Node.js SQLite parity remain outside this bounded slice.

## Gate result

- Targeted derived-store and ScopeMap tests: PASS — 10 tests, 33 assertions.
- Full Docker gate: PASS — 50 tests, 146 assertions, 0 failures.
- Package build and image build: PASS.
- Disposable runtime create/read/delete/rebuild smoke: PASS — identical digest before and after database deletion, `journal_mode=delete`, one complete active revision.
- Negative paths: PASS — unsupported schema, busy lease, stale fencing, and injected publication failure.

Detailed evidence is stored in `artifacts/plans/PLAN-0004/evidence/sqlite-derived-map-store.md`.
