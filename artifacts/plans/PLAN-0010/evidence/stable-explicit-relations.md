# PLAN-0010 evidence — stable explicit ScopeMap relations

Date: 2026-08-13

## Delivered behavior

- Indexed document frontmatter and strict per-scope `config/relations.yaml` produce deterministic explicit graph edges.
- `abcm://scope/<id>` resolves aliases to canonical scope ids; artifact, plan, and architecture references resolve by stable document id and matching namespace.
- Supported misses retain the full stable URI and distinguish `unresolved_optional` from `unresolved_required`.
- Required misses set owner-scope readiness to `warning`; hard failure during context construction remains assigned to LNK-002's context milestone.
- Physical or malformed targets are diagnosed but never resolved. Role and skill URIs remain deferred to their normative resolvers.
- Agent projection exposes only visible scope-to-scope edges and safe warnings. Admin projection exposes the complete relation metadata. Neither projection exposes document bodies or indexed document paths.
- SQLite schema v5 atomically normalizes nodes, relations, and diagnostics alongside the content-addressed MapRevision payload and backfills pre-v5 revisions during migration.

## TDD evidence

- RED in the corrected Linux temp/dependency environment: 6 tests passed and 7 contract tests failed because explicit relations and schema v5 did not exist.
- GREEN targeted gate: 23 tests, 108 assertions, 0 failures across relation, ScopeMap, content-index, SQLite migration/rebuild, and self-migration suites.
- Final focused rerun after projection and legacy-v4 hardening: 13 tests, 61 assertions, 0 failures.

The first raw local RED attempt inherited a Windows temp directory and lacked worktree dependencies; those environment failures were corrected before the product RED result was recorded.

## Independent verification

| Requirement | Result | Evidence |
| --- | --- | --- |
| MAP-019, MAP-020, MAP-021 | PASS | structural plus explicit edges, alias resolution, optional/required diagnostics, readiness tests |
| LNK-001 | PASS | POSIX absolute, Windows drive, UNC, and relative physical targets rejected |
| LNK-002 boundary | PASS | required miss remains published as warning; context-time hard failure explicitly not claimed |
| ESR-001..ESR-005 | PASS | stable resolver, strict schema, relation status, diagnostics, readiness tests |
| ESR-006 | PASS | v1/v2/v3/v4→v5 migration and normalized-row assertions |
| ESR-007 | PASS | agent/admin projection assertions and body/path negative checks |

## Full gate and build

- Full Linux/Docker `bun run check`: 77 tests, 295 assertions, 0 failures across 23 files.
- `bun run build`: PASS.
- Production image `abcm-mcp-server:explicit-relations`: PASS; manifest list `sha256:5e9ceda5c14f56a439cc63242e1e4a2254b3ce1f0543eee3abb1b6d5e3cca695`.

The sandboxed host run reached 74 passing tests but could not bind two ephemeral TCP listeners (`EADDRINUSE`); the same real REST and MCP-over-HTTP tests passed in the Docker gate, classifying this as an environment limitation rather than a product failure.

One repeated full Docker run hit the pre-existing scan-heartbeat test's five-second timeout by 125 ms. The isolated heartbeat suite then passed 2/2, and the final complete Docker rerun passed 77/77; this was classified as a timing flake rather than a PLAN-0010 failure.

## Production runtime smoke

A disposable read-only production container used a read-only canonical workspace mount and a separate tmpfs-backed `.abcm` derived store.

- authenticated admin and agent REST ScopeMap requests returned HTTP 200;
- admin returned four relations including one `unresolved_required` edge;
- agent returned only three resolved visible-scope edges while retaining the relevant unresolved warning;
- source-scope readiness was `warning`;
- SQLite reported schema 5, `journal_mode=delete`, three nodes, four relations, and one diagnostic;
- SIGTERM shutdown exited 0 without OOM;
- the disposable container was removed; `abcm-local` and `abcm-tunnel` were not modified.

## Remaining boundary

Role/skill URI resolution, context selection and LNK-002 hard failure, incremental impact-set reconcile, reverse-link readiness dependencies, native watchers, and `ScopeMapChanged` event emission remain later milestones.

## Workspace documentation publication

The existing local service received the five new PLAN-0010 specification, plan, traceability, verification, and evidence files under `castalia-public/abcm` through authenticated REST. Initial publication created all five files, byte-for-byte verification passed, and a live ScopeMap scan completed with zero diagnostics. The evidence file was then refreshed through the same checksum-protected path; the running `abcm-local` and `abcm-tunnel` images were not replaced.
