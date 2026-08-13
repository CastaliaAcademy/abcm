# REST file API

Configure the primary workspace with `ABCM_WORKSPACE_ID`, `ABCM_WORKSPACE_ROOT`, and a bearer secret of at least 16 characters in `ABCM_API_TOKEN`. To allow the server to create additional workspaces, configure a writable `ABCM_WORKSPACE_STORE_ROOT`; the server derives every managed workspace root below it and discovers existing managed workspaces on restart.

`GET /health` is public. Every `/v1` endpoint requires `Authorization: Bearer <ABCM_API_TOKEN>`.

- `GET /v1/workspaces/{id}/files?path=&recursive=false`
- `POST /v1/workspaces` with strict JSON `{ "id": "portable-id", "name": "Optional name" }`
- `GET /v1/workspaces/{id}/files/content?path=...`
- `PUT /v1/workspaces/{id}/files/content?path=...`
- `DELETE /v1/workspaces/{id}/files?path=...`
- `POST /v1/workspaces/{id}/files/move`
- `POST /v1/workspaces/{id}/directories`
- `POST /v1/workspaces/{id}/scope-map/scan`
- `GET /v1/workspaces/{id}/scope-map?view=agent|admin`
- `POST /v1/context/domain-language` with strict JSON `{ "anchor": { "workspaceId": "id", "projectId": "id-or-alias" }, "roleId": "optional" }`
- `POST /v1/context/build-task-context` with strict JSON `{ "domainLanguageBootstrapId": "...", "roleId": "executor-agent", "taskType": "feature-implementation", "goal": "..." }`
- `POST /v1/workspaces/{id}/documentation-sources/preview` with strict JSON `{ "sourceId": "configured-id" }`
- `POST /v1/documentation-imports/{importId}/apply`
- `POST /v1/documentation-sources/{sourceId}/sync`

The scan endpoint returns the published revision summary plus aggregate `resourceSummary` counts. Internal `FileRecord`, `DocumentRecord`, and `ExecutableResourceRecord` arrays are not exposed through REST map responses.

The domain-language endpoint requires an active ScopeMap plus `scope.discover`, `scope.read_metadata`, and `context.build`. It returns a short-lived principal-, revision-, and checksum-bound workflow-plus-project bootstrap without loading service/feature conventions or raw source bodies.

The context-build endpoint validates that bootstrap against the same principal and active revision, resolves service/feature language and skills, applies `document.read`, projection, lifecycle, and mandatory-first budget rules, then atomically writes a body-free fingerprint under the reserved `.abcm` tree. Mandatory access failures return `REQUIRED_CONTEXT_ACCESS_DENIED`; mandatory hard-limit overflow returns `REQUIRED_CONTEXT_EXCEEDS_LIMIT`. REST and MCP invoke the same `ContextBuilder` service.

Reads return strong SHA-256 ETags. Writes accept `If-Match`; creates accept `If-None-Match: *`. File bodies are raw bytes. JSON errors use `application/problem+json` and stable ABCM codes.

Workspace registration returns `201` after creating a minimal workflow scaffold. It returns `409 WORKSPACE_ALREADY_EXISTS` without changing a registered or pre-existing target. Supplying `root`, `path`, or any unknown field returns `400 REQUEST_INVALID`; if no managed store is configured, registration returns `503 WORKSPACE_REGISTRATION_DISABLED`.

Directory documentation sources are deployment-owned and require SQLite persistence. Preview is non-mutating and returns checksum-pinned create/update/delete/unchanged/conflict operations. Apply rejects stale snapshots or targets. `sync` performs an immediate preview/apply. Active mirrors remain readable but general write/delete/move endpoints return `409 MIRROR_DOCUMENT_READ_ONLY`. See the [Obsidian integration guide](../integrations/obsidian.md).

The alpha server uses one static deployment token mapped to a deployment-owned context principal. External identity-provider integration and audit persistence remain later milestones.
