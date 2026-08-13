# PLAN-0017 verification plan

## Contract gates

- RED: only the singleton `abcm://map` resource exists; resource enumeration, templates, scoped maps, documents, skills, pagination, and stale-body protection fail.
- GREEN: one real client negotiates 2025-11-25, drains multiple deterministic pages, and reads each permitted addressable resource.
- Negative: wrong namespace, unknown or inaccessible resource, malformed URI, stale indexed checksum, and invalid/stale cursor fail closed with stable ABCM codes in MCP errors.
- Disclosure: ordinary sources, hidden scopes, executable resources, file paths, and bodies never appear in catalog metadata or map projections.
- Transport: the same server factory is exercised by in-memory, stdio build, and Streamable HTTP production smoke.
- Regression: targeted tests, full `bun run check`, `bun run build`, production image, and adapter smoke.
