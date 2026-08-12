# PLAN-0008 — Directory documentation mirror

Status: complete
Target: `0.2.0-alpha.6`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and Directory documentation sync extension 0.1.0.

## Outcome

ABCM can mirror Markdown documentation from a server-approved local or mounted network directory, including an Obsidian vault, through preview/apply/sync operations while retaining one canonical source, provenance, deletion tombstones, and read-only mirror protection.

## Work units

1. WU-01 — deployment-owned directory source registry and safe snapshot discovery.
2. WU-02 — non-mutating preview and checksum-pinned apply/sync service.
3. WU-03 — SQLite schema v4 provenance, sync-run, tombstone, and mirror storage resolution.
4. WU-04 — REST/MCP parity, mirror mutation protection, regression, and mounted-folder runtime smoke.

## Exclusions

Two-way sync, arbitrary request-provided roots, remote Git/HTTP connectors, automatic watcher scheduling, mapping globs, binary attachments, conflict merge, identity-preserving moves, cutover to managed mode, and a packaged Obsidian community plugin remain outside this slice.

## Verification result

- Directory boundary, preview/apply/update/delete, provenance, tombstone, mirror protection, and REST/MCP parity: PASS.
- SQLite v1/v2/v3 migration to schema v4 and body-free metadata persistence: PASS.
- Full Linux/Docker gate: 68 tests, 257 assertions, 0 failures.
- Production image build, Compose Obsidian overlay validation, and read-only mounted-folder runtime smoke: PASS.
