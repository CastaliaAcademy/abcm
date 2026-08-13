# PLAN-0026 verification plan

1. Placement: misplaced role/artifact/architecture records are diagnostics-only; valid siblings survive.
2. Immutability: accepted ADR/RFC write, delete, and overwrite-target fail before mutation; draft content remains mutable; rename preserves id/checksum.
3. Traceability: validator reports exactly 78 baseline requirements, 76 MUST/MUST_NOT, 2 MAY, and 22 baseline acceptance scenarios with no uncovered normative/acceptance ids.
4. Test references: every final traceability test path exists and is included by the Bun test configuration.
5. Release: frozen install, typecheck, 0 failures, deterministic OpenAPI/SBOM, benchmark/package checks, vulnerability audit, no-cache image, and final-image composition-root smoke.
6. Publication: final docs reread byte-for-byte through the authenticated REST API; ScopeMap has zero diagnostics.
