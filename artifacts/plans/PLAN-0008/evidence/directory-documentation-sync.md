# PLAN-0008 evidence — directory documentation mirror

Date: 2026-08-13

## Delivered behavior

- Deployment-owned directory sources are parsed from strict `ABCM_DOCUMENTATION_SOURCES` JSON; request bodies accept only `sourceId`.
- Preview is non-mutating and checksum-pins source snapshots and target state.
- Apply and sync use atomic workspace file writes, never write into the source, and publish a new ScopeMap revision.
- Active mirrors resolve as `storageMode=mirror`, reject public write/delete/move operations, and retain source provenance.
- Canonical deletion removes the active mirror and transactionally records inactive provenance, a tombstone, and a successful SyncRun.
- REST and MCP expose preview/apply/sync through the same application service.
- `.obsidian`, other hidden entries, and symbolic links are excluded.

## Verification

- Targeted service, configuration, REST, and MCP tests: 7 passed, 42 assertions, 0 failures before the final mutation-parity additions.
- Final Linux/Docker `bun run check`: 68 tests, 257 assertions, 0 failures across 20 files.
- `docker build -t abcm-mcp-server:documentation-sync .`: PASS; final image manifest list `sha256:790ba5b420cb8e51f1f621ef06af73c8c0c254d4d0438ab91a3c74ce70a2223d`.
- Compose configuration with `compose.obsidian.yaml`: PASS.

## Runtime smoke

The final image ran with a writable workspace bind and an Obsidian-like source bind mounted read-only.

- preview operation: `create`;
- apply: 1 created, successful;
- source and target SHA-256: equal;
- direct target mutation: `409 MIRROR_DOCUMENT_READ_ONLY`;
- source mount write probe: rejected as read-only;
- SQLite schema: 4;
- active provenance rows: 1;
- successful sync-run rows: 1.

The temporary smoke container and fixture directories were removed. Existing `abcm-local` and tunnel containers were not modified.

## Known boundary

This slice does not provide a watcher, two-way synchronization, identity-preserving move detection, managed-storage cutover, or a packaged Obsidian community plugin. Import plans are process-local and must be re-previewed after restart. The operator/plugin REST contract is usable now; packaged plugin UX is a later feature.

## Workspace documentation publication

The existing local service received 14 PLAN-0008 documentation/configuration files under `castalia-public/abcm` through its authenticated REST file boundary: preview reported 8 creates, 6 modifications, 0 collisions; apply changed 14 files; verification confirmed equal size and SHA-256 for all 14. A live read returned the Obsidian guide, and ScopeMap published digest `sha256:be5aa606c89e4a9cfdee6a4d1b44d1ec33012eb18a182cf7c08b54cf6d6d646a` with zero diagnostics and the `abcm` project ready. The running `abcm-local` and `abcm-tunnel` images were not replaced.
