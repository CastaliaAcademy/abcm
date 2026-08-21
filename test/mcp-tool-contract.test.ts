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
  const root = await mkdtemp(join(tmpdir(), "abcm-mcp-tool-contract-"));
  const source = await mkdtemp(join(tmpdir(), "abcm-mcp-tool-source-"));
  const workspaceStore = await mkdtemp(join(tmpdir(), "abcm-mcp-tool-workspaces-"));
  const fileOperationState = await mkdtemp(join(tmpdir(), "abcm-mcp-tool-file-ops-"));
  roots.push(root, source, workspaceStore, fileOperationState);
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await mkdir(join(root, "project/config"), { recursive: true });
  await mkdir(join(root, "project/domain-language"), { recursive: true });
  await mkdir(join(root, "project/artifacts"), { recursive: true });
  await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
  await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/artifacts/required.md"), "---\nid: required\nkind: convention\ntitle: Required\nrequired: true\n---\nMandatory context that exceeds one token.\n");
  await writeFile(join(source, "guide.md"), "guide\n");
  const access = {
    workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read"] as const,
  };
  const runtime = createAbcmRuntime(
    { id: "test", root },
    {
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: { principalId: "tool-contract", access },
      scopeMapAccess: access,
      context: { budgetProfiles: { impossible: { softLimitTokens: 1, hardLimitTokens: 1 } } },
      documentationSources: [{ id: "docs", workspaceId: "test", root: source, targetBasePath: "artifacts/mirror" }],
      workspaceStoreRoot: workspaceStore,
      fileOperations: { stateRoot: fileOperationState },
    },
  );
  await runtime.ready;
  const server = runtime.createMcpServer();
  const client = new Client({ name: "tool-contract-client", version: "0.1.0" }, { supportedProtocolVersions: ["2025-11-25"] });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { root, runtime, server, client };
}

