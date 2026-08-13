# PLAN-0019 verification plan

## Contract gates

- RED: MCP callbacks discard handler signals; services accept no cancellation and can commit after client cancellation.
- Files: abort during authorization prevents temp/rename/delete/move/mkdir commits and retains original bytes.
- Map: abort during indexing leaves the previous active digest unchanged.
- Derived context: pre-aborted language/context operations publish no bootstrap or fingerprint.
- Documentation: pre-commit cancellation writes nothing; cancellation after the first mirror mutation completes the consistent run and returns success.
- Protocol: a real client cancellation reaches the service signal; a cooperative deadline returns MCP_OPERATION_TIMEOUT.
- Regression: targeted suites, full isolated Linux check, package build, production image, and final-image operation smoke.
