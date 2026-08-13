# PLAN-0016 verification plan

## Contract gates

- RED: ContextBuilder, public build schemas, fingerprint persistence, and REST/MCP operations are absent.
- GREEN: one pinned build returns deterministic bounded manifests, connected skills, materialized projections, reasons, omissions, and a persisted body-free fingerprint.
- Negative: stale bootstrap, inaccessible mandatory content, mandatory hard-limit overflow, unresolved explicit documents, stale document checksum, and invalid budget fail with stable errors.
- Disclosure: bundles contain only selected projected bodies; fingerprints contain no bodies; responses contain no full ScopeMap or executable resource content.
- Parity: REST and real MCP client produce the same digest/manifest and stable error code for the same principal/request.
- Regression: targeted tests, full `bun run check`, `bun run build`, production image, and production adapter smoke.
