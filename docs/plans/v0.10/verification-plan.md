# PLAN-0011 verification plan

## Contract gates

- RED: mutation calls discard changed paths, mutations during in-flight work reuse the older result, and no map event exists.
- GREEN: changed-path aggregation, nearest-scope resolution, reverse/dependency expansion, topology fallback, and post-publication events pass.
- Reuse: instrumented content indexing proves unrelated scopes are not reread while the published revision remains complete.
- Safety: publication failure emits no event; listener failure is isolated; unchanged digest emits no event.
- Regression: targeted tests, full `bun run check`, `bun run build`, production image, and a real REST mutation/runtime event smoke.

## Independent negative paths

- unknown/malformed changed path;
- scope.yaml topology change;
- mutation received while reconcile is active;
- subscriber throwing synchronously or rejecting asynchronously;
- incremental request before an active map exists.
