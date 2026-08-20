import { resolve } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createAbcmRuntime } from "../app/create-runtime.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";
import { parseDocumentationSources } from "../documentation/config.js";
import { parseContextPrincipalEnvironment } from "../domain-language/context-principal-config.js";
import { parseScopeMapReconcileEnvironment } from "../scope-map/reconcile-config.js";
import { discoverManagedWorkspaces } from "../workspace/provisioning-service.js";

const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "default";
const workspaceRoot = resolve(process.env.ABCM_WORKSPACE_ROOT ?? process.cwd());
const workspaceStoreRoot = process.env.ABCM_WORKSPACE_STORE_ROOT;
const fileOperationStateRoot = process.env.ABCM_FILE_OPERATION_STATE_ROOT;
const fileUploadMaxBytes = optionalPositiveInteger("ABCM_FILE_UPLOAD_MAX_BYTES");
const fileUploadChunkBytes = optionalPositiveInteger("ABCM_FILE_UPLOAD_CHUNK_BYTES");
const fileUploadTtlMs = optionalPositiveInteger("ABCM_FILE_UPLOAD_TTL_MS");
const fileBatchMaxBytes = optionalPositiveInteger("ABCM_FILE_BATCH_MAX_BYTES");
const sqliteDerivedStoreEnabled = process.env.ABCM_DERIVED_STORE_ENABLED === "true";
const scanLeaseTtlMs = optionalPositiveInteger("ABCM_DERIVED_STORE_SCAN_LEASE_TTL_MS");
const scanLeaseRenewalIntervalMs = optionalPositiveInteger("ABCM_DERIVED_STORE_SCAN_LEASE_RENEWAL_INTERVAL_MS");
const runtimeOwnerTtlMs = optionalPositiveInteger("ABCM_DERIVED_STORE_OWNER_TTL_MS");
const runtimeOwnerRenewalIntervalMs = optionalPositiveInteger("ABCM_DERIVED_STORE_OWNER_RENEWAL_INTERVAL_MS");
const documentationSources = parseDocumentationSources(process.env.ABCM_DOCUMENTATION_SOURCES);
const scopeMapReconcile = parseScopeMapReconcileEnvironment(process.env);
const contextPrincipal = parseContextPrincipalEnvironment(process.env, "stdio-client");
const mcpOperationTimeoutMs = optionalPositiveInteger("ABCM_MCP_OPERATION_TIMEOUT_MS");
const contextLinkGraphSessionTtlMs = optionalPositiveInteger("ABCM_CONTEXT_LINK_GRAPH_SESSION_TTL_MS");
const contextLinkGraphTicketTtlMs = optionalPositiveInteger("ABCM_CONTEXT_LINK_GRAPH_TICKET_TTL_MS");
const contextLinkGraphMaxCandidates = optionalPositiveInteger("ABCM_CONTEXT_LINK_GRAPH_MAX_CANDIDATES");
const contextLinkGraphStateRoot = process.env.ABCM_CONTEXT_LINK_GRAPH_STATE_ROOT;

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
    : (await discoverManagedWorkspaces(workspaceStoreRoot, [workspaceRoot])).filter(workspace => workspace.id !== workspaceId);
const runtime = createAbcmRuntime(
  [{ id: workspaceId, root: workspaceRoot }, ...discoveredWorkspaces],
  {
    contextPrincipal,
    scopeMapAccess: contextPrincipal.access,
    ...(
      contextLinkGraphSessionTtlMs === undefined && contextLinkGraphTicketTtlMs === undefined && contextLinkGraphMaxCandidates === undefined && contextLinkGraphStateRoot === undefined
        ? {}
        : {
            contextLinkGraph: {
              ...(contextLinkGraphSessionTtlMs === undefined ? {} : { ttlMs: contextLinkGraphSessionTtlMs }),
              ...(contextLinkGraphTicketTtlMs === undefined ? {} : { ticketTtlMs: contextLinkGraphTicketTtlMs }),
              ...(contextLinkGraphMaxCandidates === undefined ? {} : { maxCandidates: contextLinkGraphMaxCandidates }),
              ...(contextLinkGraphStateRoot === undefined ? {} : { stateRoot: resolve(contextLinkGraphStateRoot) }),
            },
          }
    ),
    ...(mcpOperationTimeoutMs === undefined ? {} : { mcpOperationTimeoutMs }),
    ...(workspaceStoreRoot === undefined ? {} : { workspaceStoreRoot }),
    ...(fileOperationStateRoot === undefined ? {} : {
      fileOperations: {
        stateRoot: resolve(fileOperationStateRoot),
        ...(fileUploadMaxBytes === undefined ? {} : { maxUploadBytes: fileUploadMaxBytes }),
        ...(fileUploadChunkBytes === undefined ? {} : { maxChunkBytes: fileUploadChunkBytes }),
        ...(fileUploadTtlMs === undefined ? {} : { uploadTtlMs: fileUploadTtlMs }),
        ...(fileBatchMaxBytes === undefined ? {} : { maxBatchBytes: fileBatchMaxBytes }),
      },
    }),
    sqliteDerivedStoreEnabled,
    ...(documentationSources === undefined ? {} : { documentationSources }),
    scopeMapReconcile: {
      ...scopeMapReconcile,
      onBackgroundError: (error, failedWorkspaceId) =>
        console.error(`ABCM periodic ScopeMap reconcile failed for workspace '${failedWorkspaceId}':`, error),
    },
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
await runtime.ready;
await runtime.scopeMap.scan(workspaceId);

const stdio = serveStdio(runtime.createMcpServer, {
  legacy: "serve",
  onerror: error => console.error("ABCM MCP stdio error:", error),
});
installGracefulShutdown(async () => {
  await stdio.close();
  await runtime.close();
});
