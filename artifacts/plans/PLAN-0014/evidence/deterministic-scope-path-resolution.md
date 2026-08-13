# PLAN-0014 evidence — deterministic ScopePath resolution

Date: 2026-08-13
Result: PASS

## RED and GREEN

- RED began with absent resolver/types/errors and no local service/feature merge.
- Exact scope URI, artifact ownership, deepest repository prefix, canonical language routing, relations, and keyword evidence use explicit descending tiers.
- Equal top scores at equal rank fail with `TARGET_SCOPE_AMBIGUOUS`; unknown domains/terms and inaccessible candidates fail independently.
- A service-local alias changed `catalog find` from service `catalog` to feature `search`; trace recorded both passes and a crafted third meaning failed with `PATH_RESOLUTION_NOT_CONVERGED`.
- Focused resolver plus bootstrap regression: 10 tests, 36 assertions, all passed.

## Regression and artifact

- Full isolated Linux Docker `bun run check`: 99 tests, 381 assertions, all passed.
- `bun run build`: passed.
- Image: `abcm-mcp-server:scope-path-resolver`.
- Manifest list: `sha256:5cb45f535d7d74fc5cf82a79823e8f9dc17cb6e27e3ccca3f1642656fbca6d5b`.
- Production `dist` library smoke resolved `workflow -> commerce -> catalog -> search`, recorded `catalog` then `search` passes, and serialized no document body.

## Boundaries

- `ScopePathResolver` is an application-core use case and is intentionally not exposed as an ad-hoc REST/MCP operation; M7 `buildTaskContext` will consume it.
- Optional semantic providers, persisted SourceLocatorIndex, and role/task scoring profiles remain later hardening work.
- Existing `abcm-local` and `abcm-tunnel` containers were not replaced or restarted.

## Workspace documentation publication

The existing local service received seven PLAN-0014 documents under `castalia-public/abcm` through authenticated REST: five creates and two checksum-protected updates. Byte-for-byte verification passed and a live ScopeMap scan completed with zero diagnostics. The preserved older runtime retained legacy digest `sha256:be5aa606c89e4a9cfdee6a4d1b44d1ec33012eb18a182cf7c08b54cf6d6d646a`; neither running container was replaced.
