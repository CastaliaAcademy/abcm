import { z } from "zod/v4";

import { ABCM_SERVER_INFO, ABCM_SPEC_VERSION } from "../core/server-info.js";
import { REST_SHARED_SCHEMAS } from "./schemas.js";

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
const filePath = parameter("path", "query", true, { type: "string", minLength: 1 });
const problemResponses = {
  "400": { $ref: "#/components/responses/Problem" },
  "401": { $ref: "#/components/responses/Problem" },
  "403": { $ref: "#/components/responses/Problem" },
  "404": { $ref: "#/components/responses/Problem" },
  "409": { $ref: "#/components/responses/Problem" },
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
