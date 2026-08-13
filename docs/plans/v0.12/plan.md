# PLAN-0013 — DomainLanguageBootstrap

Status: complete
Target: `0.2.0-alpha.11`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and Domain language bootstrap extension 0.1.0.

## Outcome

An authorized principal can build and later validate a compact workflow-plus-project DomainLanguageBootstrap before path resolution, through one shared library/REST/MCP use case.

## Work units

1. WU-01 — structured convention and public bootstrap schemas.
2. WU-02 — pinned source loading, strict parsing, inheritance, and locked merge.
3. WU-03 — principal/access, anchor, deterministic digest, expiry, and stale validation.
4. WU-04 — runtime, REST, and MCP adapters over one service.
5. WU-05 — RED/GREEN, negative configuration/access/staleness, parity, regression, build, image, and runtime gates.

## Exclusions

Service/feature merge, final path scoring, context bundle construction, durable bootstrap persistence, external identity providers, semantic retrieval, and local rereresolution remain for later slices.

## Verification result

- Strict convention parsing, workflow-project merge, locked definitions, access/anchor validation, and service-source exclusion: PASS.
- Principal, expiry, revision, and live-source stale validation: PASS.
- REST/MCP parity and reference CLI principal profile: PASS.
- Full Linux/Docker gate: 95 tests, 365 assertions, 0 failures.
- Package build, production image, and production `dist` REST/raw-MCP parity smoke: PASS.
