# PLAN-0011 evidence — incremental ScopeMap reconciliation

Date: 2026-08-13

## Delivered behavior

- Mutation debounce retains every unique normalized changed path and passes the sorted set to targeted reconciliation.
- Mutations arriving during in-flight work queue a subsequent serialized reconcile and receive its later revision.
- Nearest scope selection uses the longest path-boundary match. Missing active state, malformed paths, `scope.yaml` changes, and an active duplicate-document diagnostic use the full-scan safety path.
- The impact set includes changed scopes, direct descendants, reverse resolved/unresolved `abcm://` sources, and all descendant readiness dependants for domain-language changes.
- Only impacted scope content and relation configurations are reread; unaffected normalized records are reused to assemble and atomically publish a complete immutable MapRevision.
- Full scans remain mandatory for periodic and explicit `reconcileNow` work.
- `ScopeMapChanged` is invoked after successful publication only when the normalized digest changes. It includes workspace/revision/digest, sorted changed scopes, and severity counts. Synchronous throws and asynchronous rejections are isolated per subscriber.

## TDD evidence

- RED: 3 tests passed and 5 failed because paths were discarded, in-flight mutation reused the old result, and `reconcile`/`subscribe` did not exist.
- GREEN targeted gate: 11 tests, 36 assertions, 0 failures across impact-set and coordinator suites.
- Negative paths cover malformed traversal input, topology fallback, incremental-before-active, unresolved reverse-link activation, descendant readiness, subscriber throws/rejections, and publication failure.

## Independent verification

| Requirement | Result | Evidence |
| --- | --- | --- |
| REC-001, ISR-001 | PASS | deterministic changed-path aggregation test |
| REC-002, ISR-002 | PASS | nearest scope, pre-active, malformed, and scope.yaml full fallback tests |
| REC-003, ISR-003 | PASS | direct descendant, resolved/unresolved reverse link, and readiness dependant assertions |
| REC-004, ISR-004 | PASS | injected indexer proves unrelated scope content is not reread; complete revision retains its records |
| REC-005 | PASS | existing atomic SQLite publication plus publication-failure event negative path |
| REC-006, ISR-008 | PASS | periodic/full regression and unchanged full-scan runtime smoke |
| MAP-025, ISR-006, ISR-007 | PASS | post-publication event payload, unchanged digest, and listener isolation assertions |
| ISR-005 | PASS | second in-flight mutation receives revision 2 with max concurrency 1 |

## Full gate and build

- Full Linux/Docker `bun run check`: 84 tests, 321 assertions, 0 failures across 24 files.
- `bun run build`: PASS.
- Production image `abcm-mcp-server:incremental-reconcile`: PASS; manifest list `sha256:dbd70276765317aaebe3a6f09e9859418ff784b677455280f483938df1652353`.
- The sandboxed host run reached 81 passing tests; only the two known ephemeral TCP listener tests failed with `EADDRINUSE`. Both passed in Docker.

## Production runtime smoke

A disposable production image executed the built library with SQLite, an in-process `ScopeMapChanged` subscriber, and a real TCP REST handler.

- authenticated REST created `target/README.md` with HTTP 200 and triggered targeted reconciliation;
- the final-image digest changed from `sha256:93cff758d8e2b8020cfa68e64453b1a0ae400e576560153e47e87c0766e79baf` to `sha256:67ff8fdf0d69398e01cfa637ced255eb6f87f87ea9d378e82169c64af01066bd`;
- exactly one event reported `changedScopeIds=[target]` and the changed digest;
- a subsequent explicit unchanged full scan retained the digest and emitted no second event;
- SQLite remained schema 5 and recorded three scan sessions (initial, mutation, unchanged full scan);
- process exit was 0 without OOM, and the disposable container was removed.

Existing `abcm-local` and `abcm-tunnel` were not modified.

## Remaining boundary

Native watchers, persistent/brokered events, REST/SSE event streaming, distributed subscribers, and incremental topology discovery remain later or optional work. Context construction and role/skill orchestration remain the next normative MVP milestones.
