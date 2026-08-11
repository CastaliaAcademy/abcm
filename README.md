# ABCM MCP Server

TypeScript/Bun library and runnable server for exposing [Agent Build Context Manager](docs/spec/abcm-mvp-agent-spec-v0.5.yaml) workspaces through MCP over stdio and Streamable HTTP, plus an authenticated REST file API.

## Status

`0.1.0-alpha.1` is the first working migration target. It provides:

- bounded workflow and scope-map discovery;
- safe, atomic workspace file list/read/write/delete/move/directory operations;
- server-owned workspace registration below a configured managed store, including restart discovery;
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

Scope-map revisions are kept in memory; SQLite history, ContextBundle assembly, domain resolution, document synchronization, per-principal authorization, and durable audit records are later milestones.

## License

[MIT](LICENSE)
