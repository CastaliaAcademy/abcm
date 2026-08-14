import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import { createAbcmMcpServer, type AbcmMcpDependencies } from "./create-server.js";

export interface AbcmMcpHttpOptions {
  endpointPath?: string;
  allowedHostnames?: string[];
  allowedOrigins?: string[];
  onerror?: (error: Error) => void;
}

export interface AbcmMcpHttpHandler {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

function notFound(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32_001, message: "MCP endpoint was not found." }, id: null },
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

/** Creates a Streamable HTTP endpoint with protocol-level host and origin validation. */
export function createAbcmMcpHttpHandler(
  dependencies: AbcmMcpDependencies,
  options: AbcmMcpHttpOptions = {},
): AbcmMcpHttpHandler {
  const endpointPath = options.endpointPath ?? "/mcp";
  if (!endpointPath.startsWith("/")) throw new Error("MCP endpoint path must start with '/'.");

  const allowedHostnames = options.allowedHostnames ?? localhostAllowedHostnames();
  const allowedOrigins = options.allowedOrigins ?? localhostAllowedOrigins();
  const handler: McpHttpHandler = createMcpHandler(() => createAbcmMcpServer(dependencies), {
    legacy: "stateless",
    responseMode: "auto",
    ...(options.onerror === undefined ? {} : { onerror: options.onerror }),
  });

  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== endpointPath) return notFound();
      const rejected =
        hostHeaderValidationResponse(request, allowedHostnames) ?? originValidationResponse(request, allowedOrigins);
      return rejected ?? handler.fetch(request);
    },
    close: handler.close,
  };
}
