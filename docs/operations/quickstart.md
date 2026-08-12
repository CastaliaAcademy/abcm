# Quickstart

```bash
bun install
bun run check
export ABCM_API_TOKEN='replace-with-at-least-16-characters'
export ABCM_WORKSPACE_STORE_ROOT="$PWD/.local-workspaces"
ABCM_WORKSPACE_ID=self ABCM_WORKSPACE_ROOT="$PWD" bun run dev:rest
```

To persist rebuildable ScopeMap revisions in `<workspace>/.abcm/abcm.sqlite`, add `ABCM_DERIVED_STORE_ENABLED=true`. Use it only with a writable workspace and one owning process; keep it disabled when a separate stdio MCP process points at the same workspace.

The same process serves REST and authenticated Streamable HTTP MCP at `/mcp`. Then call:

```bash
curl http://127.0.0.1:8787/health
curl -H "Authorization: Bearer $ABCM_API_TOKEN" \
  -X POST http://127.0.0.1:8787/v1/workspaces/self/scope-map/scan
curl -H "Authorization: Bearer $ABCM_API_TOKEN" \
  'http://127.0.0.1:8787/v1/workspaces/self/files/content?path=scope.yaml'
curl -H "Authorization: Bearer $ABCM_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"castalia-public","name":"Castalia Public"}' \
  http://127.0.0.1:8787/v1/workspaces
```

For remote MCP, configure a Streamable HTTP client with URL `http://127.0.0.1:8787/mcp` and the same Bearer token. See [the HTTP MCP API](../api/mcp-http-api.md).

For MCP stdio, configure the client command as `bun run src/cli/mcp-stdio.ts` with `ABCM_WORKSPACE_ID`, `ABCM_WORKSPACE_ROOT`, and the same optional `ABCM_WORKSPACE_STORE_ROOT`. MCP transport authentication is delegated to the embedding client/host and does not use `ABCM_API_TOKEN`.