describe("MCP tool contract", () => {
  test("publishes strict input and structured output schemas for every operation", async () => {
    const { runtime, server, client } = await fixture();
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(41);
      expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect(client.getServerCapabilities()?.experimental?.["abcm.dev/contract"]).toEqual({
        contractVersion: "1.0.0",
        specificationVersion: "0.5.0",
        supportedProtocolVersions: ["2025-11-25"],
        operationTimeoutMs: 30000,
        toolErrors: { encoding: "completed-json+structured", version: "3", structuredField: "error_code" },
      });
      expect(listed.tools.map(tool => tool.name)).toEqual([
        "agent_instructions.get",
        "workspace.create",
        "workspace.list_files",
        "workspace.get_architecture_policy",
        "workspace.set_architecture_policy",
        "workspace.delete_architecture_policy",
        "workspace.list_architecture_policies",
        "workspace.check_architecture_compliance",
        "workspace.read_file",
        "workspace.write_file",
        "workspace.delete_file",
        "workspace.upload_start",
        "workspace.upload_chunk",
        "workspace.upload_complete",
        "workspace.upload_abort",
        "workspace.batch_apply",
        "workspace.move_file",
        "workspace.create_directory",
        "workspace.move_directory",
        "workspace.delete_directory",
        "scope_map.scan",
        "context.get_domain_language",
        "context.preview_task_context",
        "context.build_task_context",
        "context.preview_task_context_v4",
        "context.build_task_context_v4",
        "context.start_link_graph_session",
        "context.get_link_graph_session",
        "context.step_link_graph_session",
        "context.issue_link_graph_ticket",
        "context.finalize_link_graph_session",
        "context.list_link_packages",
        "context.get_link_package",
        "context.build_from_link_package",
        "artifact.preview_amendment",
        "artifact.accept_amendment",
        "artifact.get_lineage",
        "documentation_source.preview",
        "documentation_source.apply",
        "documentation_source.sync",
        "documentation_source.cutover",
      ]);
      const instructions = await client.callTool({ name: "agent_instructions.get", arguments: {} });
      expect(instructions.structuredContent).toEqual(expect.objectContaining({
        version: "1.24.0",
        contentType: "text/markdown; charset=utf-8",
        checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        content: expect.stringContaining("# Инструкция для агента ABCM"),
      }));
      expect((instructions.structuredContent as { content: string }).content).toContain("targetHints.scopeIds");
      expect((instructions.structuredContent as { content: string }).content).toContain("Недоступный explicit scope");
      expect((instructions.structuredContent as { content: string }).content).toContain("не добавляет pairing, device, cursor или conflict операции в MCP manifest");
      for (const tool of listed.tools) {
        expect(tool.inputSchema).toEqual(expect.objectContaining({ type: "object", additionalProperties: false }));
        const alternatives = (tool.outputSchema as { anyOf?: Array<Record<string, unknown>> }).anyOf;
        expect(alternatives).toHaveLength(2);
        expect(alternatives).toContainEqual(expect.objectContaining({
          type: "object",
          additionalProperties: false,
          required: ["error_code", "message"],
          properties: expect.objectContaining({
            error_code: expect.objectContaining({ type: "string" }),
            message: expect.objectContaining({ type: "string" }),
          }),
        }));
        expect(tool.annotations?.openWorldHint).toBe(false);
      }
      const contextTool = listed.tools.find(tool => tool.name === "context.build_task_context_v4") as unknown as {
        inputSchema: { properties: {
          targetHints: { anyOf: Array<{ properties?: { scopeIds?: { minItems?: number; maxItems?: number; items?: unknown } } }> };
          contextMode: { enum?: string[] };
        } };
        outputSchema: { anyOf: Array<{ required?: string[]; properties?: Record<string, unknown> }> };
      };
      const structuredHints = contextTool.inputSchema.properties.targetHints.anyOf.find(option => option.properties?.scopeIds !== undefined);
      expect(structuredHints?.properties?.scopeIds).toEqual(expect.objectContaining({
        minItems: 1,
        maxItems: 8,
        items: expect.objectContaining({ anyOf: expect.any(Array) }),
      }));
      expect(contextTool.inputSchema.properties.contextMode.enum).toEqual(["focused", "balanced"]);
      const contextSuccessSchema = contextTool.outputSchema.anyOf.find(option => option.properties?.bundleDigest !== undefined);
      expect(contextSuccessSchema?.required).toEqual(expect.arrayContaining([
        "multiScopePolicyDigest",
        "affectedScopeDetails",
        "budgetAllocation",
        "contextMode",
        "cache",
      ]));
      expect(contextSuccessSchema?.properties).toEqual(expect.objectContaining({
        multiScopePolicyDigest: expect.any(Object),
        affectedScopeDetails: expect.any(Object),
        budgetAllocation: expect.any(Object),
        contextMode: expect.objectContaining({ enum: ["focused", "balanced"] }),
      }));
      const previewTool = listed.tools.find(tool => tool.name === "context.preview_task_context_v4")!;
      expect(JSON.stringify(previewTool.outputSchema)).toContain("background_fallback");
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  test("separates schema rejection from stable ABCM execution errors", async () => {
    const { runtime, server, client } = await fixture();
    try {
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const rejected = await client.callTool({ name: tool.name, arguments: { unexpected: true } });
        expect(rejected.isError).toBe(true);
        expect((rejected.content[0] as { text: string }).text).toContain("Input validation error");
      }

      const missing = await client.callTool({
        name: "workspace.list_files",
        arguments: { workspaceId: "missing" },
      });
      expect(missing.isError).not.toBe(true);
      expect(JSON.parse((missing.content[0] as { text: string }).text)).toEqual(expect.objectContaining({
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace 'missing' is not registered.",
      }));
      expect(missing.structuredContent).toEqual(expect.objectContaining({
        error_code: "WORKSPACE_NOT_FOUND",
        message: "Workspace 'missing' is not registered.",
      }));

      const errorCases = [
        ["workspace.read_file", { workspaceId: "missing", path: "a.md" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.write_file", { workspaceId: "missing", path: "a.md", content: "a" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.delete_file", { workspaceId: "missing", path: "a.md" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.upload_start", { workspaceId: "missing", size: 0, checksum: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.upload_chunk", { workspaceId: "missing", uploadId: `upl_${"0".repeat(32)}`, index: 0, content: "", checksum: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.upload_complete", { workspaceId: "missing", uploadId: `upl_${"0".repeat(32)}` }, "WORKSPACE_NOT_FOUND"],
        ["workspace.upload_abort", { workspaceId: "missing", uploadId: `upl_${"0".repeat(32)}` }, "WORKSPACE_NOT_FOUND"],
        ["workspace.batch_apply", { workspaceId: "missing", idempotencyKey: "missing-workspace", expectedMapRevision: `sha256:${"0".repeat(64)}`, operations: [{ operation: "delete", path: "a.md", ifMatch: `sha256:${"0".repeat(64)}` }] }, "WORKSPACE_NOT_FOUND"],
        ["workspace.move_file", { workspaceId: "missing", from: "a.md", to: "b.md" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.create_directory", { workspaceId: "missing", path: "a" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.move_directory", { workspaceId: "missing", from: "a", to: "b" }, "WORKSPACE_NOT_FOUND"],
        ["workspace.delete_directory", { workspaceId: "missing", path: "a", recursive: true }, "WORKSPACE_NOT_FOUND"],
        ["scope_map.scan", { workspaceId: "missing" }, "WORKSPACE_NOT_FOUND"],
        ["context.get_domain_language", { anchor: { workspaceId: "missing", projectId: "missing" } }, "MAP_NOT_BUILT"],
        [
          "context.preview_task_context",
          { domainLanguageBootstrapId: "missing", roleId: "role", taskType: "test", goal: "test" },
          "DOMAIN_LANGUAGE_BOOTSTRAP_REQUIRED",
        ],
        [
          "context.build_task_context",
          { domainLanguageBootstrapId: "missing", roleId: "role", taskType: "test", goal: "test" },
          "DOMAIN_LANGUAGE_BOOTSTRAP_REQUIRED",
        ],
        ["documentation_source.preview", { workspaceId: "test", sourceId: "missing" }, "SOURCE_CONNECTOR_UNAVAILABLE"],
        ["documentation_source.apply", { importId: "missing" }, "DOCUMENTATION_IMPORT_NOT_FOUND"],
        ["documentation_source.sync", { sourceId: "missing" }, "SOURCE_CONNECTOR_UNAVAILABLE"],
      ] as const;
      for (const [name, arguments_, code] of errorCases) {
        const failed = await client.callTool({ name, arguments: arguments_ });
        expect(failed.isError).not.toBe(true);
        expect(JSON.parse((failed.content[0] as { text: string }).text)).toEqual(expect.objectContaining({ code }));
        expect(failed.structuredContent).toEqual(expect.objectContaining({ error_code: code }));
      }

      await runtime.scopeMap.scan("test");
      const stableDomainErrors = [
        ["context.get_link_package", { workspaceId: "test", packageId: `tag-package-${"0".repeat(24)}` }, "CONTEXT_LINK_PACKAGE_NOT_FOUND"],
        ["artifact.get_lineage", { workspaceId: "test", lineageId: "missing-lineage" }, "ARTIFACT_LINEAGE_NOT_FOUND"],
        ["context.get_domain_language", { anchor: { workspaceId: "test", projectId: "missing-project" } }, "PROJECT_ANCHOR_NOT_RESOLVED"],
      ] as const;
      for (const [name, arguments_, code] of stableDomainErrors) {
        const failed = await client.callTool({ name, arguments: arguments_ });
        expect(failed.isError).not.toBe(true);
        expect(JSON.parse((failed.content[0] as { text: string }).text)).toEqual(expect.objectContaining({ code }));
        expect(failed.structuredContent).toEqual(expect.objectContaining({ error_code: code }));
      }
      const language = await client.callTool({
        name: "context.get_domain_language",
        arguments: { anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" },
      });
      const bootstrapId = (language.structuredContent as { bootstrapId: string }).bootstrapId;
      const baseContext = {
        domainLanguageBootstrapId: bootstrapId,
        roleId: "agent",
        taskType: "test",
        goal: "Проверить предметные ошибки",
        targetHints: { scopeIds: ["project"] },
        execution: { planId: "PLAN-TEST", runId: "structured-errors" },
      };
      const unknownTerm = await client.callTool({
        name: "context.preview_task_context",
        arguments: { ...baseContext, canonicalTerms: ["UnknownTerm"] },
      });
      expect(unknownTerm.isError).not.toBe(true);
      expect(unknownTerm.structuredContent).toEqual(expect.objectContaining({ error_code: "UNKNOWN_DOMAIN_TERM" }));
      const requiredOverflow = await client.callTool({
        name: "context.build_task_context",
        arguments: { ...baseContext, budgetProfile: "impossible" },
      });
      expect(requiredOverflow.isError).not.toBe(true);
      expect(requiredOverflow.structuredContent).toEqual(expect.objectContaining({ error_code: "REQUIRED_CONTEXT_EXCEEDS_LIMIT" }));

      const happy = await client.callTool({
        name: "workspace.list_files",
        arguments: { workspaceId: "test" },
      });
      expect(happy.isError).not.toBe(true);
      expect(happy.structuredContent).toEqual(expect.objectContaining({ entries: expect.any(Array) }));
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
