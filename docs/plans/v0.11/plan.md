# PLAN-0012 — Bounded and permission-filtered ScopeMap projections

Status: complete
Target: `0.2.0-alpha.10`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and Bounded ScopeMap projection extension 0.1.0.

## Outcome

REST, MCP, and library consumers receive the same immutable, root/depth-bounded ScopeMap projection. Global and local grants control discovery and metadata disclosure, while admin and invalid-branch access require full-map permission.

## Work units

1. WU-01 — public projection query, projected-node, permission, and access contracts.
2. WU-02 — canonical/alias root resolution, depth bounds, local grants, and path-only ancestor preservation.
3. WU-03 — bounded nodes, relations, warnings, child ids, relation summaries, and resource counts.
4. WU-04 — REST query validation and shared MCP/REST access configuration.
5. WU-05 — RED/GREEN, permission matrix, negative disclosure, parity, regression, build, and runtime gates.

## Exclusions

Identity-provider integration, persisted principals, row-level ACL administration, document/resource reads, context construction, pagination, and remote policy engines remain outside this slice.

## Verification result

- Local/global permission matrix, alias roots, depth bounds, path-only ancestors, admin invalid branches, and bounded admin summaries: PASS.
- REST/MCP shared access input and negative disclosure tests: PASS.
- Targeted regression: 20 tests, 112 assertions, 0 failures.
- Full Linux/Docker gate: 89 tests, 345 assertions, 0 failures.
- Package build, production image, and production `dist` REST runtime smoke: PASS.
