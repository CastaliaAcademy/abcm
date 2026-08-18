import { describe, expect, test } from "bun:test";

import { createAbcmOpenApiDocument } from "../src/rest/openapi.js";
import { createAbcmRestHandler } from "../src/rest/create-rest-handler.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

describe("OpenAPI contract", () => {
  test("is generated deterministically from shared schemas", () => {
    const document = createAbcmOpenApiDocument() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(createAbcmOpenApiDocument()).toEqual(document);
    expect(document.openapi).toBe("3.1.0");
    expect(Object.values(document.paths).flatMap(path => Object.values(path).map(operation => operation.operationId)).sort()).toEqual([
      "abortWorkspaceUpload",
      "appendWorkspaceUploadChunk",
      "applyDocumentationImport",
      "applyObsidianSyncBatch",
      "applyWorkspaceFileBatch",
      "buildTaskContext",
      "completeWorkspaceUpload",
      "createDirectory",
      "createObsidianPairing",
      "createWorkspace",
      "cutoverDocumentationSource",
      "deleteDirectory",
      "deleteFile",
      "getAgentInstructions",
      "getDomainLanguage",
      "getObsidianSyncChanges",
      "getObsidianSyncConflict",
      "getOpenApiDocument",
      "getScopeMap",
      "health",
      "listContextOutcomes",
      "listFiles",
      "moveDirectory",
      "moveFile",
      "previewDocumentationSource",
      "previewObsidianSync",
      "previewTaskContext",
      "readFile",
      "readObsidianSyncContent",
      "recordContextOutcome",
      "redeemObsidianPairing",
      "resolveObsidianSyncConflict",
      "revokeObsidianDevice",
      "scanScopeMap",
      "startWorkspaceUpload",
      "synchronizeDocumentationSource",
      "writeFile",
    ]);
    expect(document.components.schemas).toEqual(expect.objectContaining({
      FileEntry: expect.objectContaining({ additionalProperties: false }),
      MoveDirectoryRequest: expect.objectContaining({ additionalProperties: false }),
      WorkspaceUploadStartRequest: expect.objectContaining({ additionalProperties: false }),
      WorkspaceUploadStartResult: expect.objectContaining({ additionalProperties: false }),
      WorkspaceUploadChunkResult: expect.objectContaining({ additionalProperties: false }),
      WorkspaceUploadCompleteResult: expect.objectContaining({ additionalProperties: false }),
      WorkspaceBatchApplyRequest: expect.objectContaining({ additionalProperties: false }),
      WorkspaceBatchApplyResult: expect.objectContaining({ additionalProperties: false }),
      DomainLanguageRequest: expect.objectContaining({ additionalProperties: false }),
      BuildTaskContextRequest: expect.objectContaining({ additionalProperties: false }),
      PreviewTaskContextResult: expect.objectContaining({ additionalProperties: false }),
      ContextOutcomeSubmission: expect.objectContaining({ additionalProperties: false }),
      ContextOutcomeReceipt: expect.objectContaining({ additionalProperties: false }),
      ContextOutcomeListResult: expect.objectContaining({ additionalProperties: false }),
      DocumentationPreviewRequest: expect.objectContaining({ additionalProperties: false }),
      DocumentationCutoverRequest: expect.objectContaining({ additionalProperties: false }),
      SyncPairingCreate: expect.objectContaining({ additionalProperties: false }),
      SyncPairingRedeem: expect.objectContaining({ additionalProperties: false }),
      SyncDeviceGrant: expect.objectContaining({ additionalProperties: false }),
      SyncPreviewRequest: expect.objectContaining({ additionalProperties: false }),
      SyncPreviewResult: expect.objectContaining({ additionalProperties: false }),
      SyncApplyBatch: expect.objectContaining({ additionalProperties: false }),
      SyncApplyResult: expect.objectContaining({ additionalProperties: false }),
      SyncChangesResult: expect.objectContaining({ additionalProperties: false }),
      SyncConflictResolution: expect.objectContaining({ oneOf: expect.any(Array) }),
      Problem: expect.objectContaining({ additionalProperties: false }),
    }));
    const contextInput = document.components.schemas.BuildTaskContextRequest as {
      properties: { targetHints: { anyOf: Array<{ properties?: { scopeIds?: { minItems?: number; maxItems?: number; items?: unknown } } }> } };
    };
    const contextOutput = document.components.schemas.BuildTaskContextResult as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    const structuredHints = contextInput.properties.targetHints.anyOf.find(option => option.properties?.scopeIds !== undefined);
    expect(structuredHints?.properties?.scopeIds).toEqual(expect.objectContaining({
      minItems: 1,
      maxItems: 8,
      items: expect.objectContaining({ anyOf: expect.any(Array) }),
    }));
    expect(contextOutput.required).toEqual(expect.arrayContaining([
      "multiScopePolicyDigest",
      "affectedScopeDetails",
      "budgetAllocation",
    ]));
    expect(contextOutput.properties).toEqual(expect.objectContaining({
      multiScopePolicyDigest: expect.any(Object),
      affectedScopeDetails: expect.any(Object),
      budgetAllocation: expect.any(Object),
    }));
  });

  test("serves the same OpenAPI document through the REST adapter", async () => {
    const registry = new WorkspaceRegistry([]);
    const handler = createAbcmRestHandler({ files: new WorkspaceFileService(registry), scopeMap: new ScopeMapService(registry) });
    const response = await handler(new Request("http://localhost/openapi.json"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(createAbcmOpenApiDocument());
  });
});
