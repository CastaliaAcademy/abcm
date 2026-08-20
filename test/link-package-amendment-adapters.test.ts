import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function json(response: Response) {
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBeLessThan(300);
  return body as Record<string, any>;
}

describe("LinkPackage and Amendment adapters", () => {
  test("keeps REST and MCP on the same checksum, authorization and lineage contracts", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-link-package-adapters-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "abcm-link-package-state-"));
    roots.push(root, stateRoot);
    await mkdir(join(root, "domain-language"), { recursive: true });
    await mkdir(join(root, "project/config"), { recursive: true });
    await mkdir(join(root, "project/domain-language"), { recursive: true });
    await mkdir(join(root, "project/artifacts/adr"), { recursive: true });
    await mkdir(join(root, "project/artifacts/guides"), { recursive: true });
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workspace\nname: Workspace\n");
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
    await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
    await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(root, "project/artifacts/guides/guide.md"), "---\nid: guide\nkind: guide\ntitle: Guide\nstatus: active\ntags: [reusable-context]\n---\nPackage context body. #reusable-context\n");
    const basePath = "project/artifacts/adr/ADR-V1.md";
    const baseBytes = "---\nid: ADR-V1\nkind: adr\ntitle: Decision v1\nstatus: accepted\nlineageId: decision\n---\nOriginal immutable decision.\n";
    await writeFile(join(root, basePath), baseBytes);

    const principal = {
      principalId: "adapter-consumer",
      access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read", "executable_resource.read"] as const },
    };
    const runtime = createAbcmRuntime({ id: "workspace", root }, {
      bearerToken: "agent-secret-12345678",
      contextPrincipal: principal,
      scopeMapAccess: principal.access,
      fileOperations: { stateRoot },
      artifactAmendments: { stateRoot: join(stateRoot, "amendments"), operatorToken: "operator-secret-123456", operatorIdentity: "release-operator" },
    });
    const server = runtime.createMcpServer();
    const client = new Client({ name: "adapter-test", version: "1.0.0" }, { supportedProtocolVersions: ["2025-11-25"] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await runtime.ready;
      let revision = await runtime.scopeMap.scan("workspace");
      const base = revision.documents.find(document => document.artifactId === "ADR-V1")!;
      const draftPath = "project/artifacts/adr/ADR-V2.md";
      await writeFile(join(root, draftPath), `---\nid: ADR-V2\nkind: adr\ntitle: Decision v2\nstatus: draft\nlineageId: decision\namends: ADR-V1\nbaseArtifactId: ADR-V1\nbaseChecksum: ${base.checksum}\nexpectedLineageHead: ADR-V1\n---\nNew normative meaning.\n`);
      revision = await runtime.scopeMap.scan("workspace");
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const listed = await json(await runtime.httpHandler(new Request("http://localhost/v1/context/link-packages?workspaceId=workspace", { headers: { authorization: "Bearer agent-secret-12345678" } })));
      const tagPackage = listed.packages.find((entry: { tag: string }) => entry.tag === "reusable-context");
      const fetched = await client.callTool({ name: "context.get_link_package", arguments: { workspaceId: "workspace", packageId: tagPackage.packageId } });
      expect(fetched.isError).not.toBe(true);
      expect(fetched.structuredContent).toEqual(expect.objectContaining({ packageId: tagPackage.packageId, source: "document-tags" }));
      const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "workspace", projectId: "project" }, roleId: "implementation-agent" }, principal);
      const built = await json(await runtime.httpHandler(new Request("http://localhost/v1/context/link-packages/build", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-secret-12345678" },
        body: JSON.stringify({
          workspaceId: "workspace",
          packageId: tagPackage.packageId,
          request: {
            domainLanguageBootstrapId: bootstrap.bootstrapId,
            roleId: "implementation-agent",
            taskType: "implementation",
            goal: "Use the published package.",
            targetHints: { scopeIds: ["project"] },
            budgetProfile: "expanded",
            execution: { planId: "PLAN-ADAPTER", runId: "run-1" },
          },
        }),
      })));
      expect(built.package.packageDigest).toBe(tagPackage.packageDigest);
      expect(built.bundle.selectedDocuments).toContainEqual(expect.objectContaining({ documentId: "guide" }));

      const draft = revision.documents.find(document => document.relativePath === draftPath)!;
      const preview = await json(await runtime.httpHandler(new Request("http://localhost/v1/artifact-amendments/preview", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-secret-12345678" },
        body: JSON.stringify({ workspaceId: "workspace", draftPath, ifMatch: draft.checksum, expectedMapRevision: revision.revision }),
      })));
      const forbiddenApproval = await runtime.httpHandler(new Request("http://localhost/v1/operator/artifact-amendment-approvals", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer agent-secret-12345678" },
        body: JSON.stringify({ workspaceId: "workspace", draftPath, ifMatch: draft.checksum, expectedMapRevision: revision.revision, expectedPreviewDigest: preview.previewDigest }),
      }));
      expect(forbiddenApproval.status).toBe(401);
      const approval = await json(await runtime.httpHandler(new Request("http://localhost/v1/operator/artifact-amendment-approvals", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer operator-secret-123456" },
        body: JSON.stringify({ workspaceId: "workspace", draftPath, ifMatch: draft.checksum, expectedMapRevision: revision.revision, expectedPreviewDigest: preview.previewDigest }),
      })));
      expect(approval).toEqual(expect.objectContaining({ approvedBy: "release-operator", payloadDigest: preview.approvalPayloadDigest }));
      const acceptArguments = {
        workspaceId: "workspace",
        draftPath,
        ifMatch: draft.checksum,
        expectedMapRevision: revision.revision,
        expectedPreviewDigest: preview.previewDigest,
        approvalReceiptId: approval.receiptId,
      };
      const accepted = await client.callTool({ name: "artifact.accept_amendment", arguments: acceptArguments });
      expect(accepted.isError).not.toBe(true);
      expect(accepted.structuredContent).toEqual(expect.objectContaining({ artifactId: "ADR-V2", approvedBy: "release-operator" }));
      const repeated = await client.callTool({ name: "artifact.accept_amendment", arguments: acceptArguments });
      expect(repeated.structuredContent).toEqual(accepted.structuredContent);
      const lineage = await json(await runtime.httpHandler(new Request("http://localhost/v1/artifact-lineages?workspaceId=workspace&lineageId=decision", { headers: { authorization: "Bearer agent-secret-12345678" } })));
      expect(lineage).toEqual(expect.objectContaining({ headArtifactId: "ADR-V2", status: "valid" }));
      expect(await readFile(join(root, basePath), "utf8")).toBe(baseBytes);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await runtime.close();
    }
  });
});
