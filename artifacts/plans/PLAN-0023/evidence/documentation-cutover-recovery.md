# PLAN-0023 evidence — documentation cutover and recovery

Date: 2026-08-13
Status: complete

## Delivered behavior

- Shared `documentation_source.cutover` requires literal approval and a reviewed source snapshot digest through REST and MCP.
- Final sync precedes validation; every selected external/source-provenance/target checksum must match.
- SQLite schema v6 atomically marks the source `managed/cutover`, deactivates provenance, and records committed/completed cutover state.
- ScopeMap republishes documents as managed; a failure after the metadata transaction resumes without accessing the former source.
- Managed targets become writable and source deletion/sync no longer propagates.
- Sync prepare persists a body-free pending commit before filesystem mutation; a later preview converges a filesystem-complete transition after injected metadata failure.
- Pending source/target divergence returns `DOCUMENTATION_RECOVERY_REQUIRED` instead of overwriting bytes.

## Focused verification

- Cutover/recovery, mapping, sync, SQLite migration, REST/MCP, tool schema, and OpenAPI: focused suites passed, including explicit divergence recovery.

## Final gates

- Full Docker check: 137 tests, 661 assertions, 0 failures.
- Production image: `abcm-mcp-server:plan-0023`.
- Image manifest digest: `sha256:ce84dfbd85c16da7d05969a00383ed1615e3c1cf37028f719ca54ed5f60b67bd`.
- Final-image smoke: 13 shared tools; strict approved cutover input accepted; REST cutover path present; 16 OpenAPI schemas.
