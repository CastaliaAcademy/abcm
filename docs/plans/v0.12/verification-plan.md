# PLAN-0013 verification plan

## Contract gates

- RED: the domain-language module, bootstrap types, error codes, runtime dependency, REST route, and MCP tool are absent.
- GREEN: authorized base merge, deterministic digest, source pinning, validation, and REST/MCP parity pass.
- Safety: service/feature sources remain outside bootstrap; output contains no raw source bodies; locked overrides and malformed schemas fail closed.
- Staleness: principal, expiry, active revision, and live source checksum mismatches are independent failures.
- Regression: targeted tests, full `bun run check`, `bun run build`, production image, and production `dist` REST/MCP smoke.
