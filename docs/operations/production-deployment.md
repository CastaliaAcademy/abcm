# Production deployment

The reference production layout is:

```text
/home/castalia/services/abcm/
├── .env                  # mode 0600; contains the deployment token
├── app/                  # Git checkout
├── migration/            # retained checksum manifest and evidence
└── workspace/            # canonical managed documents
```

Run Compose from the deployment root:

```bash
docker compose \
  --env-file .env \
  -f app/deploy/compose.config.yaml \
  -f app/deploy/compose.service.yaml \
  up -d --build
```

The release image tag is `abcm-mcp-server:0.1.0`. The Compose defaults use the service-owned `castalia-public` workspace at `/workspaces/castalia-public`; project documents live below `/workspaces/castalia-public/abcm` and are addressed through REST/MCP rather than the read-only source checkout. Override `ABCM_WORKSPACE_ID` and `ABCM_WORKSPACE_ROOT` only for a different managed workspace. Streamable HTTP MCP is enabled by default and can be disabled explicitly with `ABCM_MCP_ENABLED=false`.

To attach an already mounted Obsidian vault as a read-only source, add `-f app/deploy/compose.obsidian.yaml` and the documentation variables described in the [Obsidian integration guide](../integrations/obsidian.md). The managed target workspace must exist before the source-enabled runtime starts.

The Compose profile enables the default 50 ms mutation debounce and 300000 ms periodic full ScopeMap reconcile. A shorter interval repairs missed SMB/NFS metadata changes sooner but performs more complete filesystem scans. Keep the interval comfortably above the measured full-scan duration; overlapping ticks are coalesced per workspace.

The same profile passes explicit REST defaults of 1 MiB per streamed body, 30000 ms per request, and 600 protected requests per process-local fixed minute. Override `ABCM_REST_MAX_REQUEST_BODY_BYTES`, `ABCM_REST_REQUEST_TIMEOUT_MS`, or `ABCM_REST_MAX_REQUESTS_PER_MINUTE` in the deployment environment after capacity testing. Multi-replica aggregate limiting belongs at the ingress because the application limiter is intentionally process-local.

The production profile exposes `127.0.0.1:8787` only. Connect from an operator workstation with an SSH tunnel rather than publishing the static-token alpha API directly:

```bash
ssh -L 8787:127.0.0.1:8787 castalia-prod
```

Do not place `ABCM_API_TOKEN` in shell history, Git, Compose YAML, logs, or migration evidence. Rotate it by replacing the deployment `.env` value and recreating only the `abcm-rest-1` container.
