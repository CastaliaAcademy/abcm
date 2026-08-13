# PLAN-0017 — Stable MCP resource catalog and protocol contract

Status: complete
Target: `0.2.0-alpha.15`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and MCP resource contract extension 0.1.0.

## Outcome

The existing stdio and Streamable HTTP adapters expose the same permission-filtered, addressable resource catalog for bounded ScopeMap projections, indexed documents, plans, architecture records, and skill definitions. Dynamic listings use deterministic opaque pagination; reads verify the active MapRevision checksum and return stable MCP/ABCM errors.

## Work units

1. WU-01 — addressable resource, URI-template, page, protocol-version, and stable error contracts.
2. WU-02 — permission-filtered catalog construction over one active MapRevision with no source-code or executable-resource disclosure.
3. WU-03 — opaque revision-bound cursors, deterministic ordering, exact-byte reads, checksum/lifecycle validation, and bounded map projections.
4. WU-04 — low-level MCP resource handlers shared by stdio and Streamable HTTP, cancellation checks, capability advertisement, and 2025-11-25 negotiation.
5. WU-05 — RED/GREEN, negative access/staleness/URI tests, full regression, build, production image, and adapter smoke.

## Exclusions

Resource subscriptions and executable-resource activation remain disabled. Tool-operation deadline enforcement and deeper cooperative cancellation inside long-running application services are closed separately before M8 is marked complete.

## Verification result

- Permission-filtered maps/documents/plans/architecture/skills, opaque revision-bound pagination, exact reads, lifecycle/checksum validation, and stable resource errors: PASS.
- Real MCP client negotiation at 2025-11-25 and Streamable HTTP SDK auto-negotiation compatibility: PASS.
- Cancellation and server timeout boundaries for resource operations: PASS.
- Targeted legacy/dual-protocol gate: 8 tests, 45 assertions, 0 failures.
- Full isolated Linux/Docker gate: 112 tests, 458 assertions, 0 failures.
- Package build, production image, and production `dist` catalog smoke: PASS.
