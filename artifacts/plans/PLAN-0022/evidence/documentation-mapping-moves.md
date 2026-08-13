# PLAN-0022 evidence — documentation mapping and moves

Date: 2026-08-13
Status: complete

## Delivered behavior

- Strict source configuration accepts deployment-owned `include`, `exclude`, and `{match,target}` mapping rules.
- Canonical glob matching keeps hidden/symlink protection and gives exclusions precedence.
- Exact/wildcard mapping uses stable fallback and reports overlaps/duplicate targets as `DOCUMENTATION_MAPPING_AMBIGUOUS` before apply.
- A unique removed provenance row with equal source checksum becomes a checksum-pinned mirror move.
- The move atomically renames canonical workspace bytes, retires old provenance, activates new provenance, increments `moved`, creates no tombstone, and rebuilds ScopeMap with the same document id.

## Focused verification

- Mapping/move plus OpenAPI: 4 tests, 16 assertions, 0 failures.
- Documentation config/sync/REST/MCP/OpenAPI/tool-schema regression: 13 tests; only the intentionally stale OpenAPI snapshot failed before regeneration, then passed.

## Final gates

- Full Docker check: 132 tests, 622 assertions, 0 failures.
- Production image: `abcm-mcp-server:plan-0022`.
- Image manifest digest: `sha256:c6ec1eba769492d3d02bda2edc2238543bc9b5b4324bafc58329f184b901fb91`.
- Final-image smoke: strict mapping source parsed, shared preview schema accepted `move`, OpenAPI 3.1 composition root loaded.
