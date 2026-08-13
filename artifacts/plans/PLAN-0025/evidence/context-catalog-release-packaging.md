# PLAN-0025 evidence — context catalog and release packaging

Date: 2026-08-13
Status: complete

## Delivered behavior

- SQLite schema v7 adds separately keyed `context_bundles` and `context_fingerprints` tables with a bundle foreign key.
- Successful immutable fingerprint writes are catalogued idempotently; changed payload/location reuse fails with `CONTEXT_FINGERPRINT_CONFLICT`.
- Catalog rows pin revision, digest, principal, budget, token/selection counts, and body-free fingerprint metadata.
- The runtime exposes the catalog port when SQLite is enabled and accepts an explicit adapter for embedding.
- A deterministic large-fixture harness measures hash, safe-YAML parse, ScopeMap scan, SQLite publication, resolver, and projection separately.
- Package 0.1.0 includes locked dependencies, CycloneDX 1.6 SBOM, package allowlist, provenance guidance, changelog/API/operator/security docs, and runnable library/REST/MCP examples.

## Verification so far

- Focused schema/catalog: 14 tests, 56 assertions, 0 failures.
- Benchmark contract: 1 test, 4 assertions, 0 failures.
- Large fixture: 112 scopes, 100 documents; phase results recorded in `docs/performance/benchmark-v0.1.md`.
- Release typecheck/metadata/SBOM validation: PASS; 20 locked packages and 9 package allowlist entries.
- Package dry run: 112 files, 0.55 MB unpacked.
- `bun audit --audit-level=high`: no vulnerabilities found.

## Final verification

- Full Docker check: 143 tests, 696 assertions, 0 failures.
- Clean `--no-cache` production image used frozen Bun installs and rebuilt TypeScript successfully.
- Production image: `abcm-mcp-server:plan-0025`.
- Image manifest digest: `sha256:bd8c2d1a65234c7999e51cb8b8ef14b81fbbf4652445d793b31df476811990c8`.
- Final-image smoke imported production `dist`, reported version `0.1.0`, migrated schema 7, and round-tripped one body-free execution-bound bundle/fingerprint catalog entry.
- Package dry run after final docs: 113 files, 0.55 MB unpacked.

Workspace publication remains to be recorded after the reviewed commit is transferred to the main local branch.
