# Verification plan — 0.2.0-alpha.1

1. Static: strict TypeScript typecheck and package build.
2. Unit: registry registration, duplicate rejection, provisioning bootstrap, and restart discovery.
3. REST contract: `201`, stable `400`, `409`, and `503` problem responses.
4. Security: invalid ids, traversal-like ids, forbidden `root`/`path`, and pre-existing target preservation.
5. Integration: new workspace is immediately usable by file methods and ScopeMap.
6. Runtime: authenticated Docker HTTP registration and restart discovery.
7. Migration: manifest records path, size, checksum, operation, and collision outcome before apply.
8. Gate: source/target count and checksum equality plus MCP list/read and ScopeMap projection.
