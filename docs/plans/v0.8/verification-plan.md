# Verification plan — 0.2.0-alpha.7

Status: passed on 2026-08-13

1. Serialization: overlapping direct scans for one workspace complete without self-induced lease contention.
2. Debounce: mutation bursts share one scan result and execute exactly once.
3. Periodic repair: an unannounced canonical change appears after the configured interval.
4. Atomicity: each reconcile uses full scan/publication and preserves equivalent digest for unchanged bytes.
5. Failure recovery: one injected background failure is reported and later ticks continue.
6. Shutdown: pending work is flushed; store closure happens after reconciliation; no post-close tick runs.
7. Configuration: positive interval, non-negative debounce, strict environment parsing.
8. Regression: strict TypeScript, full Linux/Docker suite, package and production-image build.
9. Runtime: disposable container observes a bind-mounted change without an API mutation call.

All gates passed. See the PLAN-0009 evidence record for exact commands and runtime observations.
