# PLAN-0018 evidence — structured MCP tools and stable errors

Date: 2026-08-13
Status: PASS

## Delivered contract

- Twelve public tools register strict input and output schemas from `ABCM_MCP_TOOL_SCHEMAS`.
- Tool output validation covers file metadata/content, map summaries, language bootstraps, context bundles, documentation previews, and synchronization results.
- Expected application failures preserve the stable ABCM code/message/safe details envelope; cancellation has its own code and unexpected errors are redacted to INTERNAL_ERROR.
- `abcm.dev/contract` capability metadata declares contract 0.1.0, specification 0.5.0, MCP 2025-11-25, and error encoding v1.
- Every tool rejects an unknown-only payload through the SDK validation seam; error cases cover every operation family.
- Real MCP client happy paths cover all workspace operations, ScopeMap scan, domain language, context build, and documentation preview/apply/sync.

## Verification and artifact

- Full isolated Linux/Docker `bun run check`: 114 tests, 552 assertions, 0 failures across 31 files.
- Production TypeScript build: PASS as part of the final multi-stage image.
- Image: `abcm-mcp-server:plan-0018`.
- Manifest list: `sha256:0acd13fcb9236f81113c304c414202a3f270d007c5785336747a5b49ea7a6457`.
- Final-image `dist` smoke exported exactly 12 schema pairs, protocol 2025-11-25, and constructed `McpServer` successfully.
- Existing `abcm-local` and `abcm-tunnel` containers were not restarted or replaced.
