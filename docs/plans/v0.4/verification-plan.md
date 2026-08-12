# Verification plan — 0.2.0-alpha.3

1. Migration: upgrade a schema-v1 database to v2 without losing active revision data.
2. Conflict: reject a second owner while the first lease is live.
3. Heartbeat: renew before expiry, preserve fencing token, and extend expiry.
4. Recovery: acquire a greater token after expiry or graceful release.
5. Stale safety: old owner cannot read, scan, or publish after takeover.
6. Lifecycle: reference runtime starts heartbeat and clears it on close.
7. Regression: strict typecheck, all unit/contract/e2e tests, package and image build.
8. Runtime: two-process Docker conflict plus crash/expiry restart smoke on a disposable workspace.
