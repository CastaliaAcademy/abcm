# PLAN-0001 — ABCM first working version

Status: completed
Target: `0.1.0-alpha.1`
Completed: 2026-08-10
Normative sources: specification 0.5.0, REST file management extension 0.1.0, and REST static auth extension 0.1.0.

## Outcome

A user can point ABCM at an existing project, manage allowed files through REST or the filesystem, scan a bounded ScopeMap, and call equivalent MCP operations. This repository is the first migration fixture.

## Executed work units

1. WU-01 — contracts, stable errors, workspace registry, and safe paths.
2. WU-02 — filesystem `WorkspaceFileService`, checksums, serialized mutations, and atomic file replacement.
3. WU-03 — authenticated REST CRUD/list/move/directory endpoints and problem responses.
4. WU-04 — bounded ScopeMap scan, deterministic digest, diagnostics, and projections after mutation.
5. WU-05 — MCP resources/tools over the same services, verified through a real in-memory client connection.
6. WU-06 — self-hosted metadata, three project skills, migration dry-run, docs, build, and real HTTP smoke evidence.

## Gate result

- `bun run check`: PASS — 35 tests, 83 assertions, 0 failures.
- `bun run build`: PASS.
- Project skills: PASS — all three accepted by the official skill validator.
- Real HTTP migration smoke: PASS — health, authentication rejection, ScopeMap scan, read, create, read-back, and delete.
- Current repository: PASS — one valid workflow node, ready, with no ScopeMap diagnostics.

Detailed evidence is stored in `artifacts/plans/PLAN-0001/evidence/first-working-version.md`.

## Explicitly deferred

This gate is a migration-capable vertical slice, not completion of the entire 0.5 specification. SQLite revision history and leases, ContextBundle/fingerprint construction, effective domain resolution, automatic skill connection, documentation-source sync/cutover, per-principal authorization, durable audit records, rate limits, and Streamable HTTP MCP remain future milestones.
