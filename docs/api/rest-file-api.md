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

Reads return strong SHA-256 ETags. Writes accept `If-Match`; creates accept `If-None-Match: *`. File bodies are raw bytes. JSON errors use `application/problem+json` and stable ABCM codes.

Workspace registration returns `201` after creating a minimal workflow scaffold. It returns `409 WORKSPACE_ALREADY_EXISTS` without changing a registered or pre-existing target. Supplying `root`, `path`, or any unknown field returns `400 REQUEST_INVALID`; if no managed store is configured, registration returns `503 WORKSPACE_REGISTRATION_DISABLED`.

The alpha server uses one static deployment token. Per-workspace principals, roles, and audit persistence remain later milestones.
