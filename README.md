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
C:\Users\egor\Documents\Qualia\ABCM Workspaces\castalia-public\abcm
```
