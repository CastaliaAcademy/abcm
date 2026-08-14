type JsonObject = Record<string, unknown>;

const reference = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (description: string, body?: JsonObject) => ({
  description,
  ...(body === undefined ? {} : { content: { "application/json": { schema: body } } }),
});
const parameter = (name: string, location: "path" | "query", required: boolean, value: JsonObject) => ({
  name,
  in: location,
  required,
  schema: value,
});
const implemented = { "x-abcm-implementation-status": "implemented" } as const;
const problemResponses = {
  "400": { $ref: "#/components/responses/Problem" },
  "401": { $ref: "#/components/responses/Problem" },
  "403": { $ref: "#/components/responses/Problem" },
  "404": { $ref: "#/components/responses/Problem" },
  "409": { $ref: "#/components/responses/Problem" },
  "412": { $ref: "#/components/responses/Problem" },
  "413": { $ref: "#/components/responses/Problem" },
  "429": { $ref: "#/components/responses/RateLimitProblem" },
  "500": { $ref: "#/components/responses/Problem" },
  "503": { $ref: "#/components/responses/Problem" },
} as const;
const workspaceId = parameter("workspaceId", "path", true, { type: "string", minLength: 1 });
const projectId = parameter("projectId", "path", true, { type: "string", minLength: 1 });

export const OBSIDIAN_SYNC_OPENAPI_PATHS = {
  "/v1/obsidian/pairings": {
    post: {
      operationId: "createObsidianPairing",
      ...implemented,
      requestBody: { required: true, content: { "application/json": { schema: reference("SyncPairingCreate") } } },
      responses: { "201": response("One-time scoped pairing code", reference("SyncPairingCreateResult")), ...problemResponses },
    },
  },
  "/v1/obsidian/pairings/redeem": {
    post: {
      operationId: "redeemObsidianPairing",
      ...implemented,
      requestBody: { required: true, content: { "application/json": { schema: reference("SyncPairingRedeem") } } },
      responses: { "200": response("Scoped revocable device grant", reference("SyncDeviceGrant")), ...problemResponses },
    },
  },
  "/v1/obsidian/devices/{deviceId}": {
    delete: {
      operationId: "revokeObsidianDevice",
      ...implemented,
      parameters: [parameter("deviceId", "path", true, { type: "string", minLength: 1 })],
      responses: { "204": response("Device grant revoked"), ...problemResponses },
    },
  },
  "/v1/workspaces/{workspaceId}/projects/{projectId}/sync/preview": {
    post: {
      operationId: "previewObsidianSync",
      ...implemented,
      parameters: [workspaceId, projectId],
      requestBody: { required: true, content: { "application/json": { schema: reference("SyncPreviewRequest") } } },
      responses: { "200": response("Non-mutating revision-bound synchronization preview", reference("SyncPreviewResult")), ...problemResponses },
    },
  },
  "/v1/workspaces/{workspaceId}/projects/{projectId}/sync/apply": {
    post: {
      operationId: "applyObsidianSyncBatch",
      ...implemented,
      parameters: [workspaceId, projectId],
      requestBody: { required: true, content: { "application/json": { schema: reference("SyncApplyBatch") } } },
      responses: { "200": response("Idempotent checksummed operation receipts", reference("SyncApplyResult")), ...problemResponses },
    },
  },
  "/v1/workspaces/{workspaceId}/projects/{projectId}/sync/content": {
    get: {
      operationId: "readObsidianSyncContent",
      ...implemented,
      parameters: [workspaceId, projectId, parameter("path", "query", true, { type: "string", minLength: 1, maxLength: 1024 })],
      responses: {
        "200": { description: "Exact project file bytes", headers: { ETag: { schema: { type: "string" } }, "X-Abcm-Object-Id": { schema: { type: "string" } } }, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
        ...problemResponses,
      },
    },
  },
  "/v1/workspaces/{workspaceId}/projects/{projectId}/sync/changes": {
    get: {
      operationId: "getObsidianSyncChanges",
      ...implemented,
      parameters: [workspaceId, projectId, parameter("cursor", "query", true, { type: "string", minLength: 8 }), parameter("limit", "query", false, { type: "integer", minimum: 1, maximum: 1000, default: 100 })],
      responses: { "200": response("Ordered durable changes after the opaque cursor", reference("SyncChangesResult")), ...problemResponses },
    },
  },
  "/v1/workspaces/{workspaceId}/projects/{projectId}/sync/conflicts/{conflictId}": {
    get: {
      operationId: "getObsidianSyncConflict",
      ...implemented,
      parameters: [workspaceId, projectId, parameter("conflictId", "path", true, { type: "string", minLength: 1 })],
      responses: { "200": response("Synchronization conflict status", reference("SyncConflict")), ...problemResponses },
    },
  },
  "/v1/workspaces/{workspaceId}/projects/{projectId}/sync/conflicts/{conflictId}/resolve": {
    post: {
      operationId: "resolveObsidianSyncConflict",
      ...implemented,
      parameters: [workspaceId, projectId, parameter("conflictId", "path", true, { type: "string", minLength: 1 })],
      requestBody: { required: true, content: { "application/json": { schema: reference("SyncConflictResolution") } } },
      responses: { "200": response("Explicit checksummed conflict resolution", reference("SyncOperationReceipt")), ...problemResponses },
    },
  },
} satisfies Record<string, JsonObject>;
