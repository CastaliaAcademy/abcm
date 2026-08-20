import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-link-graph-adapters-"));
  roots.push(root);
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "project", "config"), { recursive: true });
  await mkdir(join(root, "project", "domain-language"), { recursive: true });
  await mkdir(join(root, "project", "artifacts", "adr"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: Workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project", "scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
  await writeFile(join(root, "project", "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project", "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(
    join(root, "project", "artifacts", "adr", "DOC-A.md"),
    "---\nid: DOC-A\nkind: adr\ntitle: Alpha\n---\n[[DOC-B]]\n",
  );
  await writeFile(
    join(root, "project", "artifacts", "adr", "DOC-B.md"),
    "---\nid: DOC-B\nkind: adr\ntitle: Beta\n---\nConfirmed body\n",
  );
  const access = {
    workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read"] as const,
  };
  const principal = { principalId: "adapter-agent", access };
  const runtime = createAbcmRuntime({ id: "test", root }, { contextPrincipal: principal, scopeMapAccess: access });
  await runtime.scopeMap.scan("test");
  const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
  const contextRequest = {
    domainLanguageBootstrapId: bootstrap.bootstrapId,
    roleId: "agent",
    taskType: "implementation",
    goal: "Изменить проект",
    targetHints: { scopeIds: ["project"] },
  };
  const server = runtime.createMcpServer();
  const client = new Client({ name: "link-graph-adapter-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { runtime, server, client, contextRequest };
}

describe("interactive link-graph REST and MCP adapters", () => {
  test("expose the same body-free session lifecycle and standard finalization", async () => {
    const { runtime, server, client, contextRequest } = await fixture();
    try {
      const restStartResponse = await runtime.restHandler(new Request("http://localhost/v1/context/link-graph/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: "test", request: contextRequest, seedDocumentIds: ["DOC-A"] }),
      }));
      expect(restStartResponse.status).toBe(201);
      const restStart = await restStartResponse.json() as {
        sessionId: string;
        stateDigest: string;
        candidates: Array<{ documentId: string }>;
      };
      expect(restStart.candidates.map(candidate => candidate.documentId)).toEqual(["DOC-B"]);
      expect(JSON.stringify(restStart)).not.toContain("Confirmed body");

      const restStepResponse = await runtime.restHandler(new Request(`http://localhost/v1/context/link-graph/sessions/${restStart.sessionId}/steps`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sequence: 1,
          previousStateDigest: restStart.stateDigest,
          operation: { kind: "confirm", documentIds: ["DOC-B"] },
        }),
      }));
      const restStep = await restStepResponse.json() as { stateDigest: string; confirmedDocumentIds: string[] };
      expect(restStep.confirmedDocumentIds).toEqual(["DOC-B"]);
      const restFinalize = await runtime.restHandler(new Request(`http://localhost/v1/context/link-graph/sessions/${restStart.sessionId}/finalize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedStateDigest: restStep.stateDigest }),
      }));
      expect(restFinalize.status).toBe(200);
      const finalized = await restFinalize.json() as {
        bundle: { selectedDocuments: Array<{ documentId: string }> };
        receipt: { confirmedDocumentIds: string[]; steps: unknown[] };
      };
      expect(finalized.bundle.selectedDocuments.map(document => document.documentId)).toContain("DOC-B");
      expect(finalized.receipt.confirmedDocumentIds).toEqual(["DOC-B"]);
      expect(finalized.receipt.steps).toHaveLength(1);

      const mcpStart = await client.callTool({
        name: "context.start_link_graph_session",
        arguments: { workspaceId: "test", request: contextRequest, seedDocumentIds: ["DOC-A"] },
      });
      expect(mcpStart.isError).not.toBe(true);
      expect((mcpStart.structuredContent as { candidates: Array<{ documentId: string }> }).candidates.map(candidate => candidate.documentId)).toEqual(["DOC-B"]);
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
