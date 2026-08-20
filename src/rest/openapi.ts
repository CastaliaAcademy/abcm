import { z } from "zod/v4";

import { ABCM_SERVER_INFO, ABCM_SPEC_VERSION } from "../core/server-info.js";
import { REST_SHARED_SCHEMAS } from "./schemas.js";
import { OBSIDIAN_SYNC_OPENAPI_PATHS } from "../sync/openapi.js";

type JsonObject = Record<string, unknown>;

function schema(value: z.ZodType): JsonObject {
  const generated = z.toJSONSchema(value) as JsonObject;
  const { $schema: _dialect, ...openApiSchema } = generated;
  return openApiSchema;
}

const reference = (name: keyof typeof REST_SHARED_SCHEMAS) => ({ $ref: `#/components/schemas/${name}` });
const response = (description: string, body?: JsonObject, contentType = "application/json") => ({
  description,
  ...(body === undefined ? {} : { content: { [contentType]: { schema: body } } }),
});
const parameter = (name: string, location: "path" | "query" | "header", required: boolean, value: JsonObject) => ({
  name,
  in: location,
  required,
  schema: value,
});
const workspaceId = parameter("workspaceId", "path", true, { type: "string", minLength: 1 });
const projectId = parameter("projectId", "path", true, { type: "string", minLength: 1 });
const graphSessionId = parameter("sessionId", "path", true, { type: "string", pattern: "^graph-session-[a-f0-9]{24}$" });
const filePath = parameter("path", "query", true, { type: "string", minLength: 1 });
const problemResponses = {
  "400": { $ref: "#/components/responses/Problem" },
  "401": { $ref: "#/components/responses/Problem" },
  "403": { $ref: "#/components/responses/Problem" },
  "404": { $ref: "#/components/responses/Problem" },
  "409": { $ref: "#/components/responses/Problem" },
  "410": { $ref: "#/components/responses/Problem" },
  "412": { $ref: "#/components/responses/Problem" },
  "413": { $ref: "#/components/responses/Problem" },
  "415": { $ref: "#/components/responses/Problem" },
  "429": { $ref: "#/components/responses/RateLimitProblem" },
  "499": { $ref: "#/components/responses/Problem" },
  "500": { $ref: "#/components/responses/Problem" },
  "503": { $ref: "#/components/responses/Problem" },
  "504": { $ref: "#/components/responses/Problem" },
} as const;

