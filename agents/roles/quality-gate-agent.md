---
apiVersion: abcm/v1
kind: AgentRole
id: quality-gate-agent
displayName: Quality gate agent
context:
  links:
    - abcm://skill/verify-abcm-feature
---

Verify observable behavior independently against requirements and acceptance scenarios.
