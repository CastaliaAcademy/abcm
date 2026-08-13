---
id: PLAN-0026-LOCAL-SERVICE-CUTOVER
kind: report
title: ABCM 0.1.0 local service cutover
status: accepted
---

# ABCM 0.1.0 local service cutover

Date: 2026-08-13

- Built `abcm-mcp-server:0.1.0` and `latest` from the accepted local branch; local image id is `sha256:7a84a2edd2d344f7108734677102234d13ff63e9e3637bc162011e99912f6fae`.
- Preserved the previous image as `abcm-mcp-server:rollback-workspace-registration-20260813`.
- Backed up `abcm-managed-workspaces` to the session-local archive `/tmp/abcm-upgrade-BNptqE/managed-workspaces.tar.gz` before replacement.
- Recreated `abcm-local` and `abcm-tunnel` with their existing ports, token/secret sources, mounts, and restart policy.
- Changed the default workspace in both processes from read-only `self` to service-owned `castalia-public` at `/workspaces/castalia-public`; the ABCM project documentation remains below `abcm/`.
- REST health, authenticated scan/read, MCP 2025-11-25 auto-negotiation, tunnel health, and runtime metadata passed.
- Smoke result: server `0.1.0`, root `castalia-public`, agent view, 9 MCP tools, 3 resources, byte-identical `abcm/README.md`, ScopeMap digest `sha256:83bdfa3e3f28b0b54df73759d1cc3cfaf9555fec4134a17c204c475875d4b554`, zero diagnostics.
- Compose now pins image `0.1.0`, the existing `abcm-managed-workspaces` volume, the service-owned workspace defaults, and enabled Streamable HTTP MCP.

No GitHub/image-registry push, remote deployment, token rotation, or production-host change was performed.
