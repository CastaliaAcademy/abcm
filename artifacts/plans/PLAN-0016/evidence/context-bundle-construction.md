# PLAN-0016 evidence — ContextBundle construction

Date: 2026-08-13
Status: PASS

## Scope

- CTX-001..016, DLC-006, LNK-002.
- CBC-001..010.
- AC-004, AC-008, AC-CONTEXT-PROJECTION, AC-CONTEXT-NO-FULL-MAP, AC-MANDATORY-ACCESS, AC-LOCAL-DOMAIN-RERESOLVE, and AC-CBC-*.

## RED

`TMPDIR=/tmp TEMP=/tmp TMP=/tmp bun test test/context-builder.test.ts` failed before implementation because `src/context/context-builder.js` did not exist. This established the missing application contract before production code was added.

## GREEN and negative paths

- Targeted `context-builder` plus content-index tests: 8 tests, 43 assertions, all passed.
- Repeated identical builds produced the same bundle id/digest and selected projections.
- Body-free fingerprint JSON/YAML, selected-file JSONL, and checksum manifest were atomically written below `.abcm`.
- Mandatory access denial, mandatory hard-limit overflow, unresolved document link, stale source checksum, unknown budget, unsafe execution segment, and derived-directory symlink escape returned the expected closed failure.
- Real in-memory MCP client and REST handler returned semantically equal selected documents and bundle digest without a ScopeMap payload.

## Full gate

- `bun run build`: PASS.
- Local `bun run check`: typecheck and 104/106 tests passed; two TCP listener tests were blocked by the host sandbox denying `Bun.serve(port: 0)`.
- Full isolated Linux Docker `bun run check`: 107 tests, 424 assertions, 0 failures, including both real TCP tests.
- Production image: `abcm-mcp-server:plan-0016`, manifest `sha256:326663c186f91f3a460e224b80696caa7b66bef7021dd479b745e5682e7d9a10`.
- Production `dist` runtime smoke: target `feature`, one required document, 26 estimated tokens, bundle digest `sha256:888e7935f2ccc14aa2dbe73fbfd630652b1649383232f285cae333829d17cf79`, reserved fingerprint location, no full-map field.

## Remaining boundaries

- Fingerprints are durable reserved derived files but do not yet have the M2 SQLite bundle/fingerprint catalog.
- Generated/semantic summaries, executable-resource activation, arbitrary project-defined role/task schemas, operator decision workflow, and semantic embedding retrieval remain later milestones.
