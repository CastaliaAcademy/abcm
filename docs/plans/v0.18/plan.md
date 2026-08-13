# PLAN-0019 — Cooperative MCP cancellation and operation deadlines

Status: complete
Target: `0.2.0-alpha.17`
Completed: 2026-08-13
Normative sources: specification 0.5.0, MCP cancellation utility, and MCP operation control extension 0.1.0.

## Outcome

Client cancellation and the server deadline flow from both MCP transports into workspace files, ScopeMap indexing, language/path/skill resolution, ContextBundle construction, documentation synchronization, and MCP resources. Commit boundaries fail before mutation or complete non-preemptibly after mutation starts.

## Work units

1. WU-01 — reusable combined cancellation/deadline control and stable timeout/cancel codes.
2. WU-02 — workspace mutation and read commit-boundary checks.
3. WU-03 — ScopeMap/content indexing, language, path, skill, context, and resource signal propagation.
4. WU-04 — cancellable documentation validation plus explicitly non-preemptible multi-file commit phase.
5. WU-05 — runtime/CLI configuration, capability disclosure, real-client cancellation, timeout, no-post-cancel mutation, regression, image, and smoke gates.

## Boundary

Operating-system filesystem calls that have already entered the kernel are not forcibly terminated. The deadline signal is checked before publication/commit and after potentially slow reads. Once an irreversible or multi-file commit begins, the operation returns its actual successful result instead of a misleading timeout.

## Verification result

- File, map, documentation, language/context and real-client cancellation gates: PASS.
- Stable cooperative deadline mapping and capability metadata: PASS.
- Existing operation contracts and derived-store publication invariants: PASS.
- Full isolated Linux/Docker gate: 120 tests, 572 assertions, 0 failures.
- Production image and final-image deadline composition smoke: PASS.
