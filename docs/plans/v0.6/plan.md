# PLAN-0007 — Scope content indexes

Status: complete
Target: `0.2.0-alpha.5`
Normative sources: specification 0.5.0 and Scope content indexes extension 0.1.0.

## Outcome

MAP-P4 produces bounded file, document, and executable-resource metadata from canonical workspace bytes and publishes it atomically in SQLite schema v3 without turning ScopeMap into a source tree.

## Work units

1. WU-01 — deterministic managed-root discovery and FileRecord classification.
2. WU-02 — stable artifact DocumentRecord parsing and duplicate-id diagnostics.
3. WU-03 — metadata-only executable resource classification and projection boundary.
4. WU-04 — SQLite schema v3 normalized rows, rebuild, regression, and runtime gates.

## Exclusions

SourceLocatorIndex, DomainLanguage parsing, skill connection, relation-link resolution, provenance, documentation sync, tombstones, incremental reconcile, and document-body retrieval remain outside this slice.

## Verification result

- Classification, stable identity, duplicate diagnostics, resource boundary, and adapter non-disclosure: PASS.
- SQLite v1/v2 migration to schema v3 and atomic normalized publication: PASS.
- Full Docker gate: 60 tests, 205 assertions, 0 failures.
- Production runtime smoke: schema v3, 5 file rows, 1 document row, 1 executable-resource row, 0 ordinary-source rows, and no authored bodies in SQLite.
