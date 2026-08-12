# Verification plan — 0.2.0-alpha.2

1. Static: strict TypeScript and package build.
2. Schema: fresh database, migration idempotence, schema version, rollback journal.
3. Concurrency: busy lease rejection and stale fencing rejection.
4. Atomicity: failed publication leaves the previous complete active revision.
5. Rebuild: delete SQLite, rescan filesystem, compare map digest/nodes/relations/warnings.
6. Regression: existing REST/MCP/file/ScopeMap suites.
7. Runtime: opt-in CLI Docker smoke against a disposable workspace.
