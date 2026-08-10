import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createAbcmRuntime } from "../app/create-runtime.js";

const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "default";
const workspaceRoot = resolve(process.env.ABCM_WORKSPACE_ROOT ?? process.cwd());
const runtime = createAbcmRuntime({ id: workspaceId, root: workspaceRoot });
await runtime.scopeMap.scan(workspaceId);

serveStdio(runtime.createMcpServer, {
  legacy: "serve",
  onerror: error => console.error("ABCM MCP stdio error:", error),
});
