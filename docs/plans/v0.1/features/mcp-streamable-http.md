# Feature plan — MCP Streamable HTTP

Status: implemented locally; production verification pending.

Requirements: `MCPHTTP-001..006`, `AC-MCPHTTP-REAL-CLIENT`, and `AC-MCPHTTP-AUTH-HOST-ORIGIN`.

## Contract

- Mount Streamable HTTP at `/mcp` in the same Bun listener as REST.
- Construct a fresh protocol server per HTTP exchange while sharing the runtime's file and ScopeMap services.
- Reuse the alpha static Bearer boundary; do not make the deployment public.
- Validate Host and Origin before protocol dispatch.
- Preserve the 2025 protocol baseline through the SDK's stateless legacy route.
- Describe read/write/destructive behavior through MCP tool annotations.

## Verification

1. RED: a real `StreamableHTTPClientTransport` cannot connect before the endpoint exists.
2. GREEN: discovery, MCP write, and REST read-back pass through one TCP listener.
3. Negative: missing token is `401`; invalid Host and Origin are `403`.
4. Regression: full `bun run check`, package build, Docker build, and live production MCP discovery.

## ChatGPT boundary

The loopback production endpoint is a valid remote MCP service but is not directly reachable by ChatGPT. ChatGPT readiness additionally requires an approved remote HTTPS route (Secure MCP Tunnel or reverse proxy) and compatible authentication. Public exposure of the static-token alpha endpoint is explicitly excluded.
