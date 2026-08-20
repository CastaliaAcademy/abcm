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

With the default durable store enabled, outcome and feedback tools are available. Business-evaluation tools require an operator-owned profile; task-success additionally requires a separate worker token and state root. Documentation lifecycle tools appear only when the directory overlay is configured.

To publish the complete 42-tool runtime, use the full-capabilities overlay instead of the documentation-only overlay:

```bash
docker compose \
  --env-file .env.local \
  --env-file .env.full-capabilities \
  -f deploy/compose.config.yaml \
  -f deploy/compose.service.yaml \
  -f deploy/compose.full-capabilities.yaml \
  up -d --build
```

Set `ABCM_BUSINESS_EVALUATION_PROFILES_PATH`, `ABCM_BUSINESS_EVALUATION_WORKER_TOKEN`, and `ABCM_DOCUMENTATION_SOURCE_PATH` in an ignored operator-owned environment file. The repository includes a qualification-only Castalia profile at `deploy/castalia-public-evaluation-profiles.yaml`; it is not an approval to promote benchmark results. Restart a long-lived tunnel or connector after the runtime version or tool configuration changes so it performs a new MCP initialization and `tools/list`.
