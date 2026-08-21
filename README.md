# ABCM MCP Server

ABCM is an MCP and REST server library for managed agent-context workspaces.

The source checkout contains code only. Canonical project documentation is stored in the ABCM workspace `castalia-public`, project `abcm`. Its pinned service revision is recorded in `abcm-documentation.lock.json`.

To materialize the exact documentation snapshot for development or release validation:

```bash
ABCM_API_TOKEN=... bun run documentation:export
```

The default local endpoints are `http://127.0.0.1:8787` for REST and `http://127.0.0.1:8787/mcp` for MCP. Override the documentation service URL with `ABCM_BASE_URL`.

For Obsidian, open the managed project directory as a vault:

```text
C:\Users\egor\Documents\Qualia\castalia\документация\Castalia\public\abcm
```

This direct-folder mode is different from the bidirectional `abcm-obsidian-plugin`, which maps one vault folder to one server-assigned `workspaceId/projectId` through the scoped REST sync API. Obsidian device operations are not MCP tools; MCP remains the agent interface. The canonical integration guide is `docs/integrations/obsidian.md` in the ABCM workspace.

To import an independently managed Obsidian vault, select a separate source directory and enable the documentation overlay:

```bash
ABCM_DOCUMENTATION_SOURCE_PATH=/absolute/path/to/selected-vault \
docker compose \
  -f deploy/compose.config.yaml \
  -f deploy/compose.service.yaml \
  -f deploy/compose.obsidian.yaml \
  up -d
```

The selected directory is mounted read-only. It must not equal, contain, or be contained by the canonical workspace directory, including after symbolic links are resolved. Agents cannot provide or change this absolute path through REST or MCP; they operate only on the configured `sourceId`.

When the selected directory is a legacy corpus that has already been normalized into ABCM, configure fail-closed reconciliation. A workspace-owned manifest pins every `sourcePath` to one canonical `targetPath` plus both checksums. `adopt-existing` records provenance without overwriting the canonical bytes. Missing entries, changed checksums, duplicate targets, and absent targets are conflicts; the fallback import directory is never populated in this mode.

Centralized outcome, feedback, business-evaluation, and task-success APIs are intentionally absent. ABCM does not collect package ratings or model outputs. Repository-local fixtures and Docker benchmark runners remain available to ABCM developers and do not persist data in the service. Documentation lifecycle tools appear only when operator-selected directories are configured.

To publish the complete 39-tool runtime, including documentation lifecycle for both managed workspaces, use the full-capabilities overlay instead of the documentation-only overlay:

```bash
docker compose \
  --env-file .env.local \
  --env-file .env.full-capabilities \
  -f deploy/compose.config.yaml \
  -f deploy/compose.service.yaml \
  -f deploy/compose.full-capabilities.yaml \
  up -d --build
```

When the local service is exposed through OpenAI Secure MCP Tunnel, create its shared Docker network once and include the tunnel overlay on every service replacement:

```bash
docker network create abcm-runtime
docker compose \
  --env-file .env.local \
  --env-file .env.full-capabilities \
  -f deploy/compose.config.yaml \
  -f deploy/compose.service.yaml \
  -f deploy/compose.full-capabilities.yaml \
  -f deploy/compose.secure-mcp-tunnel.yaml \
  up -d --build
```

The overlay keeps the REST container on the tunnel network under the internal name `abcm-local` and admits that hostname at the MCP Host boundary. Restart tunnel-client after the REST container becomes healthy. Omitting this overlay while replacing the service leaves ChatGPT discovery with a tunnel-side `502` or `Forbidden` response.

Set `ABCM_DOCUMENTATION_PUBLIC_SOURCE_PATH`, `ABCM_DOCUMENTATION_PRIVATE_SOURCE_PATH`, and the separate `ABCM_ARTIFACT_AMENDMENT_OPERATOR_TOKEN` in an ignored operator-owned environment file. The operator token must differ from the agent API token. Restart a long-lived tunnel or connector after the runtime version or tool configuration changes so it performs a new MCP initialization and `tools/list`.

ABCM domain failures are completed typed MCP outcomes: `structuredContent.error_code` is the stable discriminator and the JSON text `code` must be equal. `isError=true` remains reserved for schema/protocol and unexpected server failures, which prevents managed connectors from replacing an ABCM domain code with a generic connector code.

Markdown tags are the source of link packages. Use frontmatter such as `tags: [architecture, control-plane]` or inline tags such as `#architecture`. On the next ScopeMap scan, ABCM exposes one virtual LinkPackage per normalized tag. File create, update, move, delete, batch apply, and documentation sync therefore update packages without a separate publish/rebase lifecycle. Package identifiers never grant access; every build is bound to its workspace and reauthorizes every selected document.

This local environment is a single-version development runtime, not production. After the replacement container is healthy and `bun run runtime:inspect` succeeds, remove stopped containers and versioned images of the previous ABCM server iteration. Preserve the current container/image, `abcm-state`, the tunnel, and the separate `abcm-mcp-server:benchmark` image. A retained Docker rollback version requires an explicit future parallel-version or production policy.
