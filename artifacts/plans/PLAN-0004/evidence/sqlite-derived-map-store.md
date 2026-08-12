# PLAN-0004 evidence — SQLite derived map store

Date: 2026-08-12

## Contract and RED

- Requirements: DST-001..006.
- Acceptance: AC-DST-REBUILD, AC-DST-FENCING, AC-DST-ATOMIC; partial implementation support for specification AC-001 and AC-MAP-ATOMIC.
- Initial targeted run failed because the SQLite adapters did not exist: 0 passed, 2 failed, 2 module-resolution errors.

## Automated gates

- Targeted command: `TMPDIR=/tmp bun test test/sqlite-scope-map-store.test.ts test/scope-map-sqlite-rebuild.test.ts test/scope-map-service.test.ts`.
- Targeted result: 10 passed, 33 assertions, 0 failures.
- Full command: one-off `oven/bun:1.3.14` container running `bun run check` against the worktree.
- Full result: 50 passed, 146 assertions, 0 failures, including real TCP REST and Streamable HTTP MCP e2e.
- Package build: `bun run build` passed.
- Image build: `abcm-mcp-server:sqlite-derived-store` passed.

## Independent negative checks

- Unsupported schema version `999` was rejected as `DERIVED_STORE_CORRUPT` and left unchanged.
- A second unexpired lease was rejected as `SCAN_LEASE_BUSY`.
- An expired/stolen fencing token was rejected as `SCAN_FENCING_STALE`; the active revision stayed current.
- An injected SQLite trigger aborted active-pointer update; the staged revision insert rolled back and the prior complete revision remained active.
- Persisted revision payload did not contain authored `scope.yaml` or DomainLanguageConvention bodies.

## Real runtime rebuild smoke

1. Started a disposable HTTP runtime with `ABCM_DERIVED_STORE_ENABLED=true` and a writable fixture workspace.
2. REST admin projection returned one ready node and digest `sha256:43b932cca58701eaab50341b563d7c5163469d073f4e176a2539161e7843885f`.
3. SQLite reported `journal_mode=delete`, one revision, and one active pointer.
4. Stopped the disposable runtime, deleted only its `/tmp` fixture database, and started a fresh runtime.
5. REST returned the same digest and SQLite was recreated with one complete active revision.

The existing `abcm-local` and tunnel containers were not changed by this milestone. SQLite remains explicit opt-in until a single process owns REST and tunneled MCP access.
