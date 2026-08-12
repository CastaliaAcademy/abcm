# PLAN-0006 — Long-running scan lease renewal

Status: complete
Target: `0.2.0-alpha.4`
Normative sources: specification 0.5.0 and SQLite scan lease renewal extension 0.1.0.

## Outcome

ScopeMap scans renew their scan lease while asynchronous filesystem construction is running. Lost renewal fences publication and preserves the previous active revision.

## Work units

1. WU-01 — renewal repository port and matching owner/token update.
2. WU-02 — ScopeMap heartbeat lifecycle and renewal-failure propagation.
3. WU-03 — long-scan, stale-renewal, timer-cleanup, regression, and runtime gates.

## Verification result

- Direct renewal and stale fencing: PASS.
- Heartbeat, publication guard, and timer cleanup: PASS.
- Full Docker gate: 57 tests, 172 assertions, 0 failures.
- Runtime smoke: one 6139 ms scan published 151 nodes with an initial 100 ms lease TTL.

## Exclusions

Periodic full reconciliation, filesystem notification debounce, cancellation APIs, distributed leases, and background job supervision remain outside this slice.
