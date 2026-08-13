---
id: PLAN-0026-FINAL-ACCEPTANCE
kind: report
title: PLAN-0026 final acceptance evidence
status: draft
---

# PLAN-0026 final acceptance evidence

## Verified gates

- Focused normative/schema gate: 18 tests, 75 assertions, 0 failures.
- Clean no-cache Docker gate: frozen install, typecheck, 147 tests, 712 assertions, build, deterministic CycloneDX regeneration, release check, and package dry-run all passed.
- Traceability: 78 baseline requirements (76 MUST/MUST_NOT and 2 MAY), 22 baseline acceptance scenarios, 27 extension specifications, 196 extension requirements, and 56 extension acceptance scenarios; no missing, duplicate, extra, or absent test path.
- Dependency audit: `bun audit --audit-level=high` reported no vulnerabilities.
- Benchmark fixture: 112 scopes, 100 documents, 19,387 authored bytes. Phase timings in milliseconds: fixture write 63.285, raw hash 1.377, YAML parse 105.141, ScopeMap scan 97.902, SQLite publish 37.465, resolver 418.744, projection 139.031.
- Package dry-run: 116 files, 0.57 MB unpacked.
- No-cache production image: `abcm-mcp-server:plan-0026`, digest `sha256:df3bbf300ae91c269116c12aa7ac88af154ffaf54c7a9b375603ed95822ad9ee`.
- Final-image composition-root smoke: server `0.1.0`, SQLite schema v8, one accepted ADR indexed with `worker: null`.
- Local WSL all-suite run had three `Bun.serve({port: 0})` failures because the host could not allocate an ephemeral listener; the same real TCP tests passed in the clean Docker gate. Its separate workspace-registration failure was a functional regression found and fixed before Docker acceptance.

## Publication boundary

Authenticated ABCM REST publication receipt and final clean-main commit are appended after local integration. GitHub push/tag/release, package/image publication, deployment, and replacement of the running legacy containers remain unperformed.
