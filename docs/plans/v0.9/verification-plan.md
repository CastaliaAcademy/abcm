# PLAN-0010 verification plan

## Contract gates

- RED: supported links and `relations.yaml` are not represented as explicit relations; SQLite reports schema v4.
- GREEN: supported stable links resolve deterministically, aliases canonicalize, optional/required misses are distinguished, and physical paths are rejected.
- Projection: agent view excludes non-scope endpoints and all indexed document paths/bodies; admin retains diagnostics.
- Persistence: v4 upgrades transactionally to v5 and normalized graph rows match the active payload.
- Regression: targeted tests, full `bun run check`, `bun run build`, and a production-image REST ScopeMap smoke.

## Independent negative paths

- malformed strict `relations.yaml`;
- absolute POSIX, Windows, UNC, and relative physical-path targets;
- unresolved required target with successful map publication and warning readiness;
- second unchanged scan with identical digest.
