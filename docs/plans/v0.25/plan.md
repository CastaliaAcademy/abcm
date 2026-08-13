# PLAN-0026 — Normative closure and final acceptance

Status: local implementation and release gates complete; documentation publication pending
Milestone: M11 / 0.1.0 final gate
Requirements: 76 normative MUST/MUST_NOT, 22 baseline acceptance scenarios, NCC-001..004, AC-NORMATIVE-PLACEMENT, AC-ACCEPTED-ARTIFACT-IMMUTABLE

## Outcome

ABCM enforces the remaining content-placement and accepted-artifact controls, then validates one machine-readable release traceability manifest with no uncovered normative requirement or acceptance scenario.

## Work units

1. WU-01 — RED tests for role/artifact/architecture placement and accepted ADR/RFC mutation boundaries.
2. WU-02 — placement diagnostics/exclusion and operation-aware API mutation authorization that preserves rename identity.
3. WU-03 — consolidated traceability manifest and validator against specification 0.5.0 plus release extensions.
4. WU-04 — explicit MAY/SHOULD/non-goal register, release checklist, clean package/image gates, and final evidence.
5. WU-05 — publish final documentation through ABCM REST and leave GitHub/package/image publication approval-gated.

## Boundaries

- Direct OS edits cannot be prevented by a library; the immutable control applies to REST/MCP/library `WorkspaceFileService` operations constructed by `createAbcmRuntime`.
- Accepted artifact rename is allowed only when it does not overwrite another accepted artifact; content checksum/frontmatter identity is unchanged.
- No external registry, GitHub release, tag, push, or container deployment occurs.
