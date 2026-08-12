# Feature plan — directory documentation sync

Status: complete

Requirements: SYNC-001..005 and DDS-001..009. Acceptance: AC-DOC-MIRROR-DELETE and AC-DDS-*.

## TDD sequence

1. RED preview is non-mutating, ignores `.obsidian`/symlinks, and reports create/collision operations.
2. RED apply verifies the pinned snapshot, writes exact bytes, persists provenance, and never changes the source.
3. RED update/delete sync preserves active identity, writes inactive provenance and tombstone, and publishes a new map.
4. RED public REST/MCP file writes, moves, and deletes reject active mirrors.
5. RED schema v3-to-v4 migration and REST/MCP source-operation parity.
6. GREEN application service, storage adapter, adapter contracts, full gate, build, and mounted-folder runtime smoke.

All six steps completed on 2026-08-13. Detailed results are recorded in `artifacts/plans/PLAN-0008/evidence/directory-documentation-sync.md`.

## Safety boundaries

- The request names only a configured source id; it never supplies a host path.
- Source directories are read-only inputs and symlinks are ignored.
- Initial import always requires preview; `sync` performs an internal preview immediately followed by checksum-pinned apply.
- Mirror copies cannot be edited through general file APIs.
