# REST file API

Configure one workspace with `ABCM_WORKSPACE_ID`, `ABCM_WORKSPACE_ROOT`, and a bearer secret of at least 16 characters in `ABCM_API_TOKEN`.

`GET /health` is public. Every `/v1` endpoint requires `Authorization: Bearer <ABCM_API_TOKEN>`.

- `GET /v1/workspaces/{id}/files?path=&recursive=false`
- `GET /v1/workspaces/{id}/files/content?path=...`
- `PUT /v1/workspaces/{id}/files/content?path=...`
- `DELETE /v1/workspaces/{id}/files?path=...`
- `POST /v1/workspaces/{id}/files/move`
- `POST /v1/workspaces/{id}/directories`
- `POST /v1/workspaces/{id}/scope-map/scan`
- `GET /v1/workspaces/{id}/scope-map?view=agent|admin`

Reads return strong SHA-256 ETags. Writes accept `If-Match`; creates accept `If-None-Match: *`. File bodies are raw bytes. JSON errors use `application/problem+json` and stable ABCM codes.

The alpha server uses one static deployment token. Per-workspace principals, roles, and audit persistence remain later milestones.
