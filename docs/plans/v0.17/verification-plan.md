# PLAN-0018 verification plan

## Contract gates

- RED: tools advertise input schemas only; schema strictness is inconsistent and capability metadata omits the ABCM contract.
- GREEN: all twelve tools expose strict input/output JSON schemas from the exported registry and valid structuredContent passes SDK validation.
- Schema: every tool rejects an unknown-only object before application execution.
- Error: every operation family returns a stable expected ABCM code; unexpected failures are redacted to INTERNAL_ERROR.
- Happy: real MCP clients execute every tool across the existing application contract suites.
- Regression: targeted tests, full Linux `bun run check`, package build, production image, and final-image smoke.
