# PLAN-0010 — Stable explicit ScopeMap relations

Status: complete
Target: `0.2.0-alpha.8`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and Explicit scope relations extension 0.1.0.

## Outcome

ScopeMap resolves stable scope/document links from indexed frontmatter and strict `config/relations.yaml`, records unresolved/required status, computes readiness warnings, and atomically publishes normalized graph metadata in SQLite schema v5.

## Work units

1. WU-01 — strict stable URI parser/resolver for scope, artifact, plan, and architecture namespaces.
2. WU-02 — strict per-scope `config/relations.yaml` index and deterministic explicit relation diagnostics.
3. WU-03 — readiness integration and safe agent/admin graph projections.
4. WU-04 — SQLite schema v5 normalized nodes, relations, and diagnostics.
5. WU-05 — RED/GREEN, migration, determinism, public-boundary, full regression, build, and runtime gates.

## Exclusions

Role/skill resolution, context document-body selection, LNK-002 context-time hard failure, native watchers, incremental impact-set scanning, reverse dependency rescan, and `ScopeMapChanged` events remain outside this slice.

## Verification result

- Stable URI resolution, strict relations configuration, required/optional diagnostics, readiness, and safe projections: PASS.
- SQLite v1/v2/v3/v4 migration to schema v5 and atomic normalized graph publication: PASS.
- Full Linux/Docker gate: 77 tests, 295 assertions, 0 failures.
- Package build, production image, authenticated REST ScopeMap smoke, SQLite inspection, and graceful shutdown: PASS.
