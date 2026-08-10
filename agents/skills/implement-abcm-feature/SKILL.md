---
name: implement-abcm-feature
description: Implement an ABCM feature from an approved specification-traced plan. Use for changes to workspace I/O, REST or MCP contracts, ScopeMap, context resolution, skills, synchronization, migrations, or other behavior governed by ABCM requirement and acceptance ids.
metadata:
  abcm-skill-strategy: by-description
  abcm-task-types: feature-implementation,bug-fix,refactor
  abcm-version: "0.5"
---

# Implement ABCM Feature

Implement one bounded feature without weakening specification invariants.

## Workflow

1. Read the normative specification, applicable extension, feature plan, verification plan, and traceability entries.
2. State the in-scope requirement and acceptance ids; preserve explicit exclusions.
3. Add or identify a failing test for every changed contract before implementation.
4. Keep domain/application behavior independent from REST and MCP adapters.
5. Implement the smallest vertical slice that satisfies the approved contract.
6. Run targeted tests, full checks, build, and a real adapter smoke test when applicable.
7. Update traceability and evidence in the same milestone.
8. Report code failures separately from environment limitations.

Do not silently implement MAY/SHOULD items, broaden filesystem access, weaken optimistic concurrency, or expose document/source bodies through ScopeMap.

Read [references/implementation-contract.md](references/implementation-contract.md) before changing runtime behavior.
