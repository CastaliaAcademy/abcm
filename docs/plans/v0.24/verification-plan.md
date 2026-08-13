# PLAN-0025 verification plan

1. Schema: fresh and v1-v6 databases migrate transactionally to v7 without replacing active revisions.
2. Catalog: one successful build persists one bundle and fingerprint; identical retry is idempotent.
3. Conflict: reused fingerprint identity with changed location or payload fails closed.
4. Disclosure: sentinel document body is absent from SQLite and catalog projections.
5. Benchmark: deterministic large fixture reports separate non-negative phase durations and fixture counts.
6. Supply chain: frozen lock install, dependency graph/SBOM validation, package allowlist, license, provenance, release notes, and runnable examples.
7. Final: full Docker check/build, production image, and final `dist` catalog smoke pass.
