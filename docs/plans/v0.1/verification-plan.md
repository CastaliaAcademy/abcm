# Verification plan — 0.1.0-alpha.1

## Gates

1. Static: TypeScript strict/noUncheckedIndexedAccess/exactOptionalPropertyTypes.
2. Unit: paths, checksums, atomic preconditions, scanner topology/digest.
3. REST contract: methods, status codes, problem body, ETag, content type.
4. MCP contract: tool discovery, structured results, resource read.
5. Integration: direct filesystem and REST parity in an isolated temp workspace.
6. Security: traversal variants, symlink escape, reserved paths, payload limit, overwrite denial.
7. Migration: scan this repository and read root metadata through REST.
8. Release: clean build, smoke server, exact command evidence.

Failures from unavailable network/dependencies are reported separately from code failures.
