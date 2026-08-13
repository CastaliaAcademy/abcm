# PLAN-0014 — Deterministic ScopePath resolution

Status: complete
Target: `0.2.0-alpha.12`
Completed: 2026-08-13
Normative sources: specification 0.5.0 and Deterministic scope path resolution extension 0.1.0.

## Outcome

The application core validates a DomainLanguageBootstrap, normalizes canonical intent, builds an access-bounded project candidate universe, selects one target through deterministic scoring tiers, merges local conventions, and permits at most one re-resolution pass.

## Work units

1. WU-01 — normalized intent, evidence, trace, and ResolvedScopePath contracts.
2. WU-02 — canonical domain/term/alias/homonym validation and access-bounded universe.
3. WU-03 — exact/artifact/path/language/relation/keyword scoring and ambiguity rules.
4. WU-04 — workflow-project-service-feature merge and bounded local re-resolution.
5. WU-05 — RED/GREEN, golden tiers, errors/access, regression, build, image, and runtime gates.

## Exclusions

Semantic matcher providers, SourceLocatorIndex persistence, role-specific profiles, buildTaskContext transport exposure, skill connection, document selection, and ContextBundle materialization remain later milestones.

## Verification result

- Canonical normalization, access-bounded universe, deterministic tier evidence, ambiguity, and physical path: PASS.
- Workflow-project-service-feature merge, concept scope routing, one local re-resolution, and third-pass rejection: PASS.
- Focused M5 gate: 10 tests, 36 assertions, 0 failures.
- Full Linux/Docker gate: 99 tests, 381 assertions, 0 failures.
- Package build, production image, and production `dist` library smoke: PASS.
