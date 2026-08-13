# PLAN-0012 verification plan

## Contract gates

- RED: root/depth/includeInvalid query types, local access grants, ACCESS_DENIED, projected child/relation summaries, and adapter access configuration are absent.
- GREEN: permission matrix, alias root, bounded depth, path-only ancestors, invalid-branch gating, and REST/MCP parity pass.
- Disclosure: serialized projections contain no document bodies, individual file paths, ordinary source inventory, inaccessible sibling ids, or global resource counts.
- Compatibility: the legacy string overload keeps trusted internal agent/admin behavior while new adapters use an explicit effective access input.
- Regression: targeted tests, full `bun run check`, `bun run build`, production image, and runtime REST/MCP smoke.

## Independent negative paths

- absent discover or metadata permission;
- admin or includeInvalid without full-map permission;
- unknown root id/alias;
- negative, fractional, or malformed depth;
- malformed includeInvalid;
- local descendant grant beneath inaccessible ancestors.
