import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createAbcmRuntime } from "../app/create-runtime.js";
import { parseDocumentationSources } from "../documentation/config.js";
import { discoverManagedWorkspaces } from "../workspace/provisioning-service.js";

const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "default";
const workspaceRoot = resolve(process.env.ABCM_WORKSPACE_ROOT ?? process.cwd());
const workspaceStoreRoot = process.env.ABCM_WORKSPACE_STORE_ROOT;
const sqliteDerivedStoreEnabled = process.env.ABCM_DERIVED_STORE_ENABLED === "true";
const scanLeaseTtlMs = optionalPositiveInteger("ABCM_DERIVED_STORE_SCAN_LEASE_TTL_MS");
const scanLeaseRenewalIntervalMs = optionalPositiveInteger("ABCM_DERIVED_STORE_SCAN_LEASE_RENEWAL_INTERVAL_MS");
const runtimeOwnerTtlMs = optionalPositiveInteger("ABCM_DERIVED_STORE_OWNER_TTL_MS");
const runtimeOwnerRenewalIntervalMs = optionalPositiveInteger("ABCM_DERIVED_STORE_OWNER_RENEWAL_INTERVAL_MS");
const documentationSources = parseDocumentationSources(process.env.ABCM_DOCUMENTATION_SOURCES);

function optionalPositiveInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}
if (process.env.ABCM_DERIVED_STORE_ENABLED !== undefined && !["true", "false"].includes(process.env.ABCM_DERIVED_STORE_ENABLED)) {
  throw new Error("ABCM_DERIVED_STORE_ENABLED must be 'true' or 'false'.");
}
const discoveredWorkspaces =
  workspaceStoreRoot === undefined
    ? []
    : (await discoverManagedWorkspaces(workspaceStoreRoot)).filter(workspace => workspace.id !== workspaceId);
const runtime = createAbcmRuntime(
  [{ id: workspaceId, root: workspaceRoot }, ...discoveredWorkspaces],
  {
    ...(workspaceStoreRoot === undefined ? {} : { workspaceStoreRoot }),
    sqliteDerivedStoreEnabled,
    ...(documentationSources === undefined ? {} : { documentationSources }),
    ...(
      scanLeaseTtlMs === undefined &&
      scanLeaseRenewalIntervalMs === undefined &&
      runtimeOwnerTtlMs === undefined &&
      runtimeOwnerRenewalIntervalMs === undefined
      ? {}
      : {
          sqliteDerivedStoreOptions: {
            ...(scanLeaseTtlMs === undefined ? {} : { leaseTtlMs: scanLeaseTtlMs }),
            ...(scanLeaseRenewalIntervalMs === undefined ? {} : { scanLeaseRenewalIntervalMs }),
            ...(runtimeOwnerTtlMs === undefined ? {} : { runtimeOwnerTtlMs }),
            ...(runtimeOwnerRenewalIntervalMs === undefined ? {} : { runtimeOwnerRenewalIntervalMs }),
          },
        }),
  },
);
await runtime.scopeMap.scan(workspaceId);

serveStdio(runtime.createMcpServer, {
  legacy: "serve",
  onerror: error => console.error("ABCM MCP stdio error:", error),
});
