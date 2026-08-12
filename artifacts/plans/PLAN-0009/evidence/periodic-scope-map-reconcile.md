# PLAN-0009 evidence — periodic ScopeMap reconciliation

Date: 2026-08-13

## Delivered behavior

- `ScopeMapService` serializes direct scans per workspace before ScanLease acquisition while preserving cross-process SQLite fencing.
- `ScopeMapReconcileCoordinator` coalesces mutation bursts, schedules mandatory full scans for the live workspace registry, and coalesces overlapping periodic ticks.
- Periodic failures reach the configured background-error callback and do not stop later attempts.
- Runtime close stops timers, flushes pending mutation work, waits for in-flight scans, and only then closes its owned SQLite store.
- REST and stdio CLIs handle SIGINT/SIGTERM through the same graceful runtime close path.
- Defaults are 50 ms mutation debounce and 300000 ms full reconcile; environment parsing rejects unsafe timing values.

## Verification

- RED: missing coordinator/config modules, missed-event timeout, and concurrent `SCAN_LEASE_BUSY` reproduced before implementation.
- Targeted regression: 22 tests, 83 assertions, 0 failures across scan, heartbeat, file mutation, provisioning, documentation sync, and reconcile suites.
- Full Linux/Docker `bun run check`: 74 tests, 268 assertions, 0 failures across 22 files.
- `bun run build`: PASS.
- Production image `abcm-mcp-server:periodic-reconcile`: PASS; final manifest list `sha256:98d94c1112476340406173de9ed722fa9b8172fb6952145a5f0af377e616966d`.

## Runtime smoke

A disposable production-image container used SQLite and a writable bind-mounted workspace with a 100 ms full-reconcile interval. After startup, `artifacts/missed.md` was copied directly into the host mount without REST, MCP, or `WorkspaceFileService` mutation notification.

- indexed files changed from 2 to 3 without an API scan call;
- map digest changed after the canonical write;
- subsequent unchanged periodic scans retained an equivalent digest;
- 725 complete scan sessions were published while the intentionally aggressive 100 ms smoke interval remained active through verification and diagnostics;
- container SIGTERM exited with code 0 and no OOM kill;
- persisted runtime owner had `expires_at=0` after shutdown;
- SQLite remained schema 4 with `journal_mode=delete`.

The temporary container and fixture directory were removed. Existing `abcm-local` and `abcm-tunnel` were not modified.

## Remaining boundary

This slice always performs complete scans. Native filesystem watchers, targeted impact-set rescans, reverse-link dependency expansion, document-source auto-sync, persisted scheduling, and distributed coordination remain later work.

## Workspace documentation publication

The existing local service received 11 PLAN-0009 documentation/configuration files under `castalia-public/abcm` through authenticated REST: preview reported 7 creates, 4 modifications, 0 collisions; apply changed all 11; verification confirmed equal size and SHA-256. A live read returned PLAN-0009, and ScopeMap reported zero diagnostics with project `abcm` ready. The running `abcm-local` and `abcm-tunnel` images were not replaced.
