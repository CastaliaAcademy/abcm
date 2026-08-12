# Verification plan — 0.2.0-alpha.4

1. Direct store: extend expiry, retain fencing token, reject expired/replaced tuple.
2. Service: renew during yielded filesystem scan and clear heartbeat after completion.
3. Failure: injected renewal loss prevents publication and retains prior revision.
4. Regression: strict TypeScript, full unit/contract/TCP e2e suite, package and image build.
5. Runtime: disposable scan with a TTL shorter than total scan duration publishes one complete revision.

## Result

All gates passed on 2026-08-12. See `artifacts/plans/PLAN-0006/evidence/scan-lease-renewal.md`.
