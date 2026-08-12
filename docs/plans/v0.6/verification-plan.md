# Verification plan — 0.2.0-alpha.5

1. Classification: managed roots indexed; denied/generated/ordinary source paths excluded.
2. Documents: valid frontmatter parsed; rename keeps identity; duplicate id is diagnostic and excluded.
3. Resources: skill script indexed as metadata only and requires activation.
4. Projection: REST and MCP map payloads contain aggregate counts but no indexed paths or bodies.
5. SQLite: schema v3 migration, normalized rows, foreign-key revision binding, atomic failure rollback, rebuild equivalence.
6. Regression: strict TypeScript, full unit/contract/TCP e2e suite, package and image build.
7. Runtime: disposable production image scan and direct read-only SQLite inspection.

## Result

All gates passed on 2026-08-12. See `artifacts/plans/PLAN-0007/evidence/scope-content-indexes.md`.
