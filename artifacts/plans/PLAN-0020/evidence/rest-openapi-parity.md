# PLAN-0020 evidence — REST OpenAPI and MCP parity

Date: 2026-08-13
Status: complete

## Delivered behavior

- `REST_SHARED_SCHEMAS` derives JSON contracts from the same file, language, context, documentation, and ScopeMap Zod schemas registered by MCP.
- `createAbcmOpenApiDocument` deterministically describes 16 operations across health, contract, workspace, file, map, language, context, and documentation endpoints.
- `bun run openapi:generate` writes `docs/api/openapi-v1.json`; the contract test compares exact bytes.
- `GET /openapi.json` returns the same in-memory document.
- Explicit parity uses one runtime and verifies REST/MCP canonical file bytes, checksum metadata, complete list entries, unchanged ScopeMap digest/resource summary, missing-workspace error, and mirror read-only authorization error.
- Existing suites separately verify exact DomainLanguageBootstrap and ContextBundle semantic parity.

## Focused verification

- OpenAPI and explicit parity suites: 4 tests, 16 assertions, 0 failures.
- OpenAPI plus REST/domain/context/documentation regression: 21 tests, 102 assertions, 0 failures before explicit parity was added.

## Final gates

- Local Linux check with explicit `/tmp`: TypeScript passed; 121 tests passed and the three TCP-listener cases were environment-blocked by the managed sandbox.
- Docker check outside that listener restriction: 124 tests, 588 assertions, 0 failures.
- Production image: `abcm-mcp-server:plan-0020`.
- Image manifest digest: `sha256:71e12ecff3c9496e51232d081ce5757c84b034079ff9b71331d54c33cf1fc6eb`.
- Final-image composition-root smoke: OpenAPI `3.1.0`, 14 path objects, 16 operations, 13 shared schemas.

## Workspace publication

- Published 8 changed contract/evidence files through the preserved local REST runtime into `castalia-public/abcm`.
- First publication: 6 creates, 2 conditional updates, 8 byte-for-byte verification reads.
- Post-publication ScopeMap digest: `sha256:be5aa606c89e4a9cfdee6a4d1b44d1ec33012eb18a182cf7c08b54cf6d6d646a`; diagnostics: 0.
