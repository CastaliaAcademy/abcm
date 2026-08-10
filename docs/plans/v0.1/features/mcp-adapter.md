# Feature plan — MCP adapter

Register tools `workspace.list_files`, `workspace.read_file`, `workspace.write_file`, `workspace.delete_file`, `workspace.move_file`, `workspace.create_directory`, and `scope_map.scan`. Register `abcm://map` as a resource. All callbacks delegate to the application services used by REST and return structured content plus stable ABCM errors.
