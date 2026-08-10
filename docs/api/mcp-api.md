# MCP API

The stdio and Streamable HTTP transports expose `workspace.list_files`, `workspace.read_file`, `workspace.write_file`, `workspace.delete_file`, `workspace.move_file`, `workspace.create_directory`, and `scope_map.scan`. `abcm://map` returns the default workspace agent projection. File reads use base64 to preserve exact bytes. The HTTP endpoint is `/mcp`; see [MCP Streamable HTTP API](mcp-http-api.md).
