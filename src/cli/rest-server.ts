import { resolve } from "node:path";

import { createAbcmRuntime } from "../app/create-runtime.js";
import { discoverManagedWorkspaces } from "../workspace/provisioning-service.js";

const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "default";
const workspaceRoot = resolve(process.env.ABCM_WORKSPACE_ROOT ?? process.cwd());
const hostname = process.env.ABCM_HOST ?? "127.0.0.1";
const port = Number(process.env.ABCM_PORT ?? "8787");
const bearerToken = process.env.ABCM_API_TOKEN;
const mcpHttpEnabled = process.env.ABCM_MCP_ENABLED !== "false";
const mcpEndpointPath = process.env.ABCM_MCP_PATH ?? "/mcp";
const workspaceStoreRoot = process.env.ABCM_WORKSPACE_STORE_ROOT;
const sqliteDerivedStoreEnabled = process.env.ABCM_DERIVED_STORE_ENABLED === "true";
const runtimeOwnerTtlMs = optionalPositiveInteger("ABCM_DERIVED_STORE_OWNER_TTL_MS");
const runtimeOwnerRenewalIntervalMs = optionalPositiveInteger("ABCM_DERIVED_STORE_OWNER_RENEWAL_INTERVAL_MS");

function commaSeparated(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(",").map(entry => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("MCP hostname/origin allowlists must not be empty when configured.");
  return entries;
}

function optionalPositiveInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("ABCM_PORT must be an integer from 0 to 65535.");
if (bearerToken === undefined) throw new Error("ABCM_API_TOKEN is required for the HTTP server.");
if (process.env.ABCM_MCP_ENABLED !== undefined && !["true", "false"].includes(process.env.ABCM_MCP_ENABLED)) {
  throw new Error("ABCM_MCP_ENABLED must be 'true' or 'false'.");
}
if (process.env.ABCM_DERIVED_STORE_ENABLED !== undefined && !["true", "false"].includes(process.env.ABCM_DERIVED_STORE_ENABLED)) {
  throw new Error("ABCM_DERIVED_STORE_ENABLED must be 'true' or 'false'.");
}

const allowedHostnames = commaSeparated(process.env.ABCM_MCP_ALLOWED_HOSTNAMES);
const allowedOrigins = commaSeparated(process.env.ABCM_MCP_ALLOWED_ORIGINS);
const discoveredWorkspaces =
  workspaceStoreRoot === undefined
    ? []
    : (await discoverManagedWorkspaces(workspaceStoreRoot)).filter(workspace => workspace.id !== workspaceId);
const runtime = createAbcmRuntime(
  [{ id: workspaceId, root: workspaceRoot }, ...discoveredWorkspaces],
  {
    bearerToken,
    mcpHttpEnabled,
    mcpEndpointPath,
    ...(allowedHostnames === undefined ? {} : { mcpAllowedHostnames: allowedHostnames }),
    ...(allowedOrigins === undefined ? {} : { mcpAllowedOrigins: allowedOrigins }),
    ...(workspaceStoreRoot === undefined ? {} : { workspaceStoreRoot }),
    sqliteDerivedStoreEnabled,
    ...(runtimeOwnerTtlMs === undefined && runtimeOwnerRenewalIntervalMs === undefined
      ? {}
      : {
          sqliteDerivedStoreOptions: {
            ...(runtimeOwnerTtlMs === undefined ? {} : { runtimeOwnerTtlMs }),
            ...(runtimeOwnerRenewalIntervalMs === undefined ? {} : { runtimeOwnerRenewalIntervalMs }),
          },
        }),
  },
);
await runtime.scopeMap.scan(workspaceId);

const server = Bun.serve({ hostname, port, fetch: runtime.httpHandler });
console.log(
  `ABCM HTTP server listening on ${server.url} (MCP ${mcpHttpEnabled ? mcpEndpointPath : "disabled"}) for workspace '${workspaceId}' at ${workspaceRoot}`,
);
