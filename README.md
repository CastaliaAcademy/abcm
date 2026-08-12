# ABCM MCP Server

TypeScript/Bun library and runnable server for exposing [Agent Build Context Manager](docs/spec/abcm-mvp-agent-spec-v0.5.yaml) workspaces through MCP over stdio and Streamable HTTP, plus an authenticated REST file API.

## Status

`0.1.0-alpha.1` is the first working migration target. It provides:

- bounded workflow and scope-map discovery;
- safe, atomic workspace file list/read/write/delete/move/directory operations;
- server-owned workspace registration below a configured managed store, including restart discovery;
- opt-in rebuildable SQLite persistence for ScopeMap revisions, leases, atomic publication, and metadata-only file/document/executable-resource indexes;
- REST access with ETags, stable problem responses, and static Bearer authentication;
- MCP tools and the `abcm://map` resource over stdio and authenticated Streamable HTTP, backed by the same application services;
- self-hosting ABCM metadata, feature plans, verification plans, and reusable project skills.

The normative baseline is specification 0.5.0 plus the extensions in [docs/spec/extensions](docs/spec/extensions). The executed plan is [PLAN-0001](docs/plans/v0.1/plan.md).

## Requirements

- Bun 1.3.14 or newer

## Verify

```bash
bun install
bun run check
bun run build
```

## Run HTTP server

```bash
export ABCM_API_TOKEN='replace-with-at-least-16-characters'
ABCM_WORKSPACE_STORE_ROOT="$PWD/.local-workspaces" ABCM_WORKSPACE_ID=self ABCM_WORKSPACE_ROOT="$PWD" bun run dev:rest
```

Set `ABCM_DERIVED_STORE_ENABLED=true` when the runtime has write access to `<workspace>/.abcm`. The runtime acquires and renews an exclusive owner lease; a second SQLite-enabled process is rejected until graceful release or lease expiry. Long-running ScopeMap scans independently renew their scan lease, and loss of that lease prevents stale publication. Owner and scan TTL/renewal pairs default to 30000/10000 milliseconds and can be configured with `ABCM_DERIVED_STORE_OWNER_TTL_MS`, `ABCM_DERIVED_STORE_OWNER_RENEWAL_INTERVAL_MS`, `ABCM_DERIVED_STORE_SCAN_LEASE_TTL_MS`, and `ABCM_DERIVED_STORE_SCAN_LEASE_RENEWAL_INTERVAL_MS`. The feature remains disabled by default because separate local REST and stdio tunnel processes must not share one workspace database.

`GET /health` is public. All `/v1` routes and the `/mcp` Streamable HTTP endpoint require `Authorization: Bearer <token>`. See the [REST API](docs/api/rest-file-api.md), [HTTP MCP API](docs/api/mcp-http-api.md), and [quickstart](docs/operations/quickstart.md).

## Run MCP stdio

```bash
ABCM_WORKSPACE_STORE_ROOT="$PWD/.local-workspaces" ABCM_WORKSPACE_ID=self ABCM_WORKSPACE_ROOT="$PWD" bun run dev:mcp
```

See the [MCP API](docs/api/mcp-api.md).

## Library entrypoint

```ts
import { createAbcmRuntime } from "abcm-mcp-server";

const runtime = createAbcmRuntime(
  { id: "project", root: "/absolute/project/path" },
  { bearerToken: process.env.ABCM_API_TOKEN, workspaceStoreRoot: "/absolute/managed-workspaces" },
);
```

## Alpha boundaries

Scope-map revisions and MAP-P4 metadata indexes can be persisted in rebuildable SQLite when explicitly enabled. ContextBundle assembly, domain resolution, documentation synchronization/provenance, per-principal authorization, and durable audit records are later milestones. Ordinary source files are not indexed by default, and public map responses expose only aggregate content-index counts.

## License

[MIT](LICENSE)
