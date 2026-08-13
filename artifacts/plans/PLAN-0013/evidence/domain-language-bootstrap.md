# PLAN-0013 evidence — DomainLanguageBootstrap

Date: 2026-08-13
Result: PASS

## RED

The initial focused test could not load the absent `domain-language` module. The contract also referenced missing bootstrap types, error codes, runtime principal configuration, REST route, and MCP tool.

## GREEN and negative paths

- Focused domain-language suite: 6 tests, 20 assertions, all passed.
- Workflow and project sources were pinned to one MapRevision and live SHA-256 checksums; service convention metadata was not loaded.
- Strict versioned structured YAML, inherit-only behavior, canonical reference validation, ambiguous aliases, and locked descendant overrides fail closed.
- Missing context permission, unresolved project anchor, different principal, expiry, changed MapRevision, changed source bytes, and missing convention have independent stable failures.
- Repeated requests over unchanged pinned inputs produced the same bootstrap digest while retaining distinct bootstrap ids.

## Regression and production artifact

- Full isolated Linux Docker `bun run check`: 95 tests, 365 assertions, all passed, including real TCP REST/MCP cases.
- `bun run build`: passed.
- Image: `abcm-mcp-server:domain-language-bootstrap`.
- Manifest list: `sha256:a3705b21181a837c7e97c988d2a450945e4b2a78fdda6d16e47c57f56d6b3778`.
- Production `dist` smoke used native REST plus raw MCP 2025-11-25 requests. Both returned status 200 and the same bootstrap digest; the effective projection contained one domain and one concept.

## Boundaries

- The alpha reference server maps its static bearer/stdio boundary to a deployment-owned configurable principal. Library consumers can provide narrower global or per-scope grants.
- Bootstrap state is in-memory; a durable port/schema will be added with ContextFingerprint state before release.
- Final service/feature path resolution and local re-resolution remain PLAN-0014.
- Existing `abcm-local` and `abcm-tunnel` containers were not replaced or restarted.

## Workspace documentation publication

The existing local service received all nine changed PLAN-0013 documents under `castalia-public/abcm` through authenticated REST: five files were created and four were checksum-protected updates. Byte-for-byte verification passed for README, both API references, master plan, specification extension, plan, traceability, verification, and evidence. A live ScopeMap scan completed with zero diagnostics. The intentionally preserved older runtime image retained its legacy digest `sha256:be5aa606c89e4a9cfdee6a4d1b44d1ec33012eb18a182cf7c08b54cf6d6d646a`; neither running container was replaced.
