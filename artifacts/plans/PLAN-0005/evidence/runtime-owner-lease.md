# PLAN-0005 evidence — SQLite runtime owner lease

Date: 2026-08-12

## Contract and RED

- Requirements: OWN-001..006.
- Acceptance: AC-OWN-CONFLICT, AC-OWN-HEARTBEAT, AC-OWN-RECOVERY.
- Initial targeted result: 5 passed and 5 failed. Schema remained v1, `runtime_owners` and owner methods were absent, and a second reference runtime scanned the same database instead of being rejected.

## Automated gates

- Targeted command: `TMPDIR=/tmp bun test test/sqlite-scope-map-store.test.ts test/scope-map-sqlite-rebuild.test.ts test/scope-map-service.test.ts`.
- Targeted result: 14 passed, 47 assertions, 0 failures.
- Full command: one-off `oven/bun:1.3.14` container running `bun run check` against the worktree.
- Full result: 54 passed, 160 assertions, 0 failures, including real TCP REST and Streamable HTTP MCP e2e.
- Package build and image `abcm-mcp-server:runtime-owner-lease`: PASS.

## Independent negative checks

- Schema v1 upgraded transactionally to v2 while preserving the active MapRevision.
- A second unexpired runtime owner was rejected as `DERIVED_STORE_OWNER_BUSY`.
- Renewal extended expiry without changing the owner fencing token.
- After takeover, the stale adapter rejected both scan and read as `DERIVED_STORE_OWNER_LOST`.
- Graceful release allowed immediate ownership recovery with a greater token.

## Real two-process and crash-recovery smoke

1. Started disposable runtime A with 1200 ms owner TTL and 200 ms heartbeat.
2. Runtime A returned digest `sha256:b090f8ab0de505f4ee428eaa0adc9efc276ccf70d88bbbf3bf1e28791f6ab6fc`, fencing token 1, and a live renewed lease.
3. Started runtime B against the same workspace. It exited 1 with `DERIVED_STORE_OWNER_BUSY`; A's active revision was unchanged.
4. Killed only disposable runtime A, waited beyond TTL, and started runtime C.
5. Runtime C returned the same digest, a live lease, and fencing token 2.
6. All disposable smoke containers were removed. Existing `abcm-local` and tunnel containers were not changed.

SQLite stays opt-in for the current local deployment because REST and tunneled stdio MCP are separate processes. The owner lease now makes accidental dual enablement fail closed.
