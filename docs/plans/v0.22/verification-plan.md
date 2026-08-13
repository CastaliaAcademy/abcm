# PLAN-0023 verification plan

## Contract gates

- RED: no public cutover operation, storage-mode transition, cutover record, or recovery journal exists.
- Approval: missing/false approval and a changed reviewed digest fail before ownership transfer.
- Checksums: selected source, provenance, and mirror target all match after final sync.
- Atomicity: source mode and active provenance switch in one immediate SQLite transaction.
- Publication: managed ScopeMap is published and pinned; a fault between commit/publication resumes idempotently.
- Sync recovery: injected metadata failure leaves a body-free journal; next preview converges bytes/metadata/map exactly once.
- Divergence: changed source/target against pending journal fails closed.
- Ownership: managed writes succeed; later source deletion or sync cannot delete/replace targets.
- Adapters: strict shared schemas and equivalent real REST/MCP cutover results.
- Regression: migrations v1-v6, full Docker suite, production image, and final-image smoke.

## Result

- PASS — 137 tests and 661 assertions passed in Docker; production image and final-image tool/cutover/OpenAPI smoke passed.
