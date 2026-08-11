import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createAbcmRuntime } from "../app/create-runtime.js";
import { discoverManagedWorkspaces } from "../workspace/provisioning-service.js";

const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "default";
const workspaceRoot = resolve(process.env.ABCM_WORKSPACE_ROOT ?? process.cwd());
const workspaceStoreRoot = process.env.ABCM_WORKSPACE_STORE_ROOT;
const discoveredWorkspaces =
  workspaceStoreRoot === undefined
    ? []
    : (await discoverManagedWorkspaces(workspaceStoreRoot)).filter(workspace => workspace.id !== workspaceId);
const runtime = createAbcmRuntime(
  [{ id: workspaceId, root: workspaceRoot }, ...discoveredWorkspaces],
  workspaceStoreRoot === undefined ? {} : { workspaceStoreRoot },
);
await runtime.scopeMap.scan(workspaceId);

serveStdio(runtime.createMcpServer, {
  legacy: "serve",
  onerror: error => console.error("ABCM MCP stdio error:", error),
});
