# PLAN-0019 evidence — MCP cancellation and operation deadlines

Date: 2026-08-13
Status: PASS

## Delivered behavior

- A combined request/deadline signal enters every MCP tool application call and every resource read/list path.
- File reads and scans check between entries; writes check after authorization and immediately before atomic rename/unlink/move/mkdir.
- ScopeMap propagates the signal through content indexing and checks it before active-revision publication.
- Domain language, path resolution, skill materialization, and ContextBundle construction check before publishing derived state.
- Documentation preview checks before plan insertion. Apply/sync check throughout validation and become non-preemptible at the first mirror mutation.
- `ABCM_MCP_OPERATION_TIMEOUT_MS` configures the default 30000 ms deadline for stdio and Streamable HTTP; capability metadata exposes the effective value.

## Focused evidence

- Six operation-control tests cover queued file cancellation, no map publication, documentation pre/post-commit behavior, no derived context state, stable timeout mapping, and real-client cancellation forwarding.
- Targeted regression across files, map, language/path/skills/context, documentation, MCP tools and resources: 40 tests, 265 assertions, 0 failures before final operation-control additions.

## Full regression and artifact

- Full isolated Linux/Docker `bun run check`: 120 tests, 572 assertions, 0 failures across 32 files.
- Production build: PASS in the final multi-stage image.
- Image: `abcm-mcp-server:plan-0019`.
- Manifest list: `sha256:5ed979b9c7f90856ea9cf0e27179ec00b1878ada5ae070339176d1e472653e82`.
- Final-image composition accepted the configured 5 ms deadline and constructed the production `McpServer`.
- Existing `abcm-local` and `abcm-tunnel` containers were not restarted or replaced.
