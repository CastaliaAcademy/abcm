# ABCM MCP Server

TypeScript/Bun library and runnable server for exposing [Agent Build Context Manager](docs/spec/abcm-mvp-agent-spec-v0.5.yaml) workspaces through MCP over stdio and Streamable HTTP, plus an authenticated REST file API.

## Status

`0.1.0` is the first public release candidate. It provides:

- bounded workflow and scope-map discovery;
- safe, atomic workspace file list/read/write/delete/move/directory operations;
- server-owned workspace registration below a configured managed store, including restart discovery;
- opt-in rebuildable SQLite persistence for ScopeMap revisions, leases, atomic publication, and metadata-only file/document/executable-resource indexes;
- one-way Markdown mirroring from server-configured local or mounted network directories, with mapping, preview/apply/sync, provenance, identity-preserving moves, tombstones, read-only protection, and operator-approved managed cutover;
- runtime-owned periodic full ScopeMap reconciliation, per-workspace scan serialization, and debounced mutation rebuilds for missed network-filesystem events;
- REST access with ETags, stable problem responses, and static Bearer authentication;
- process-local REST rate limiting, bounded streamed request bodies, and cooperative request deadlines/cancellation;
- MCP tools and the `abcm://map` resource over stdio and authenticated Streamable HTTP, backed by the same application services;
- principal-bound workflow-plus-project DomainLanguageBootstrap through REST and MCP before task path resolution;
- deterministic access-bounded ScopePath resolution with exact/artifact/path/language/relation/keyword tiers and one local-language retry;
- compact SkillDescriptor indexing and deterministic global/scope/by-link/by-description/manual connection with post-selection body loading;
- deterministic `buildTaskContext` over REST and MCP with mandatory-first authorization/budgeting, per-document projections, immutable bundle digests, and body-free fingerprints under the reserved `.abcm` derived tree;
- fixed body-free audit events and bounded metrics through an optional failure-isolated `AbcmObservability` port;
- normative placement diagnostics and API-level mutation protection for accepted ADR/RFC content while preserving checksum-stable rename identity;
- self-hosting ABCM metadata, feature plans, verification plans, and reusable project skills.

The normative baseline is specification 0.5.0 plus the extensions in [docs/spec/extensions](docs/spec/extensions). The executed plan is [PLAN-0001](docs/plans/v0.1/plan.md).

## Requirements

- Bun 1.3.14 or newer (the reference SQLite runtime does not claim Node.js support)

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

Every runtime performs a full reconcile of all currently registered workspaces every 300000 milliseconds by default. Configure `ABCM_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS` with a positive safe integer and `ABCM_SCOPE_MAP_RECONCILE_DEBOUNCE_MS` with a non-negative safe integer. Reconcile rebuilds and atomically publishes a complete revision; it never patches the active map.

The reference HTTP token and stdio client use a deployment-owned principal profile. Override its id with `ABCM_CONTEXT_PRINCIPAL_ID` and its comma-separated permissions with `ABCM_CONTEXT_PERMISSIONS`; the default alpha profile grants all six declared permissions. Library consumers can supply narrower global or per-scope grants through `contextPrincipal` and `scopeMapAccess`.

`GET /health` is public. All `/v1` routes and the `/mcp` Streamable HTTP endpoint require `Authorization: Bearer <token>`. See the [REST API](docs/api/rest-file-api.md), [HTTP MCP API](docs/api/mcp-http-api.md), and [quickstart](docs/operations/quickstart.md).

REST defaults are 1 MiB per request body, 30 seconds per request, and 600 protected requests per process-local minute. Override them with `ABCM_REST_MAX_REQUEST_BODY_BYTES`, `ABCM_REST_REQUEST_TIMEOUT_MS`, and `ABCM_REST_MAX_REQUESTS_PER_MINUTE`.

Library workspaces also default to a 1 MiB indexing limit. Set `WorkspaceDefinition.maxIndexBytes` to skip larger managed files before body allocation. See the [threat model](docs/security/threat-model.md) and [observability guide](docs/operations/observability.md).

## Run MCP stdio

```bash
ABCM_WORKSPACE_STORE_ROOT="$PWD/.local-workspaces" ABCM_WORKSPACE_ID=self ABCM_WORKSPACE_ROOT="$PWD" bun run dev:mcp
```

See the [MCP API](docs/api/mcp-api.md).

Release consumers can also inspect the [0.1.0 changelog](CHANGELOG.md), [complete traceability manifest](docs/release/traceability-v0.1.0.yaml), [known gaps](docs/release/known-gaps-v0.1.0.md), [package provenance](docs/release/provenance.md), [CycloneDX SBOM](docs/release/sbom.cdx.json), [large-fixture benchmark](docs/performance/benchmark-v0.1.md), and [runnable examples](examples/README.md).

## Library entrypoint

```ts
import { createAbcmRuntime } from "abcm-mcp-server";

const runtime = createAbcmRuntime(
  { id: "project", root: "/absolute/project/path" },
  { bearerToken: process.env.ABCM_API_TOKEN, workspaceStoreRoot: "/absolute/managed-workspaces" },
);
```

Directory sources require SQLite persistence and are configured only by the deployment through `ABCM_DOCUMENTATION_SOURCES`; requests cannot provide host paths. See the [Obsidian integration guide](docs/integrations/obsidian.md).

## Alpha boundaries

Scope-map revisions, MAP-P4 metadata indexes, and body-free ContextBundle/ContextFingerprint catalog records can be persisted in rebuildable SQLite when explicitly enabled. DomainLanguageBootstrap is currently in-memory and deployment-principal-bound. External identity providers, durable audit storage, executable-resource activation, and automatic documentation watchers remain later milestones. Ordinary source files are not indexed by default, and public map responses expose only aggregate content-index counts.

## License

[MIT](LICENSE)
