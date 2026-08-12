# Feature plan — SQLite derived map store

Requirements: DST-001..006. Acceptance: AC-DST-REBUILD, AC-DST-FENCING, AC-DST-ATOMIC, and specification AC-001/AC-MAP-ATOMIC where covered by this slice.

## TDD sequence

1. RED schema creation, schema-version, and `journal_mode != WAL` test.
2. RED lease conflict and stale fencing publication test.
3. GREEN transactional migrations, lease/session records, and atomic active pointer.
4. RED ScopeMap rebuild after deleting SQLite.
5. GREEN repository integration while preserving in-memory default compatibility.
6. Targeted tests, full check, build, and real runtime restart/rebuild smoke.

## Security and data boundaries

- SQLite is derived and disposable.
- No authored file bodies are persisted.
- A failed or stale publication cannot replace the active revision.
- Runtime enablement is explicit until the HTTP tunnel and reference server share one process owner.
