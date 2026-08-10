# PLAN-0002 evidence — castalia-prod deployment

Date: 2026-08-10
Target: `/home/castalia/services/abcm`
Source commit: `51d6a689097c550f109a421b262fddb3f3769929`

## Preflight

- SSH host key matched the key already trusted by Windows OpenSSH.
- Principal: `castalia`, no sudo, member of the `docker` group.
- Deployment root did not exist; `/home/castalia/services` was writable.
- Docker 29.6.0 was available; port `8787` was free; 92 GiB disk space was available.
- Existing Compose projects and port bindings were inventoried before deployment.

## Build and runtime

- Local gates: `bun run check` PASS with 35 tests and 83 assertions; `bun run build` PASS; merged Compose configuration PASS.
- Production image: `abcm-mcp-server:0.1.0-alpha.1`.
- Container: `abcm-rest-1`, healthy after initial start and after an explicit restart.
- Runtime boundaries: read-only root filesystem, `cap_drop=[ALL]`, `no-new-privileges`, `restart=unless-stopped`.
- Network boundary: dedicated `abcm_default` network and `127.0.0.1:8787` host binding.
- Health response reported server `0.1.0-alpha.1` and specification `0.5.0`; unauthenticated file access returned `401`.

## Document migration

- Preview selected 37 committed files from `README.md`, `scope.yaml`, `docs/`, `config/`, `domain-language/`, `agents/`, and `artifacts/`.
- Largest file was 165383 bytes, below the configured 1 MiB write limit.
- Staging checksums matched the retained source manifest; target collision count was zero.
- Two mandatory root files were bootstrapped and then read back through REST with matching checksums.
- The REST migration created 35 files and verified all target SHA-256 values against the source manifest.
- Idempotent replay reported `created=0`, `resumed=35`, `verifiedExisting=2`, `sourceFiles=37`, `status=passed`.
- ScopeMap digest: `sha256:6b442af696f21e16d2284e2023eab1ca2236aaee4dce416358542a542f0afc1f`.
- ScopeMap result: one `abcm-development` workflow node with `status=valid`, `readiness=ready`, and no diagnostics.

Production-retained evidence:

- `migration/abcm-prod-migration-manifest.tsv`
- `migration/abcm-prod-checksums.sha256`
- `migration/initial-apply-result.json`
- `migration/apply-result.json`
- `migration/scope-map.json`
- `migration/file-list.json`

## Existing-service observation

During the final inventory, `castalia-api-1` briefly reported Docker health `unhealthy` while its process remained running with restart count zero. Readiness probes subsequently returned `200` with all dependencies `ok`, and Docker returned the container to `healthy` without intervention. It remains on the separate `castalia` network; ABCM is the sole member of `abcm_default`.

## Access

REST is intentionally not public. Operators connect with an SSH tunnel to `127.0.0.1:8787`; the Bearer token remains only in the production mode-0600 `.env` file and is not recorded here.