export function createAbcmOpenApiDocument(): JsonObject {
  return {
    openapi: "3.1.0",
    info: {
      title: "ABCM REST API",
      version: ABCM_SERVER_INFO.version,
      description: `REST adapter for ABCM specification ${ABCM_SPEC_VERSION}.`,
      license: { name: "MIT" },
    },
    servers: [{ url: "/", description: "Current ABCM server" }],
    security: [{ bearerAuth: [] }],
    paths: {
      ...OBSIDIAN_SYNC_OPENAPI_PATHS,
      "/health": {
        get: {
          operationId: "health",
          security: [],
          responses: { "200": response("Service health", { type: "object" }) },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApiDocument",
          responses: { "200": response("OpenAPI 3.1 contract", { type: "object" }) },
        },
      },
      "/v1/agent-instructions": {
        get: {
          operationId: "getAgentInstructions",
          description: "Complete self-contained setup and operating guide that an agent must read before using ABCM.",
          responses: {
            "200": response("Canonical ABCM agent instructions", { type: "string" }, "text/markdown"),
            ...problemResponses,
          },
        },
      },
      "/v1/workspaces": {
        post: {
          operationId: "createWorkspace",
          requestBody: { required: true, content: { "application/json": { schema: reference("WorkspaceRegistration") } } },
          responses: { "201": response("Workspace created", reference("WorkspaceRegistrationResult")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/architecture-policy": {
        get: {
          operationId: "getWorkspaceArchitecturePolicy",
          parameters: [workspaceId],
          responses: { "200": response("Configured and effective workspace architecture policy", reference("ArchitecturePolicyResolution")), ...problemResponses },
        },
        put: {
          operationId: "setWorkspaceArchitecturePolicy",
          parameters: [workspaceId, parameter("If-Match", "header", false, { type: "string" }), parameter("If-None-Match", "header", false, { type: "string", enum: ["*"] })],
          requestBody: { required: true, content: { "application/json": { schema: reference("ArchitecturePolicyInput") } } },
          responses: { "200": response("Workspace architecture policy replaced", reference("ArchitecturePolicyRecord")), "201": response("Workspace architecture policy created", reference("ArchitecturePolicyRecord")), ...problemResponses },
        },
        delete: {
          operationId: "deleteWorkspaceArchitecturePolicy",
          parameters: [workspaceId, parameter("If-Match", "header", false, { type: "string" })],
          responses: { "204": response("Workspace architecture policy deleted"), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/architecture-policies": {
        get: {
          operationId: "listWorkspaceArchitecturePolicies",
          parameters: [workspaceId],
          responses: { "200": response("Workspace and project architecture policies", reference("ArchitecturePolicyListResult")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/architecture-compliance": {
        get: {
          operationId: "checkWorkspaceArchitectureCompliance",
          parameters: [workspaceId],
          responses: { "200": response("Workspace architecture compliance", reference("ArchitectureCompliance")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/projects/{projectId}/architecture-policy": {
        get: {
          operationId: "getProjectArchitecturePolicy",
          parameters: [workspaceId, projectId],
          responses: { "200": response("Configured and inherited project architecture policy", reference("ArchitecturePolicyResolution")), ...problemResponses },
        },
        put: {
          operationId: "setProjectArchitecturePolicy",
          parameters: [workspaceId, projectId, parameter("If-Match", "header", false, { type: "string" }), parameter("If-None-Match", "header", false, { type: "string", enum: ["*"] })],
          requestBody: { required: true, content: { "application/json": { schema: reference("ArchitecturePolicyInput") } } },
          responses: { "200": response("Project architecture policy replaced", reference("ArchitecturePolicyRecord")), "201": response("Project architecture policy created", reference("ArchitecturePolicyRecord")), ...problemResponses },
        },
        delete: {
          operationId: "deleteProjectArchitecturePolicy",
          parameters: [workspaceId, projectId, parameter("If-Match", "header", false, { type: "string" })],
          responses: { "204": response("Project architecture policy deleted; workspace inheritance resumes", undefined), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/projects/{projectId}/architecture-compliance": {
        get: {
          operationId: "checkProjectArchitectureCompliance",
          parameters: [workspaceId, projectId],
          responses: { "200": response("Project architecture compliance", reference("ArchitectureCompliance")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/files": {
        get: {
          operationId: "listFiles",
          parameters: [workspaceId, parameter("path", "query", false, { type: "string", default: "" }), parameter("recursive", "query", false, { type: "boolean", default: false })],
          responses: { "200": response("Allowed file entries", { type: "array", items: reference("FileEntry") }), ...problemResponses },
        },
        delete: {
          operationId: "deleteFile",
          parameters: [workspaceId, filePath, parameter("If-Match", "header", false, { type: "string" })],
          responses: { "204": response("File deleted"), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/files/content": {
        get: {
          operationId: "readFile",
          parameters: [workspaceId, filePath],
          responses: { "200": response("Exact file bytes", { type: "string", format: "binary" }, "application/octet-stream"), ...problemResponses },
        },
        put: {
          operationId: "writeFile",
          parameters: [workspaceId, filePath, parameter("If-Match", "header", false, { type: "string" }), parameter("If-None-Match", "header", false, { type: "string", enum: ["*"] })],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          responses: { "200": response("File entry", reference("FileEntry")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/uploads": {
        post: {
          operationId: "startWorkspaceUpload",
          description: "Start a durable upload whose completed bytes can be referenced by workspace batch operations.",
          parameters: [workspaceId],
          requestBody: { required: true, content: { "application/json": { schema: reference("WorkspaceUploadStartRequest") } } },
          responses: { "201": response("Upload session started", reference("WorkspaceUploadStartResult")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/uploads/{uploadId}/chunks/{index}": {
        put: {
          operationId: "appendWorkspaceUploadChunk",
          description: "Append the next raw byte chunk. Repeating the same index and checksum is idempotent.",
          parameters: [
            workspaceId,
            parameter("uploadId", "path", true, { type: "string", pattern: "^upl_[a-f0-9]{32}$" }),
            parameter("index", "path", true, { type: "integer", minimum: 0 }),
            parameter("X-Content-Sha256", "header", true, { type: "string", pattern: "^sha256:[a-f0-9]{64}$" }),
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          responses: { "200": response("Upload chunk accepted", reference("WorkspaceUploadChunkResult")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/uploads/{uploadId}/complete": {
        post: {
          operationId: "completeWorkspaceUpload",
          description: "Validate the declared size and checksum, then make the upload immutable.",
          parameters: [workspaceId, parameter("uploadId", "path", true, { type: "string", pattern: "^upl_[a-f0-9]{32}$" })],
          responses: { "200": response("Upload completed", reference("WorkspaceUploadCompleteResult")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/uploads/{uploadId}": {
        delete: {
          operationId: "abortWorkspaceUpload",
          description: "Delete an upload session and its staged bytes.",
          parameters: [workspaceId, parameter("uploadId", "path", true, { type: "string", pattern: "^upl_[a-f0-9]{32}$" })],
          responses: { "204": response("Upload aborted"), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/files/batch:apply": {
        post: {
          operationId: "applyWorkspaceFileBatch",
          description: "Validate and atomically apply mixed create, update, delete, and move operations. Create and update operations reference completed uploads.",
          parameters: [workspaceId],
          requestBody: { required: true, content: { "application/json": { schema: reference("WorkspaceBatchApplyRequest") } } },
          responses: { "200": response("Batch validated or applied", reference("WorkspaceBatchApplyResult")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/files/move": {
        post: {
          operationId: "moveFile",
          parameters: [workspaceId],
          requestBody: { required: true, content: { "application/json": { schema: reference("MoveFileRequest") } } },
          responses: { "200": response("Moved file entry", reference("FileEntry")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/directories": {
        post: {
          operationId: "createDirectory",
          parameters: [workspaceId],
          requestBody: { required: true, content: { "application/json": { schema: reference("CreateDirectoryRequest") } } },
          responses: { "201": response("Directory entry", reference("FileEntry")), ...problemResponses },
        },
        delete: {
          operationId: "deleteDirectory",
          parameters: [workspaceId, parameter("path", "query", true, { type: "string", minLength: 1 }), parameter("recursive", "query", true, { type: "boolean", enum: [true] })],
          responses: { "204": { description: "Directory recursively deleted" }, ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/directories/move": {
        post: {
          operationId: "moveDirectory",
          parameters: [workspaceId],
          requestBody: { required: true, content: { "application/json": { schema: reference("MoveDirectoryRequest") } } },
          responses: { "200": response("Moved directory entry", reference("FileEntry")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/scope-map/scan": {
        post: {
          operationId: "scanScopeMap",
          parameters: [workspaceId],
          responses: { "200": response("Published ScopeMap summary", reference("ScopeMapScanResult")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/scope-map": {
        get: {
          operationId: "getScopeMap",
          parameters: [workspaceId, parameter("view", "query", false, { type: "string", enum: ["agent", "admin"], default: "agent" }), parameter("rootScopeId", "query", false, { type: "string" }), parameter("depth", "query", false, { type: "integer", minimum: 0 }), parameter("includeInvalid", "query", false, { type: "boolean" })],
          responses: { "200": response("Bounded ScopeMap projection", { type: "object" }), ...problemResponses },
        },
      },
      "/v1/context/domain-language": {
        post: {
          operationId: "getDomainLanguage",
          requestBody: { required: true, content: { "application/json": { schema: reference("DomainLanguageRequest") } } },
          responses: { "200": response("Domain-language bootstrap", reference("DomainLanguageResult")), ...problemResponses },
        },
      },
      "/v1/context/build-task-context": {
        post: {
          operationId: "buildTaskContext",
          requestBody: { required: true, content: { "application/json": { schema: reference("BuildTaskContextRequest") } } },
          responses: { "200": response("Bounded task context", reference("BuildTaskContextResult")), ...problemResponses },
        },
      },
      "/v1/context/preview-task-context": {
        post: {
          operationId: "previewTaskContext",
          description: "Body-free, non-persisting explanation of deterministic context selection and available fallback modes.",
          requestBody: { required: true, content: { "application/json": { schema: reference("BuildTaskContextRequest") } } },
          responses: { "200": response("Explainable task context preview", reference("PreviewTaskContextResult")), ...problemResponses },
        },
      },
      "/v1/context/link-graph/sessions": {
        post: {
          operationId: "startContextLinkGraphSession",
          description: "Start a principal-bound, revision-pinned, body-free interactive link-graph session.",
          requestBody: { required: true, content: { "application/json": { schema: reference("ContextLinkGraphStartRequest") } } },
          responses: { "201": response("Interactive link-graph session started", reference("ContextLinkGraphSessionResult")), ...problemResponses },
        },
      },
      "/v1/context/link-graph/sessions/{sessionId}": {
        get: {
          operationId: "getContextLinkGraphSession",
          parameters: [graphSessionId],
          responses: { "200": response("Current body-free link-graph session state", reference("ContextLinkGraphSessionResult")), ...problemResponses },
        },
      },
      "/v1/context/link-graph/sessions/{sessionId}/steps": {
        post: {
          operationId: "stepContextLinkGraphSession",
          parameters: [graphSessionId],
          requestBody: { required: true, content: { "application/json": { schema: reference("ContextLinkGraphStepRequest") } } },
          responses: { "200": response("Updated body-free link-graph session state", reference("ContextLinkGraphSessionResult")), ...problemResponses },
        },
      },
      "/v1/context/link-graph/sessions/{sessionId}/finalize": {
        post: {
          operationId: "finalizeContextLinkGraphSession",
          parameters: [graphSessionId],
          requestBody: { required: true, content: { "application/json": { schema: reference("ContextLinkGraphFinalizeRequest") } } },
          responses: { "200": response("Immutable context bundle and body-free graph retrieval receipt", reference("ContextLinkGraphFinalizeResult")), ...problemResponses },
        },
      },
      "/v1/context/link-graph/sessions/{sessionId}/ticket": {
        post: {
          operationId: "issueContextLinkGraphTicket",
          description: "Issue a new short-lived one-time WebSocket subprotocol ticket for reconnecting to an unchanged session.",
          parameters: [graphSessionId],
          requestBody: { required: true, content: { "application/json": { schema: reference("ContextLinkGraphFinalizeRequest") } } },
          responses: { "201": response("One-time WebSocket ticket issued", reference("ContextLinkGraphSessionResult")), ...problemResponses },
        },
      },
      "/v1/context/link-graph/ws": {
        get: {
          operationId: "connectContextLinkGraphWebSocket",
          description: "Upgrade to the step-only WebSocket transport. Authentication uses the short-lived one-time abcm.ticket.* subprotocol returned by session start or ticket reissue; a bearer credential must not be placed in the URL.",
          security: [],
          parameters: [parameter("Sec-WebSocket-Protocol", "header", true, {
            type: "string",
            description: "Comma-separated abcm.link-graph.v1, abcm.session.<sessionId>, and abcm.ticket.<one-time-ticket> protocols.",
          })],
          responses: {
            "101": { description: "WebSocket upgrade accepted; only sequenced session step messages are transported." },
            "400": problemResponses["400"],
            "401": problemResponses["401"],
            "426": { $ref: "#/components/responses/Problem" },
          },
        },
      },
      "/v1/context/link-packages": {
        get: {
          operationId: "listOrGetContextLinkPackages",
          description: "List or get access-filtered virtual packages derived from document tags.",
          parameters: [
            parameter("workspaceId", "query", true, { type: "string" }),
            parameter("packageId", "query", false, { type: "string", pattern: "^tag-package-[a-f0-9]{24}$" }),
          ],
          responses: { "200": response("Tag-derived package or package list", { oneOf: [reference("ContextLinkPackage"), reference("ContextLinkPackageListResult")] }), ...problemResponses },
        },
      },
      "/v1/context/link-packages/build": {
        post: {
          operationId: "buildFromContextLinkPackage",
          description: "Bind the tag package to the bootstrap workspace, reauthorize every member and build through ContextBuilder.",
          requestBody: { required: true, content: { "application/json": { schema: reference("ContextLinkPackageBuildRequest") } } },
          responses: { "200": response("ContextBundle built after consumer reauthorization", reference("ContextLinkPackageBuildResult")), ...problemResponses },
        },
      },
      "/v1/artifact-amendments/preview": {
        post: {
          operationId: "previewArtifactAmendment",
          requestBody: { required: true, content: { "application/json": { schema: reference("ArtifactAmendmentPreviewRequest") } } },
          responses: { "200": response("Canonical amendment approval payload", reference("ArtifactAmendmentPreview")), ...problemResponses },
        },
      },
      "/v1/operator/artifact-amendment-approvals": {
        post: {
          operationId: "issueArtifactAmendmentApproval",
          description: "Issue a short-lived server-stored one-time approval using the separate operator identity. The agent bearer token is not accepted.",
          requestBody: { required: true, content: { "application/json": { schema: reference("ArtifactAmendmentApprovalIssueRequest") } } },
          responses: { "201": response("Server-issued amendment approval", reference("ArtifactAmendmentApprovalReceipt")), ...problemResponses },
        },
      },
      "/v1/artifact-amendments/accept": {
        post: {
          operationId: "acceptArtifactAmendment",
          requestBody: { required: true, content: { "application/json": { schema: reference("ArtifactAmendmentAcceptRequest") } } },
          responses: { "200": response("Immutable amendment receipt", reference("ArtifactAmendmentReceipt")), ...problemResponses },
        },
      },
      "/v1/artifact-lineages": {
        get: {
          operationId: "getArtifactLineage",
          parameters: [parameter("workspaceId", "query", true, { type: "string" }), parameter("lineageId", "query", true, { type: "string" })],
          responses: { "200": response("Artifact lineage inside the active MapRevision", reference("ArtifactLineage")), ...problemResponses },
        },
      },
      "/v1/workspaces/{workspaceId}/documentation-sources/preview": {
        post: {
          operationId: "previewDocumentationSource",
          parameters: [workspaceId],
          requestBody: { required: true, content: { "application/json": { schema: reference("DocumentationPreviewRequest") } } },
          responses: { "200": response("Documentation import preview", reference("DocumentationPreviewResult")), ...problemResponses },
        },
      },
      "/v1/documentation-imports/{importId}/apply": {
        post: {
          operationId: "applyDocumentationImport",
          parameters: [parameter("importId", "path", true, { type: "string", minLength: 1 })],
          responses: { "200": response("Documentation sync result", reference("DocumentationSyncResult")), ...problemResponses },
        },
      },
      "/v1/documentation-sources/{sourceId}/sync": {
        post: {
          operationId: "synchronizeDocumentationSource",
          parameters: [parameter("sourceId", "path", true, { type: "string", minLength: 1 })],
          responses: { "200": response("Documentation sync result", reference("DocumentationSyncResult")), ...problemResponses },
        },
      },
      "/v1/documentation-sources/{sourceId}/cutover": {
        post: {
          operationId: "cutoverDocumentationSource",
          parameters: [parameter("sourceId", "path", true, { type: "string", minLength: 1 })],
          requestBody: { required: true, content: { "application/json": { schema: reference("DocumentationCutoverRequest") } } },
          responses: { "200": response("Documentation cutover result", reference("DocumentationCutoverResult")), ...problemResponses },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
      },
      schemas: {
        ...Object.fromEntries(Object.entries(REST_SHARED_SCHEMAS).map(([name, value]) => [name, schema(value)])),
        Problem: {
          type: "object",
          required: ["type", "title", "status", "detail", "code"],
          properties: {
            type: { type: "string", format: "uri" },
            title: { type: "string" },
            status: { type: "integer", minimum: 400, maximum: 599 },
            detail: { type: "string" },
            code: { type: "string" },
            details: { type: "object", additionalProperties: true },
          },
          additionalProperties: false,
        },
      },
      responses: {
        Problem: response("ABCM Problem Details", { $ref: "#/components/schemas/Problem" }, "application/problem+json"),
        RateLimitProblem: {
          ...response("ABCM rate-limit Problem Details", { $ref: "#/components/schemas/Problem" }, "application/problem+json"),
          headers: {
            "Retry-After": {
              description: "Seconds until the current fixed rate-limit window resets.",
              schema: { type: "integer", minimum: 1, maximum: 60 },
            },
          },
        },
      },
    },
  };
}
