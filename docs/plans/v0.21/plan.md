# PLAN-0022 — Documentation mapping and identity-preserving moves

Status: complete
Target: `0.2.0-beta.1-pre.1`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and documentation mapping/moves extension 0.1.0.

## Outcome

Directory sources select Markdown through deployment-owned include/exclude globs, map paths deterministically, reject ambiguity before mutation, and preserve document identity across checksum-proven source renames.

## Work units

1. WU-01 — RED filter/mapping/ambiguity/move/provenance/tombstone/document-id scenarios.
2. WU-02 — strict source configuration and canonical glob/target validation.
3. WU-03 — deterministic target mapping, collision analysis, and extended preview contract.
4. WU-04 — internal atomic mirror move, provenance retirement/upsert, moved SyncRun count, and ScopeMap rebuild.
5. WU-05 — REST/MCP/OpenAPI regression, docs, full Docker gate, production image, and final-image smoke.

## Boundary

Mapping rules are deployment-owned and requests still provide only source id. Remote connectors, two-way merge, watchers, and arbitrary request paths remain excluded. Managed cutover and filesystem/metadata recovery are completed by the next M10 plan.

## Verification result

- Focused mapping/move and OpenAPI contract tests: PASS.
- Full Docker 132/132, production image, and final-image mapping/move schema smoke: PASS.
