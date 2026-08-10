---
name: verify-abcm-feature
description: Independently verify an ABCM implementation against normative requirements, public schemas, security boundaries, acceptance scenarios, and recorded evidence. Use for feature gates, regression reviews, release readiness, REST/MCP parity, or migration validation.
metadata:
  abcm-skill-strategy: by-link
  abcm-task-types: quality-gate,security-review,release-verification
  abcm-version: "0.5"
---

# Verify ABCM Feature

Verify observable behavior rather than implementation intent.

## Workflow

1. Read the requirement ids, acceptance scenarios, feature plan, and claimed evidence.
2. Re-run the narrow tests and at least one independent negative-path check.
3. Validate public request/response/error contracts and REST/MCP parity.
4. Test path traversal, symlink escape, reserved paths, stale checksums, and oversized payloads for file features.
5. Distinguish product failure, test defect, dependency failure, and environment limitation.
6. Record PASS, FAIL, BLOCKED, or NOT_IMPLEMENTED per requirement id.
7. Reject the gate when mandatory evidence is missing or an exclusion was broadened.

Read [references/verification-contract.md](references/verification-contract.md) before signing a gate.
