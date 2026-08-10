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

The production profile exposes `127.0.0.1:8787` only. Connect from an operator workstation with an SSH tunnel rather than publishing the static-token alpha API directly:

```bash
ssh -L 8787:127.0.0.1:8787 castalia-prod
```

Do not place `ABCM_API_TOKEN` in shell history, Git, Compose YAML, logs, or migration evidence. Rotate it by replacing the deployment `.env` value and recreating only the `abcm-rest-1` container.
