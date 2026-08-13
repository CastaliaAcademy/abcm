# Runnable examples

Build the package first with `bun run build`.

- `bun run examples/library.ts` scans `ABCM_WORKSPACE_ROOT` (or the current directory) through the public package entrypoint and prints a bounded summary.
- `bash examples/rest-server.sh` starts the packaged REST and Streamable HTTP MCP reference server.
- `bash examples/mcp-stdio.sh` starts the packaged stdio MCP reference server.

The HTTP example requires `ABCM_API_TOKEN` with at least 16 characters. All examples default to the current directory as one workspace and can be overridden with `ABCM_WORKSPACE_ID` and `ABCM_WORKSPACE_ROOT`.
