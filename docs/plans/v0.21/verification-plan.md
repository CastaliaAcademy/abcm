# PLAN-0022 verification plan

## Contract gates

- RED: source definitions expose only one target base and sync always models source rename as create plus delete.
- Selection: includes select, excludes override, hidden paths/symlinks remain absent.
- Mapping: exact and wildcard rules produce canonical targets; overlaps/duplicate targets produce stable ambiguity conflicts.
- Move: unique checksum plus inactive source-path delta produces one move with old/new path preconditions.
- Identity: exact bytes and frontmatter id survive; old provenance is inactive, new provenance active, no tombstone exists.
- Fallback: non-unique or modified candidates are not treated as identity-preserving moves.
- Parity: preview schema changes are shared by REST, MCP, and generated OpenAPI.
- Regression: full Docker suite, production build/image, and final-image contract smoke.

## Result

- PASS — 132 tests and 622 assertions passed in Docker; production image and final-image config/schema/OpenAPI smoke passed.
