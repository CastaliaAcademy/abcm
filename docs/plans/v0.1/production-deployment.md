# PLAN-0002 — castalia-prod deployment

Status: executing
Target: `castalia-prod:/home/castalia/services/abcm`

## Outcome

Run `0.1.0-alpha.1` as an isolated Docker Compose project, bind REST to loopback port `8787`, and materialize the current repository documentation in a separate managed workspace through the authenticated REST file API.

## Safety boundaries

- Do not modify existing Castalia Compose projects, containers, nginx, networks, or ports.
- Keep the deployment under `/home/castalia/services/abcm` because the SSH principal has no sudo access.
- Store the Bearer token only in a mode-0600 deployment environment file and never in Git or evidence.
- Bootstrap only `scope.yaml` and `domain-language/DomainLanguageConvention.md` before first startup.
- Apply all remaining managed documents through REST with `If-None-Match: *` and verify SHA-256 checksums.
- Bind to `127.0.0.1`; external access requires an SSH tunnel until a separate reverse-proxy/auth decision is approved.

## Verification gates

1. Docker image builds from the committed source.
2. Merged Compose configuration validates with the production environment file.
3. Container becomes healthy and survives an explicit restart.
4. Unauthenticated file access returns `401`; authenticated scan/read/list return `200`.
5. ScopeMap contains one valid ready workflow and no diagnostics.
6. Every transferred file checksum matches the retained migration manifest.
7. Existing production containers remain running with their prior port bindings.

## Rollback

Stop only Compose project `abcm`. Retain the workspace and manifest for diagnosis. Removing `/home/castalia/services/abcm` is a separate explicit destructive action and is not part of automatic rollback.
