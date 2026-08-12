# PLAN-0007 evidence — Scope content indexes

Date: 2026-08-12

## Contract and RED

- Normative requirements: MAP-012, MAP-013, ART-003, ART-004, and IDX-001..008.
- Acceptance: AC-003, AC-007, AC-JS-SOURCE-IGNORED, AC-SKILL-SCRIPT-RESOURCE, and AC-IDX-*.
- Initial targeted result: 8 passed and 5 failed. `MapRevision` had no content indexes, SQLite remained schema v2, and normalized tables did not exist.

## Automated gates

- Targeted classification/store/adapter command: `TMPDIR=/tmp bun test test/scope-map-content-index.test.ts test/sqlite-scope-map-store.test.ts test/scope-map-sqlite-rebuild.test.ts test/rest-handler.test.ts test/mcp-adapter.test.ts`.
- Targeted result: 20 passed, 109 assertions, 0 failures before the additional exact v2 migration regression was added.
- Final full command: one-off `oven/bun:1.3.14` container running `bun run check` against the worktree.
- Final full result: 60 passed, 205 assertions, 0 failures, including real TCP REST and Streamable HTTP MCP e2e.
- Package build: PASS.
- Image `abcm-mcp-server:content-indexes`: PASS, manifest-list digest `sha256:987512a2ee8d04ed94163f9b6af3224470ced1bb962cd8adfb9b3f18a14fea68`.

## Independent negative and atomicity checks

- `src/index.js` remained absent from FileRecord and DocumentRecord indexes while its owning scope remained visible.
- A skill `scripts/run.js` became one metadata-only ExecutableResourceRecord and no DocumentRecord.
- Duplicate `ADR-0001` frontmatter ids emitted `DOCUMENT_ID_DUPLICATE`; both ambiguous candidates were excluded.
- Renaming the original ADR retained document id and checksum while changing only its path and map digest.
- An injected active-pointer failure rolled back the staged MapRevision and its `map_files` row.
- SQLite v2 upgraded to v3 without replacing the existing active revision.
- REST `scope-map/scan`, MCP `scope_map.scan`, and map projections omitted internal index arrays and paths.

## Production-image runtime smoke

1. Started a disposable production container with SQLite enabled against a workflow containing one ADR, one skill script, and one ordinary JavaScript source file.
2. The admin REST projection returned `indexedFiles=5`, `documents=1`, and `executableResources=1`, with no internal arrays or indexed paths.
3. Read-only SQLite inspection returned schema v3, 5 file rows, 1 document row, 1 executable-resource row, and 0 rows for `src/index.js`.
4. Neither serialized revision metadata nor raw SQLite bytes contained any `SECRET-` authored/script/source body marker.
5. Removed the disposable smoke container. Existing `abcm-local` and `abcm-tunnel` containers were not changed.

Filesystem content remains canonical. Provenance, synchronization, tombstones, normalized relations/diagnostics, and context repositories remain explicit follow-up work.
