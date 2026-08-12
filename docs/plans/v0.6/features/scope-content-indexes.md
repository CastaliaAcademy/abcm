# Feature plan — scope content indexes

Requirements: MAP-012, MAP-013, ART-003, ART-004, IDX-001..008. Acceptance: AC-003, AC-007, AC-JS-SOURCE-IGNORED, AC-SKILL-SCRIPT-RESOURCE, and AC-IDX-*.

## TDD sequence

1. RED managed-root classification and ordinary-source exclusion.
2. RED artifact frontmatter identity, rename stability, and duplicate-id diagnostics.
3. RED skill script metadata-only resource indexing and projection non-disclosure.
4. RED SQLite v2-to-v3 migration and atomic normalized row publication.
5. GREEN minimal scanner/indexer, schema migration, full gate, build, and runtime smoke.

## Safety boundaries

- Filesystem bytes remain canonical and SQLite remains disposable.
- No indexed record contains an authored file body.
- SourceLocatorIndex stays disabled and no ordinary source path is indexed.
- Public projections contain aggregate counts only; file, document, and resource paths stay internal.
