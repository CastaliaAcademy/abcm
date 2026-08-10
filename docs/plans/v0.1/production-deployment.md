# PLAN-0002 — castalia-prod deployment

Status: completed
Target: `castalia-prod:/home/castalia/services/abcm`
Completed: 2026-08-10

## Outcome

`0.1.0-alpha.1` runs as an isolated Docker Compose project on loopback port `8787`. The current repository documentation is materialized in a separate managed workspace through the authenticated REST file API.

## Safety boundaries

- Existing Castalia Compose projects, containers, nginx, networks, and ports were not modified.
- The deployment stays under `/home/castalia/services/abcm` because the SSH principal has no sudo access.
- The Bearer token exists only in a mode-0600 deployment environment file and is absent from Git and evidence.
- Only `scope.yaml` and `domain-language/DomainLanguageConvention.md` were bootstrapped before first startup.
- All remaining managed documents were applied through REST with `If-None-Match: *` and SHA-256 verification.
- REST is bound to `127.0.0.1`; external access requires an SSH tunnel until a separate reverse-proxy/auth decision is approved.

## Gate result

1. Docker image build: PASS from source commit `51d6a689097c550f109a421b262fddb3f3769929`.
2. Merged Compose validation: PASS.
3. Container health and explicit restart recovery: PASS.
4. Authentication boundary: PASS — public health `200`, unauthenticated file read `401`.
5. ScopeMap: PASS — one valid/ready workflow and no diagnostics.
6. Migration: PASS — 35 REST creates plus 2 verified bootstrap files; 37/37 source checksums match.
7. Idempotent replay: PASS — 35 matching files resumed, 2 bootstrap files reverified.
8. Isolation: PASS — read-only root filesystem, dropped capabilities, dedicated Docker network, loopback-only port.

Detailed evidence is stored in `artifacts/plans/PLAN-0002/evidence/production-deployment.md` and on the host under `/home/castalia/services/abcm/migration`.

## Rollback

Stop only Compose project `abcm`. Retain the workspace and manifest for diagnosis. Removing `/home/castalia/services/abcm` is a separate explicit destructive action and is not part of automatic rollback.
