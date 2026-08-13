# PLAN-0025 — Context catalog and release packaging

Status: complete
Milestones: M2 closure, M11 release readiness
Requirements: CAT-001..004, AC-CONTEXT-CATALOG

## Outcome

Schema v7 completes the rebuildable bundle/fingerprint catalog and the repository gains deterministic benchmark, SBOM, package-provenance, clean-install, and release-candidate artifacts.

## Work units

1. WU-01 — RED schema-v7, catalog idempotency/conflict, runtime build, and body-free SQLite tests.
2. WU-02 — catalog port, schema migration, separately keyed bundle/fingerprint records, and runtime wiring.
3. WU-03 — deterministic large-fixture benchmark harness separating fixture/hash/parse/scan/SQLite/resolver/projection phases.
4. WU-04 — CycloneDX SBOM from locked direct/transitive dependencies, package provenance statement, runnable library/REST/MCP examples, and 0.1.0 release notes.
5. WU-05 — frozen clean install, check/build, package-content inspection, Docker/full-image gate, traceability, and evidence.

## Boundaries

- The catalog is derived metadata; fingerprint files remain immutable evidence and authored content remains filesystem-canonical.
- No package, image, release, tag, or GitHub state is published by this plan.
- Runtime support remains Bun 1.3.14+. Node.js is not declared supported because the reference derived-store adapter imports `bun:sqlite`.

## Gate result

- Schema/catalog and benchmark focused gates: 15 tests, 60 assertions, 0 failures.
- Full Docker check: 143 tests, 696 assertions, 0 failures.
- Clean no-cache frozen Docker install/build, release typecheck, SBOM/package validation, audit, package dry run, runnable library example, and final-image schema/catalog smoke: PASS.
