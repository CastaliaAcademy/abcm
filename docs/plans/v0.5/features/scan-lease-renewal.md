# Feature plan — scan lease renewal

Requirements: SLR-001..005. Acceptance: AC-SLR-LONG-SCAN and AC-SLR-STALE.

## TDD sequence

1. RED direct renewal preserves fencing and extends expiry.
2. RED stale renewal rejects after expiry/takeover.
3. RED ScopeMap long scan calls renewal and publishes once.
4. RED injected renewal failure blocks publication and keeps the previous revision.
5. GREEN store port, heartbeat lifecycle, full check, build, and runtime smoke.

## Safety boundaries

- Renewal never creates a new scan identity or fencing token.
- Publication still revalidates runtime ownership and scan fencing inside one immediate transaction.
- Timers are cleared in `finally` and unreferenced.
