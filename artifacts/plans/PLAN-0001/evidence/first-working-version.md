# PLAN-0001 evidence — first working version

Date: 2026-08-10
Version: `0.1.0-alpha.1`
Workspace: `/mnt/c/Users/egor/Documents/Qualia/public/abcm`

## Automated gate

Command: `bun run check`

- TypeScript no-emit check: PASS.
- Bun tests: 35 PASS, 0 FAIL, 83 assertions across 9 test files.
- Covered boundaries include path traversal, encoded traversal, Windows/absolute paths, NUL, symlink components, reserved paths, stale write/delete, move collision, payload limit, REST problems, ETags, Bearer authentication, ScopeMap topology/digest/projections, real MCP connection, real HTTP listener, and self-migration.

Command: `bun run build`

- TypeScript production build: PASS.

Commands: official `quick_validate.py` for each directory under `agents/skills`

- `implement-abcm-feature`: PASS.
- `verify-abcm-feature`: PASS.
- `migrate-project-to-abcm`: PASS.

## Real REST migration smoke

The reference CLI was started against this repository with workspace id `self`, a static Bearer token, and an ephemeral loopback port.

Observed results:

1. `GET /health` without credentials returned `200` and server version `0.1.0-alpha.1`.
2. Unauthenticated `GET .../files/content?path=scope.yaml` returned `401 AUTHENTICATION_REQUIRED` with `WWW-Authenticate: Bearer`.
3. Authenticated `POST .../scope-map/scan` returned `200`, digest `sha256:6b442af696f21e16d2284e2023eab1ca2236aaee4dce416358542a542f0afc1f`, one valid/ready workflow node, and no diagnostics.
4. Authenticated `GET .../files/content?path=scope.yaml` returned `200`, the canonical bytes, and a strong SHA-256 ETag.
5. Authenticated conditional `PUT` created `artifacts/evidence/.smoke-rest.txt`; direct and REST reads both produced `smoke-ok` with checksum `sha256:7a396dbac3c3a28fd13921f1ab5a687f97508a619a38f21b2cae09797fe8e199`.
6. Authenticated `DELETE` returned `204`; the temporary smoke file was removed.

## Migration conclusion

The repository can already be used in place as an ABCM workflow without relocating its source tree. Files can remain on a direct/network filesystem or be managed through the REST adapter over the same `WorkspaceFileService`. MCP tools use that same service boundary.

## Known limitations

- ScopeMap revisions are immutable only in process memory; SQLite publication, history, leases, and crash recovery are deferred.
- Reconciliation is an immediate full scan after an in-process mutation; filesystem watchers and cross-process coordination are deferred.
- REST has one static deployment token; principal/tenant authorization, durable audit, rate limiting, and proxy/origin hardening are deferred.
- ContextBundle/fingerprint, full domain-language resolution, automatic skill connection, and documentation-source sync/cutover are not implemented.
- The reference runtime and file reads require Bun 1.3.14+; portability to Node.js is not claimed for this alpha.
