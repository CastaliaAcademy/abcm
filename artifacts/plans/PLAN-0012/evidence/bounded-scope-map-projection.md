# PLAN-0012 evidence — bounded ScopeMap projection

Date: 2026-08-13
Result: PASS

## RED

The initial focused suite contained four failing scenarios: the service treated the query object as the view value, ignored access grants and bounds, exposed the sibling service through REST, and exposed it through MCP.

## GREEN and regression

- Focused projection suite: 5 tests, all passed.
- Projection plus existing ScopeMap/REST/MCP regression: 20 tests, 112 assertions, all passed.
- Host `bun run check`: typecheck passed; 86 tests passed and the two pre-existing ephemeral TCP listener cases reported `EADDRINUSE` for port 0.
- Isolated Linux Docker `bun run check`: 89 tests, 345 assertions, all passed, including both real TCP cases.
- `bun run build`: passed.

## Production artifact

- Image: `abcm-mcp-server:bounded-projection`.
- Manifest list: `sha256:ef1951782517b0acf914befab955c4f94e78b61b10ea4059e6982fa581630b36`.
- Production `dist` runtime smoke: REST status 200; alias `products` resolved to `catalog`; visible ids were `workflow`, `project`, `catalog`, `search`; sibling `billing` was absent; resource count was bounded to four selected-scope files; agent response contained no admin payload.

## Disclosure and compatibility

- Agent projection serializes no document body, individual file path, ordinary source inventory, or inaccessible sibling id.
- Admin and `includeInvalid` require workspace `scope_map.read_full`; invalid branches are rejected in the agent view.
- Legacy string projections retain trusted in-process behavior; REST and MCP use the same configurable effective access object.
- Existing `abcm-local` and `abcm-tunnel` containers were not replaced or restarted.

## Workspace documentation publication

The existing local service received the five PLAN-0012 specification, plan, traceability, verification, and evidence files under `castalia-public/abcm` through authenticated REST. Initial publication created all five files, byte-for-byte verification passed, and a live ScopeMap scan completed with zero diagnostics. The unchanged digest `sha256:be5aa606c89e4a9cfdee6a4d1b44d1ec33012eb18a182cf7c08b54cf6d6d646a` is expected from the intentionally preserved `workspace-registration` runtime image, whose older map digest does not include later content indexes. The running `abcm-local` and `abcm-tunnel` images were not replaced.
