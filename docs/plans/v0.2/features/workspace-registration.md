# Feature plan — managed workspace registration

Requirements: WSR-001..006. Acceptance: AC-WSR-*.

## TDD sequence

1. RED registration contract for a new workspace and immediate file access.
2. RED invalid id, forbidden root/path fields, duplicate id, and disabled-store problems.
3. GREEN dynamic registry and server-owned provisioning below the configured store.
4. RED restart discovery of a previously provisioned workspace.
5. GREEN CLI discovery and runtime composition for multiple workspace definitions.
6. Full check, build, authenticated HTTP smoke, migration preview, apply, checksum comparison, and MCP verification.

## Security boundaries

- The request contains only `id` and optional `name`.
- The server computes the physical root from `ABCM_WORKSPACE_STORE_ROOT`.
- Existing directories and registry ids are never overwritten.
- Workspace deletion and recursive import are separate operations and remain excluded.
