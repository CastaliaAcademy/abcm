# PLAN-0003 evidence — first documentation import

Date: 2026-08-11

## Implementation gates

- Docker full check: 44 tests passed, 0 failed, including real TCP REST and Streamable HTTP MCP e2e.
- Package build: `tsc -p tsconfig.build.json` passed.
- Docker image: `abcm-mcp-server:workspace-registration` built successfully.
- Runtime: `abcm-local` and `abcm-tunnel` run the new image; prior containers remain stopped as recoverable backups.
- Restart discovery: after restarting `abcm-local`, REST listed 42 project entries and found the imported v0.2 plan.

## Registration and migration

- `POST /v1/workspaces` returned `201` for `castalia-public`.
- Preview manifest: `castalia-public-abcm-docs.json` with 29 entries and 0 collisions.
- Preview manifest SHA-256: `77bf14906c9e1d9f7fc9b42fb57672d0a5d3da51ec20a7784d7d8753bacf2168`.
- Apply: 29 files uploaded through authenticated REST only: project scope, domain-language convention, `README.md`, and all 26 files under `docs/`.
- Verification: exact 29-file target set, source and target sizes/checksums equal, and source unchanged.

## MCP gate

- The connected ABCM DEV MCP listed the imported project in `castalia-public`.
- MCP read returned `abcm/docs/plans/v0.2/plan.md` with its expected checksum.
- MCP ScopeMap scan returned ready workflow `castalia-public`, ready project `abcm`, one parent-child relation, and no diagnostics.
