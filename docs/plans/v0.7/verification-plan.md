# Verification plan — 0.2.0-alpha.6

Status: passed on 2026-08-13

1. Source boundary: configured root only, canonical path, hidden directories and symlinks excluded.
2. Preview: zero mutations, deterministic mappings, collision reporting, snapshot digest.
3. Apply: source snapshot revalidation, exact target bytes, atomic file writes, source unchanged.
4. Sync: create/update/delete counts, inactive provenance, tombstone, successful run, new ScopeMap.
5. Protection: direct REST/MCP write/delete/move of active mirrors fails closed.
6. SQLite: schema v4 migration and body-free source/provenance/run/tombstone rows.
7. Parity: real REST and MCP clients observe equivalent preview/apply/sync semantics.
8. Regression: strict TypeScript, full suite, package and production-image build.
9. Runtime: read-only mounted Obsidian-like vault mirrored into a writable managed workspace.

All gates passed. The first host-side full-suite attempt exposed only the known Windows-mounted filesystem timing boundary in two scan-heartbeat tests; the authoritative Linux/Docker run passed both and the complete suite. See the PLAN-0008 evidence record.
