# ABCM 0.1 large-fixture benchmark

Date: 2026-08-13
Runtime: Bun 1.3.14, local WSL/Docker development host
Command: `TMPDIR=/tmp bun run bench`

The fixture contained 112 scopes and 100 frontmatter documents (19,387 authored bytes). Results are diagnostic measurements, not service-level objectives:

| Phase | Duration (ms) |
|---|---:|
| Fixture writes | 58.911 |
| Repeated raw SHA-256 hashing | 1.639 |
| Repeated safe YAML parsing | 110.051 |
| In-memory ScopeMap scan/index | 89.330 |
| SQLite lease + normalized publication | 36.440 |
| 100 deterministic resolver calls | 337.002 |
| 100 bounded map projections | 134.627 |

`benchmarks/large-fixture.ts` reports the phases separately and accepts `ABCM_BENCH_SERVICES`, `ABCM_BENCH_FEATURES_PER_SERVICE`, and `ABCM_BENCH_ITERATIONS`. Wall-clock values vary by filesystem and host; fixture counts and output shape are contract-tested.
