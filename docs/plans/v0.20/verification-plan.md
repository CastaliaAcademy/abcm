# PLAN-0021 verification plan

## Contract gates

- RED: no rate limiter, REST deadline, cancellation mapping, bounded stream reader, or REST limit environment parser exists.
- Rate: the configured allowance succeeds, the next request returns 429 plus Retry-After, and health remains available.
- Size: declared and streaming bodies fail at the configured boundary without a file commit.
- Time: stalled body and delayed pre-commit mutation return 504; caller cancellation returns 499.
- Propagation: file, map, language, context, documentation, and workspace provisioning receive the combined signal.
- Compatibility: MCP cancellation/deadline behavior and existing REST/OpenAPI parity remain unchanged.
- Deployment: invalid values fail at startup; documented defaults and maximums equal runtime validation.
- Regression: TypeScript, all tests in Docker, production image, and final-image configuration/OpenAPI smoke.

## Result

- PASS — 130 tests and 611 assertions passed in Docker; production-image config/OpenAPI smoke and merged Compose validation passed.
