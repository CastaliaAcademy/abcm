# PLAN-0017 evidence — stable MCP resource catalog

Date: 2026-08-13
Status: PASS

## RED and GREEN

- RED showed that only the singleton `abcm://map` resource existed: capability metadata reported a high-level mutable list and document/plan/architecture/skill reads returned resource-not-found.
- The resource catalog is derived only from the active MapRevision and returns the global map, permitted scoped maps, active indexed documents, and unambiguous active skill definitions.
- Ordinary source files and executable skill resources are absent. Hidden scope ids, physical paths, and bodies do not appear in discovery or map metadata.
- Resource reads verify lifecycle, access, namespace, and the live file checksum against the indexed revision before returning exact textual bytes.
- Resource and template pages are URI-sorted and use opaque versioned cursors bound to the MapRevision/template contract digest.
- Cancellation and the configured server timeout terminate the adapter request; subscriptions remain intentionally disabled.

## Contract and regression gates

- Focused catalog suite: 4 tests, 30 assertions, 0 failures.
- Legacy 2025-11-25 plus SDK auto-negotiation Streamable HTTP suite: 8 tests, 45 assertions, 0 failures.
- Full isolated Linux/Docker `bun run check`: 112 tests, 458 assertions, 0 failures across 30 files.
- `bun run build`: PASS.

## Production artifact

- Image: `abcm-mcp-server:plan-0017`.
- Manifest list: `sha256:02fac4942bdbd6489056be4633b25bb47104b036994d8c528e62719a50dd4210`.
- Production `dist` smoke on a read-only workspace: first page contained 3 resources with a next cursor; `abcm://map` returned the agent projection.
- Existing `abcm-local` and `abcm-tunnel` containers were not restarted or replaced.

## Workspace documentation publication

The preserved local service received six PLAN-0017 documents under `castalia-public/abcm` through authenticated REST: five creates and one checksum-protected update. Byte-for-byte verification passed and a live ScopeMap scan completed with zero diagnostics. The intentionally preserved older runtime retained legacy digest `sha256:be5aa606c89e4a9cfdee6a4d1b44d1ec33012eb18a182cf7c08b54cf6d6d646a`; neither running container was replaced or restarted.
