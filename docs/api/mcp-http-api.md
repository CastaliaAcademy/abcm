# MCP Streamable HTTP API

The reference HTTP server mounts MCP at `POST /mcp` and keeps REST under `/v1`. Both adapters use the same runtime services and require `Authorization: Bearer <ABCM_API_TOKEN>`. The SDK may also issue GET or DELETE requests as defined by the negotiated MCP protocol.

Default security settings accept only `localhost`, `127.0.0.1`, and `[::1]` Host/Origin hostnames. Configure comma-separated `ABCM_MCP_ALLOWED_HOSTNAMES` and `ABCM_MCP_ALLOWED_ORIGINS` only for an approved proxy or tunnel hostname.

Example TypeScript client:

```ts
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:8787/mcp"), {
  authProvider: { token: async () => process.env.ABCM_API_TOKEN! },
});
const client = new Client({ name: "abcm-client", version: "0.1.0" });
await client.connect(transport);
console.log(await client.listTools());
```

The production alpha profile remains bound to loopback. Use an SSH tunnel for operator clients. ChatGPT cannot use that SSH tunnel directly; it requires an approved remote HTTPS route such as Secure MCP Tunnel or a reverse proxy with compatible authentication.
