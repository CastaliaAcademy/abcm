# MCP API

The stdio and Streamable HTTP transports expose `workspace.list_files`, `workspace.read_file`, `workspace.write_file`, `workspace.delete_file`, `workspace.move_file`, `workspace.create_directory`, and `scope_map.scan`. When directory documentation sources are configured, they also expose `documentation_source.preview`, `documentation_source.apply`, and `documentation_source.sync`; all three delegate to the same service as REST. Active mirrors reject general file mutations with `MIRROR_DOCUMENT_READ_ONLY`.

`abcm://map` returns the default workspace agent projection. `scope_map.scan` returns a safe revision summary with aggregate index counts; internal file, document, and executable-resource paths are not serialized. File reads use base64 to preserve exact bytes. The HTTP endpoint is `/mcp`; see [MCP Streamable HTTP API](mcp-http-api.md) and the [Obsidian integration guide](../integrations/obsidian.md).
