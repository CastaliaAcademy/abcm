# Quickstart

```bash
bun install
bun run check
export ABCM_API_TOKEN='replace-with-at-least-16-characters'
ABCM_WORKSPACE_ID=self ABCM_WORKSPACE_ROOT="$PWD" bun run dev:rest
```

The same process serves REST and authenticated Streamable HTTP MCP at `/mcp`. Then call:

```bash
curl http://127.0.0.1:8787/health
curl -H "Authorization: Bearer $ABCM_API_TOKEN" \
  -X POST http://127.0.0.1:8787/v1/workspaces/self/scope-map/scan
curl -H "Authorization: Bearer $ABCM_API_TOKEN" \
  'http://127.0.0.1:8787/v1/workspaces/self/files/content?path=scope.yaml'
```

For remote MCP, configure a Streamable HTTP client with URL `http://127.0.0.1:8787/mcp` and the same Bearer token. See [the HTTP MCP API](../api/mcp-http-api.md).

For MCP stdio, configure the client command as `bun run src/cli/mcp-stdio.ts` with `ABCM_WORKSPACE_ID` and `ABCM_WORKSPACE_ROOT`. MCP transport authentication is delegated to the embedding client/host and does not use `ABCM_API_TOKEN`.
