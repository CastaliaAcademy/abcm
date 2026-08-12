# PLAN-0006 evidence — long-running scan lease renewal

Date: 2026-08-12

## Contract and RED

- Requirements: SLR-001..005.
- Acceptance: AC-SLR-LONG-SCAN and AC-SLR-STALE.
- Initial targeted result: 7 passed and 3 failed. The store lacked `renew`, successful scans recorded no heartbeat calls, and an injected renewal failure did not block publication.

## Automated gates

- Targeted command: `TMPDIR=/tmp bun test test/sqlite-scope-map-store.test.ts test/scope-map-scan-renewal.test.ts test/scope-map-service.test.ts`.
- Targeted result: 14 passed, 47 assertions, 0 failures.
- Full command: one-off `oven/bun:1.3.14` container running `bun run check` against the worktree.
- Full result: 57 passed, 172 assertions, 0 failures, including real TCP REST and Streamable HTTP MCP e2e.
- Package build: PASS.
- Image `abcm-mcp-server:scan-lease-renewal`: PASS, manifest list digest `sha256:bc66f95f9098e3ba46ed0e172a739d095f0e521c34e28ff456229768b01c8371`.

## Safety checks

- Renewal extended expiry only for the exact workspace, owner, and fencing token.
- Renewal retained both scan id and fencing token.
- Renewal after expiry returned `SCAN_FENCING_STALE`.
- An injected heartbeat failure prevented publication and preserved the previous active revision.
- The heartbeat stopped after publication and did not retain the process event loop.
- Publication still validates runtime ownership and current scan fencing inside an immediate transaction.

## Runtime smoke

1. Built a disposable workspace with one workflow and 150 direct project scopes.
2. Started the production image with SQLite enabled, a 100 ms scan TTL, and a 10 ms renewal interval.
3. The initial scan ran for 6139 ms, more than 61 original TTL windows, and published one complete 151-node revision.
4. The scan session finished as `published` and exactly one active revision existed.
5. Removed the disposable smoke container. Existing `abcm-local` and tunnel containers were not changed.

The local workspace gate also reached 55 passes before its two TCP listeners were denied by the desktop sandbox. The authoritative full gate above ran those same e2e tests successfully in Docker.
