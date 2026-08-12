# Feature plan — SQLite runtime owner lease

Requirements: OWN-001..006. Acceptance: AC-OWN-CONFLICT, AC-OWN-HEARTBEAT, and AC-OWN-RECOVERY.

## TDD sequence

1. RED v1-to-v2 migration and exclusive owner acquisition tests.
2. RED heartbeat extension, unchanged fencing token, and graceful release tests.
3. RED expired-owner takeover and stale-owner rejection tests.
4. GREEN repository ownership primitives and multi-workspace heartbeat.
5. Full regression, build, owner-conflict Docker smoke, and crash-expiry recovery smoke.

## Safety boundaries

- Ownership is per workspace database and never authorizes filesystem access.
- A stale owner cannot read or publish derived state through its adapter.
- Graceful close releases only the matching owner/fencing tuple.
- Crash recovery waits for expiry; it never deletes or rewrites canonical workspace files.
