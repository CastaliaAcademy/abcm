# MCP Streamable HTTP evidence — 2026-08-10

Commit under test: `734e15d` (`agent/deploy-castalia-prod`).

## RED

`bun test test/mcp-http.e2e.test.ts` failed before implementation because `runtime.httpHandler` and `runtime.close` did not exist.

## GREEN and regression

- `bun test test/mcp-http.e2e.test.ts`: 2 passed, 0 failed, 8 assertions.
- `bun run check`: 37 passed, 0 failed, 91 assertions across 10 files; strict TypeScript check passed.
- `bun run build`: passed.
- `docker build -t abcm-mcp-server:0.1.0-alpha.1 .`: passed.

## Production

- Deployment root: `/home/castalia/services/abcm`.
- Production checkout fast-forwarded to `734e15d`.
- Compose container `abcm-rest-1`: healthy, bound to `127.0.0.1:8787`.
- A real `@modelcontextprotocol/client` `StreamableHTTPClientTransport` connected to `http://127.0.0.1:8787/mcp` with the deployment Bearer token.
- `tools/list` returned 7 tools: `workspace.list_files`, `workspace.read_file`, `workspace.write_file`, `workspace.delete_file`, `workspace.move_file`, `workspace.create_directory`, and `scope_map.scan`.

## Remaining boundary

The MCP endpoint is production-live but loopback-only. Direct ChatGPT connection remains blocked on workspace-side Secure MCP Tunnel or an approved HTTPS reverse proxy and compatible authentication. The static-token alpha service was intentionally not exposed to the public internet.
