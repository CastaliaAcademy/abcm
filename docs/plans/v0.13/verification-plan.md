# PLAN-0014 verification plan

## Contract gates

- RED: resolver module/types, canonical errors, tier evidence, local merge, and rereresolution are absent.
- GREEN: exact link, artifact ownership, deepest repository prefix, local alias rereresolution, and physical path evidence pass.
- Negative: unknown domain/term, ambiguous equal-rank targets, inaccessible candidates, invalid/stale bootstrap, locked override, and non-convergence fail closed.
- Disclosure: result contains bounded ids/metadata and source checksums only, never document bodies or inaccessible candidates.
- Regression: focused tests, full `bun run check`, `bun run build`, production image, and production `dist` library smoke.
