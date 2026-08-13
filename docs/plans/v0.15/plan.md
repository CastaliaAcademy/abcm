# PLAN-0016 — Immutable bounded ContextBundle and reproducible ContextFingerprint

Status: complete
Target: `0.2.0-alpha.14`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and Context bundle construction extension 0.1.0.

## Outcome

`buildTaskContext` becomes one transport-independent application use case that validates the bootstrap, resolves path and skills, selects authorized documents mandatory-first, applies deterministic projections and budget, materializes an immutable bounded bundle, and atomically persists a body-free fingerprint.

## Work units

1. WU-01 — public request, bundle, projection, omission, budget, and fingerprint contracts plus stable error codes.
2. WU-02 — deterministic mandatory/optional collection, lifecycle, authorization, deduplication, reasons, and projection policy.
3. WU-03 — mandatory-first token budget, exact materialization, normalized digest, and atomic body-free fingerprint storage.
4. WU-04 — runtime composition plus strict REST and MCP adapters over the same application service.
5. WU-05 — RED/GREEN, negative security/budget tests, full regression, build, production image, and adapter smoke.

## Exclusions

Semantic embeddings, generated summaries, source-code bodies, executable-resource activation, arbitrary role/profile configuration files, operator decision workflow, and full ScopeMap disclosure remain outside this bounded alpha slice. Deterministic metadata/reference/full/summary projection and fixed versioned budget profiles are supported.

## Verification result

- Bootstrap/revision pinning, bounded path/language/skill resolution, mandatory/optional selection, lifecycle/access, projections, and deterministic budget: PASS.
- Atomic symlink-safe body-free fingerprint files and deterministic bundle digest: PASS.
- REST/MCP semantic parity and no-full-map disclosure: PASS.
- Targeted context/index gate: 8 tests, 43 assertions, 0 failures.
- Full Linux/Docker gate: 107 tests, 424 assertions, 0 failures.
- Package build, production image, and production `dist` adapter smoke: PASS.
