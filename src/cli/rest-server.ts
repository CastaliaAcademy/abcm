import { resolve } from "node:path";

import { createAbcmRuntime } from "../app/create-runtime.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";
import { parseDocumentationSources } from "../documentation/config.js";
import { parseContextPrincipalEnvironment } from "../domain-language/context-principal-config.js";
import { loadBusinessEvaluationProfiles } from "../evaluation/context-business-eval-config.js";
import { parseTaskSuccessEnvironment } from "../evaluation/task-success-config.js";
import { parseScopeMapReconcileEnvironment } from "../scope-map/reconcile-config.js";
import { parseRestLimitEnvironment } from "../rest/config.js";
import { discoverManagedWorkspaces } from "../workspace/provisioning-service.js";
import type { ContextLinkGraphWebSocketData } from "../context/link-graph-websocket.js";

const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "default";
const workspaceRoot = resolve(process.env.ABCM_WORKSPACE_ROOT ?? process.cwd());
const hostname = process.env.ABCM_HOST ?? "127.0.0.1";
const port = Number(process.env.ABCM_PORT ?? "8787");
const bearerToken = process.env.ABCM_API_TOKEN;
const mcpHttpEnabled = process.env.ABCM_MCP_ENABLED !== "false";
const mcpEndpointPath = process.env.ABCM_MCP_PATH ?? "/mcp";
const mcpOperationTimeoutMs = optionalPositiveInteger("ABCM_MCP_OPERATION_TIMEOUT_MS");
const workspaceStoreRoot = process.env.ABCM_WORKSPACE_STORE_ROOT;
const fileOperationStateRoot = process.env.ABCM_FILE_OPERATION_STATE_ROOT;
const fileUploadMaxBytes = optionalPositiveInteger("ABCM_FILE_UPLOAD_MAX_BYTES");
const fileUploadChunkBytes = optionalPositiveInteger("ABCM_FILE_UPLOAD_CHUNK_BYTES");
const fileUploadTtlMs = optionalPositiveInteger("ABCM_FILE_UPLOAD_TTL_MS");
const fileBatchMaxBytes = optionalPositiveInteger("ABCM_FILE_BATCH_MAX_BYTES");
const obsidianSyncStateRoot = process.env.ABCM_OBSIDIAN_SYNC_STATE_ROOT;
const obsidianSyncPreviewTtlSeconds = optionalPositiveInteger("ABCM_OBSIDIAN_SYNC_PREVIEW_TTL_SECONDS");
const obsidianSyncCredentialTtlSeconds = optionalPositiveInteger("ABCM_OBSIDIAN_SYNC_CREDENTIAL_TTL_SECONDS");
const sqliteDerivedStoreEnabled = process.env.ABCM_DERIVED_STORE_ENABLED === "true";
const scanLeaseTtlMs = optionalPositiveInteger("ABCM_DERIVED_STORE_SCAN_LEASE_TTL_MS");
const scanLeaseRenewalIntervalMs = optionalPositiveInteger("ABCM_DERIVED_STORE_SCAN_LEASE_RENEWAL_INTERVAL_MS");
const runtimeOwnerTtlMs = optionalPositiveInteger("ABCM_DERIVED_STORE_OWNER_TTL_MS");
const runtimeOwnerRenewalIntervalMs = optionalPositiveInteger("ABCM_DERIVED_STORE_OWNER_RENEWAL_INTERVAL_MS");
const documentationSources = parseDocumentationSources(process.env.ABCM_DOCUMENTATION_SOURCES);
const scopeMapReconcile = parseScopeMapReconcileEnvironment(process.env);
const restLimits = parseRestLimitEnvironment(process.env);
const contextPrincipal = parseContextPrincipalEnvironment(process.env, "static-bearer");
const businessEvaluationProfiles = await loadBusinessEvaluationProfiles(process.env.ABCM_BUSINESS_EVALUATION_PROFILES);
const taskSuccessEnvironment = parseTaskSuccessEnvironment(process.env);
const contextLinkGraphSessionTtlMs = optionalPositiveInteger("ABCM_CONTEXT_LINK_GRAPH_SESSION_TTL_MS");
const contextLinkGraphTicketTtlMs = optionalPositiveInteger("ABCM_CONTEXT_LINK_GRAPH_TICKET_TTL_MS");
const contextLinkGraphMaxCandidates = optionalPositiveInteger("ABCM_CONTEXT_LINK_GRAPH_MAX_CANDIDATES");
const contextLinkGraphStateRoot = process.env.ABCM_CONTEXT_LINK_GRAPH_STATE_ROOT;

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
    restLimits,
    ...(mcpOperationTimeoutMs === undefined ? {} : { mcpOperationTimeoutMs }),
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
    ...(allowedHostnames === undefined ? {} : { mcpAllowedHostnames: allowedHostnames }),
    ...(allowedOrigins === undefined ? {} : { mcpAllowedOrigins: allowedOrigins }),
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
    ...(obsidianSyncStateRoot === undefined ? {} : {
      obsidianSync: {
        stateRoot: resolve(obsidianSyncStateRoot),
        ...(obsidianSyncPreviewTtlSeconds === undefined ? {} : { previewTtlSeconds: obsidianSyncPreviewTtlSeconds }),
        ...(obsidianSyncCredentialTtlSeconds === undefined ? {} : { credentialTtlSeconds: obsidianSyncCredentialTtlSeconds }),
      },
    }),
    sqliteDerivedStoreEnabled,
    ...(businessEvaluationProfiles === undefined ? {} : { businessEvaluationProfiles }),
    ...taskSuccessEnvironment,
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

const server = Bun.serve<ContextLinkGraphWebSocketData>({
  hostname,
  port,
  fetch: (request, bunServer) => {
    if (new URL(request.url).pathname === runtime.contextLinkGraphWebSocket?.path) {
      return runtime.contextLinkGraphWebSocket.upgrade(request, bunServer);
    }
    return runtime.httpHandler(request);
  },
  websocket: runtime.contextLinkGraphWebSocket!.handlers,
});
installGracefulShutdown(async () => {
  await server.stop();
  await runtime.close();
});
console.log(
  `ABCM HTTP server listening on ${server.url} (MCP ${mcpHttpEnabled ? mcpEndpointPath : "disabled"}) for workspace '${workspaceId}' at ${workspaceRoot}`,
);
