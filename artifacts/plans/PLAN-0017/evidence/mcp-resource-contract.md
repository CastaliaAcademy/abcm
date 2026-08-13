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
