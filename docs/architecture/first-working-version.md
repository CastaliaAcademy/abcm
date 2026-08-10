# Architecture — first working version

`WorkspaceRegistry` authorizes workspace ids and roots. `WorkspaceFileService` owns all file semantics. `ScopeMapService` scans through the root boundary. REST and MCP are thin adapters. A successful file mutation calls an injected reconciler; the reference composition performs an immediate full scan. This preserves one behavior path while SQLite staging and incremental reconciliation are added later.

The public REST handler uses web-standard Request/Response and therefore runs under Bun, Deno, workers, or a Node adapter. The reference CLI uses Bun.serve.
