# PLAN-0023 — Transactional documentation cutover and recovery

Status: complete
Target: `0.2.0-beta.1`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and documentation cutover/recovery extension 0.1.0.

## Outcome

An operator can approve a checksum-pinned final synchronization and atomically transfer canonical ownership from a directory/Obsidian mirror to managed ABCM storage. Durable body-free journals close the filesystem/metadata crash gap for sync and cutover MapRevision publication.

## Work units

1. WU-01 — RED approval/snapshot/checksum/managed-write/source-deletion/idempotency scenarios.
2. WU-02 — SQLite schema v6 pending sync journal and atomic cutover records with v1-v5 migration.
3. WU-03 — resumable filesystem-to-metadata sync convergence and fail-closed divergence.
4. WU-04 — final sync, checksum verification, atomic provenance/source mode transition, managed map publication, and committed-cutover recovery.
5. WU-05 — shared MCP/REST/OpenAPI contract, operator docs, full Docker gate, production image, and final-image smoke.

## Boundary

The operator remains responsible for coordinating or freezing source edits before approval. ABCM verifies the reviewed digest immediately after final sync but cannot lock an arbitrary local/network directory. After the atomic ownership transfer, the connector is disabled and the source is never modified. Two-way sync remains excluded.

## Verification result

- Focused cutover/recovery/storage/REST/MCP/OpenAPI gates: PASS.
- Full Docker 137/137, production image, and final-image 13-tool/cutover/OpenAPI smoke: PASS.
