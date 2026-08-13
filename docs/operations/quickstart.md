# Quickstart

```bash
bun install
bun run check
export ABCM_API_TOKEN='replace-with-at-least-16-characters'
export ABCM_WORKSPACE_STORE_ROOT="$PWD/.local-workspaces"
ABCM_WORKSPACE_ID=self ABCM_WORKSPACE_ROOT="$PWD" bun run dev:rest
```

To persist rebuildable ScopeMap revisions in `<workspace>/.abcm/abcm.sqlite`, add `ABCM_DERIVED_STORE_ENABLED=true`. The process takes an exclusive renewable owner lease and renews each scan lease while filesystem construction yields. Optional owner variables are `ABCM_DERIVED_STORE_OWNER_TTL_MS` and `ABCM_DERIVED_STORE_OWNER_RENEWAL_INTERVAL_MS`; scan equivalents are `ABCM_DERIVED_STORE_SCAN_LEASE_TTL_MS` and `ABCM_DERIVED_STORE_SCAN_LEASE_RENEWAL_INTERVAL_MS`. Each pair defaults to 30000/10000 milliseconds, values must be positive integers, and renewal must be shorter than TTL. Keep persistence disabled when a separate stdio MCP process points at the same workspace; the second process will otherwise be rejected as an owner conflict.

The runtime also performs a mandatory full ScopeMap reconcile every 300000 milliseconds, including for workspaces registered after startup. Set `ABCM_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS` to a positive integer and `ABCM_SCOPE_MAP_RECONCILE_DEBOUNCE_MS` to a non-negative integer when a different network-filesystem recovery interval or mutation debounce is required. SIGINT/SIGTERM stops the timer and waits for pending reconcile work before releasing SQLite ownership.

Protected REST requests default to 600 per process-local fixed minute, a 1 MiB streamed body, and a 30000 ms cooperative deadline. Set `ABCM_REST_MAX_REQUESTS_PER_MINUTE`, `ABCM_REST_MAX_REQUEST_BODY_BYTES`, and `ABCM_REST_REQUEST_TIMEOUT_MS` to bounded positive integers when deployment capacity requires different limits. Health checks are exempt; a reverse proxy remains responsible for aggregate limiting across replicas.

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

To mirror an Obsidian vault or another mounted documentation directory, enable SQLite and set `ABCM_DOCUMENTATION_SOURCES` to a JSON array of deployment-approved source roots. See the [Obsidian integration guide](../integrations/obsidian.md). Requests name only a configured source id and cannot submit a filesystem root.

For MCP stdio, configure the client command as `bun run src/cli/mcp-stdio.ts` with `ABCM_WORKSPACE_ID`, `ABCM_WORKSPACE_ROOT`, and the same optional `ABCM_WORKSPACE_STORE_ROOT`. MCP transport authentication is delegated to the embedding client/host and does not use `ABCM_API_TOKEN`.
