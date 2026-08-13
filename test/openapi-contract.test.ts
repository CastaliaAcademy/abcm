import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createAbcmOpenApiDocument } from "../src/rest/openapi.js";
import { createAbcmRestHandler } from "../src/rest/create-rest-handler.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

describe("OpenAPI contract", () => {
  test("matches the committed deterministic snapshot generated from shared schemas", async () => {
    const generated = `${JSON.stringify(createAbcmOpenApiDocument(), null, 2)}\n`;
    const committed = await readFile(join(import.meta.dir, "../docs/api/openapi-v1.json"), "utf8");
    expect(generated).toBe(committed);

    const document = createAbcmOpenApiDocument() as {
      openapi: string;
      paths: Record<string, Record<string, { operationId: string }>>;
      components: { schemas: Record<string, unknown> };
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.values(document.paths).flatMap(path => Object.values(path).map(operation => operation.operationId)).sort()).toEqual([
      "applyDocumentationImport",
      "buildTaskContext",
      "createDirectory",
      "createWorkspace",
      "deleteFile",
      "getDomainLanguage",
      "getOpenApiDocument",
      "getScopeMap",
      "health",
      "listFiles",
      "moveFile",
      "previewDocumentationSource",
      "readFile",
      "scanScopeMap",
      "synchronizeDocumentationSource",
      "writeFile",
    ]);
    expect(document.components.schemas).toEqual(expect.objectContaining({
      FileEntry: expect.objectContaining({ additionalProperties: false }),
      DomainLanguageRequest: expect.objectContaining({ additionalProperties: false }),
      BuildTaskContextRequest: expect.objectContaining({ additionalProperties: false }),
      DocumentationPreviewRequest: expect.objectContaining({ additionalProperties: false }),
      Problem: expect.objectContaining({ additionalProperties: false }),
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
