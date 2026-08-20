import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { buildTaskContextSchema, normalizeBuildTaskContextInput } from "../src/context/schema.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

const principal: ContextPrincipal = {
  principalId: "agent:typed-reference",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-explicit-documents-")); roots.push(root);
  for (const path of ["domain-language", "project/config", "project/domain-language", "project/artifacts/adr", "project/artifacts/guides", "hidden/config", "hidden/domain-language", "hidden/artifacts"]) {
    await mkdir(join(root, path), { recursive: true });
  }
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: project\n");
  await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/artifacts/adr/decision.md"), "---\nid: decision\nkind: adr\ntitle: Decision\n---\nDECISION_BODY\n");
  await writeFile(join(root, "project/artifacts/guides/guide.md"), "---\nid: guide\nkind: guide\ntitle: Guide\n---\nGUIDE_BODY\n");
  await writeFile(join(root, "hidden/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: hidden\nname: hidden\n");
  await writeFile(join(root, "hidden/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "hidden/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "hidden/artifacts/secret.md"), "---\nid: secret\nkind: guide\ntitle: Secret\n---\nHIDDEN_BODY\n");
  const runtime = createAbcmRuntime({ id: "test", root }, { sqliteDerivedStoreEnabled: true, contextPrincipal: principal });
  await runtime.scopeMap.scan("test");
  const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
  return { runtime, bootstrap };
}

function request(bootstrapId: string, explicitDocuments: unknown[]) {
  return {
    domainLanguageBootstrapId: bootstrapId,
    roleId: "agent",
    taskType: "review",
    goal: "Проверить feature",
    targetHints: { scopeIds: ["project"] },
    explicitDocuments,
    execution: { planId: "PLAN-0031", runId: "typed-reference" },
  };
}

describe("typed explicit document references", () => {
  test("document id, URI и repository file используют один MapRevision index", async () => {
    const { runtime, bootstrap } = await fixture();
    try {
      const references = [
        { input: { selector: "document-id", documentId: "decision", expectedKind: "adr" }, expectedReason: "explicit_link" },
        { input: { selector: "uri", uri: "abcm://artifact/decision", expectedKind: "adr" }, expectedReason: "explicit_link" },
        { input: { selector: "repository-file", path: "project/artifacts/adr/decision.md", expectedKind: "adr" }, expectedReason: "path_exact" },
      ] as const;
      for (const reference of references) {
        const preview = await runtime.restHandler(new Request("http://localhost/v1/context/preview-task-context", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request(bootstrap.bootstrapId, [reference.input])),
        }));
        const body = await preview.json() as { selectedDocuments: Array<{ documentId: string; selectionReasons: string[] }> };
        expect({ status: preview.status, body }).toEqual(expect.objectContaining({ status: 200 }));
        expect(body.selectedDocuments).toContainEqual(expect.objectContaining({ documentId: "decision", selectionReasons: expect.arrayContaining([reference.expectedReason]) }));
      }

      const directory = await runtime.contextBuilder.build(normalizeBuildTaskContextInput(buildTaskContextSchema.parse(request(bootstrap.bootstrapId, [
        { selector: "repository-directory", path: "project/artifacts", recursive: true },
      ]))), principal);
      expect(directory.selectedDocuments.map(document => document.documentId)).toEqual(expect.arrayContaining(["decision", "guide"]));
      expect(directory.selectedDocuments.find(document => document.documentId === "guide")?.selectionReasons).toContain("path_prefix");
      const prefix = await runtime.contextBuilder.build(normalizeBuildTaskContextInput(buildTaskContextSchema.parse(request(bootstrap.bootstrapId, [
        { selector: "repository-prefix", prefix: "project/artifacts/guid" },
      ]))), principal);
      expect(prefix.selectedDocuments.map(document => document.documentId)).toContain("guide");
      expect(prefix.selectedDocuments.find(document => document.documentId === "guide")?.selectionReasons).toContain("path_prefix");

      const mixedRequest = normalizeBuildTaskContextInput(buildTaskContextSchema.parse(request(bootstrap.bootstrapId, [
        { selector: "document-id", documentId: "decision", expectedKind: "adr" },
        { selector: "uri", uri: "abcm://artifact/guide", expectedKind: "guide" },
        { selector: "repository-file", path: "project/artifacts/adr/decision.md", expectedKind: "adr" },
      ])));
      const mixed = await runtime.contextBuilder.build(mixedRequest, principal);
      const repeated = await runtime.contextBuilder.build(mixedRequest, principal);
      expect(mixed.selectedDocuments.map(document => document.documentId)).toEqual(["decision", "guide"]);
      expect(mixed.selectedDocuments.find(document => document.documentId === "decision")?.selectionReasons).toEqual(["explicit_link", "path_exact"]);
      expect(new Set(mixed.selectedDocuments.map(document => document.documentId)).size).toBe(2);
      expect(repeated.bundleDigest).toBe(mixed.bundleDigest);
    } finally {
      await runtime.close();
    }
  });

  test("REST и MCP различают missing, access и kind, а malformed отклоняют общей схемой", async () => {
    const { runtime, bootstrap } = await fixture();
    try {
      const missing = await runtime.restHandler(new Request("http://localhost/v1/context/build-task-context", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request(bootstrap.bootstrapId, [{ selector: "document-id", documentId: "missing" }])),
      }));
      const missingBody = await missing.json();
      expect({ status: missing.status, body: missingBody }).toEqual({ status: 404, body: expect.objectContaining({ code: "CONTEXT_DOCUMENT_NOT_FOUND" }) });

      const wrongKind = await runtime.restHandler(new Request("http://localhost/v1/context/build-task-context", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request(bootstrap.bootstrapId, [{ selector: "document-id", documentId: "decision", expectedKind: "guide" }])),
      }));
      expect(wrongKind.status).toBe(422);
      expect(await wrongKind.json()).toEqual(expect.objectContaining({ code: "CONTEXT_DOCUMENT_KIND_MISMATCH" }));

      const malformed = await runtime.restHandler(new Request("http://localhost/v1/context/build-task-context", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request(bootstrap.bootstrapId, [{ selector: "repository-file", path: "../hidden/artifacts/secret.md" }])),
      }));
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toEqual(expect.objectContaining({ code: "REQUEST_INVALID" }));

      const restricted: ContextPrincipal = {
        principalId: "agent:restricted",
        access: { workspacePermissions: [], scopeGrants: {
          workflow: ["scope.discover", "scope.read_metadata", "context.build"],
          project: ["scope.discover", "scope.read_metadata", "context.build", "document.read"],
        } },
      };
      const restrictedBootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, restricted);
      await expect(runtime.contextBuilder.build(normalizeBuildTaskContextInput(buildTaskContextSchema.parse(request(restrictedBootstrap.bootstrapId, [{ selector: "document-id", documentId: "secret" }]))), restricted)).rejects.toMatchObject({ code: "CONTEXT_DOCUMENT_ACCESS_DENIED" });

      const server = runtime.createMcpServer();
      const client = new Client({ name: "typed-reference-test", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      try {
        const result = await client.callTool({ name: "context.build_task_context", arguments: request(bootstrap.bootstrapId, [{ selector: "document-id", documentId: "missing" }]) });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain("CONTEXT_DOCUMENT_NOT_FOUND");
        expect(result.structuredContent).toEqual(expect.objectContaining({
          error_code: "CONTEXT_DOCUMENT_NOT_FOUND",
        }));
      } finally {
        await client.close(); await server.close();
      }
    } finally {
      await runtime.close();
    }
  });
});
