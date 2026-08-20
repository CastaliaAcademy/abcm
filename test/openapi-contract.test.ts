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
      paths: Record<string, Record<string, { operationId: string; security?: unknown[]; responses?: Record<string, unknown> }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(createAbcmOpenApiDocument()).toEqual(document);
    expect(document.openapi).toBe("3.1.0");
    expect(Object.values(document.paths).flatMap(path => Object.values(path).map(operation => operation.operationId)).sort()).toEqual([
      "abortWorkspaceUpload",
      "acceptArtifactAmendment",
      "appendWorkspaceUploadChunk",
      "applyDocumentationImport",
      "applyObsidianSyncBatch",
      "applyWorkspaceFileBatch",
      "buildFromContextLinkPackage",
      "buildTaskContext",
      "checkProjectArchitectureCompliance",
      "checkWorkspaceArchitectureCompliance",
      "completeWorkspaceUpload",
      "connectContextLinkGraphWebSocket",
      "createDirectory",
      "createObsidianPairing",
      "createWorkspace",
      "cutoverDocumentationSource",
      "deleteDirectory",
      "deleteFile",
      "deleteProjectArchitecturePolicy",
      "deleteWorkspaceArchitecturePolicy",
      "finalizeContextLinkGraphSession",
      "getAgentInstructions",
      "getArtifactLineage",
      "getContextLinkGraphSession",
      "getDomainLanguage",
      "getObsidianSyncChanges",
      "getObsidianSyncConflict",
      "getOpenApiDocument",
      "getProjectArchitecturePolicy",
      "getScopeMap",
      "getWorkspaceArchitecturePolicy",
      "health",
      "issueArtifactAmendmentApproval",
      "issueContextLinkGraphTicket",
      "listFiles",
      "listOrGetContextLinkPackages",
      "listWorkspaceArchitecturePolicies",
      "moveDirectory",
      "moveFile",
      "previewArtifactAmendment",
      "previewDocumentationSource",
      "previewObsidianSync",
      "previewTaskContext",
      "readFile",
      "readObsidianSyncContent",
      "redeemObsidianPairing",
      "resolveObsidianSyncConflict",
      "revokeObsidianDevice",
      "scanScopeMap",
      "setProjectArchitecturePolicy",
      "setWorkspaceArchitecturePolicy",
      "startContextLinkGraphSession",
      "startWorkspaceUpload",
      "stepContextLinkGraphSession",
      "synchronizeDocumentationSource",
      "writeFile",
    ]);
    expect(document.paths["/v1/context/link-graph/ws"]?.get).toEqual(expect.objectContaining({
      operationId: "connectContextLinkGraphWebSocket",
      security: [],
      responses: expect.objectContaining({ "101": expect.any(Object), "401": expect.any(Object) }),
    }));
    expect(document.components.schemas).toEqual(expect.objectContaining({
      ArchitecturePolicyInput: expect.objectContaining({ additionalProperties: false }),
      ArchitecturePolicyRecord: expect.objectContaining({ additionalProperties: false }),
      ArchitecturePolicyResolution: expect.objectContaining({ additionalProperties: false }),
      ArchitecturePolicyListResult: expect.objectContaining({ additionalProperties: false }),
      ArchitectureCompliance: expect.objectContaining({ additionalProperties: false }),
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
      ContextLinkGraphStartRequest: expect.objectContaining({ additionalProperties: false }),
      ContextLinkGraphSessionResult: expect.objectContaining({ additionalProperties: false }),
      ContextLinkGraphStepRequest: expect.objectContaining({ additionalProperties: false }),
      ContextLinkGraphFinalizeRequest: expect.objectContaining({ additionalProperties: false }),
      ContextLinkGraphFinalizeResult: expect.objectContaining({ additionalProperties: false }),
      ContextLinkPackage: expect.objectContaining({ additionalProperties: false }),
      ContextLinkPackageListResult: expect.objectContaining({ additionalProperties: false }),
      ArtifactAmendmentApprovalIssueRequest: expect.objectContaining({ additionalProperties: false }),
      ArtifactAmendmentApprovalReceipt: expect.objectContaining({ additionalProperties: false }),
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
