# PLAN-0021 evidence — REST request boundaries

Date: 2026-08-13
Status: complete

## RED

- The new contract suite initially failed because no REST limit configuration module existed.

## Delivered behavior

- Protected REST requests consume a process-local fixed-window allowance; public health probes remain exempt.
- Exhaustion returns `REST_RATE_LIMIT_EXCEEDED`/429 with Problem Details and `Retry-After` before application dispatch.
- Bodies are incrementally read and cancelled at the configured byte limit, including unbounded streams without `Content-Length`.
- One combined request/deadline signal reaches file, ScopeMap, domain-language, context, documentation, and workspace-provisioning services.
- Deadline and caller cancellation before the file commit boundary return stable 504/499 problems and leave the filesystem unchanged.
- Runtime and CLI accept three bounded deployment settings; OpenAPI describes size, rate, cancellation, timeout, and Retry-After responses.

## Focused verification

- REST limits suite: 6 tests, 23 assertions, 0 failures.
- Limits plus REST/OpenAPI/MCP operation regression: 20 tests, 82 assertions, 0 failures.

## Final gates

- Full Docker check: 130 tests, 611 assertions, 0 failures.
- Production image: `abcm-mcp-server:plan-0021`.
- Image manifest digest: `sha256:95fc6bbfd6acc7c09e5207c14a140346df1f402c144fc1fbb425a6a3e973deb5`.
- Final-image smoke: exact defaults exported; 429 references `RateLimitProblem`; 499/504 responses exist; invalid 300001 ms timeout is rejected.
- `docker compose config --quiet` for the production overlays: PASS.

## Workspace publication

- Published 11 README/API/operations/plan/spec/evidence files through the preserved local REST runtime into `castalia-public/abcm`.
- First publication: 5 creates, 6 conditional updates, 11 byte-for-byte verification reads.
- Post-publication ScopeMap digest: `sha256:be5aa606c89e4a9cfdee6a4d1b44d1ec33012eb18a182cf7c08b54cf6d6d646a`; diagnostics: 0.
