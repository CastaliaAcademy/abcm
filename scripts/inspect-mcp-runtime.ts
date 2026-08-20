import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const baseUrl = (process.env.ABCM_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.ABCM_API_TOKEN;
const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "castalia-public";
const projectId = process.env.ABCM_PROJECT_ID ?? "abcm";
const expectedToolCount = Number(process.env.ABCM_EXPECTED_MCP_TOOL_COUNT ?? "42");

if (!token) throw new Error("ABCM_API_TOKEN is required.");
if (!Number.isSafeInteger(expectedToolCount) || expectedToolCount < 1) {
  throw new Error("ABCM_EXPECTED_MCP_TOOL_COUNT must be a positive integer.");
}

const client = new Client({ name: "abcm-runtime-inspector", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
const transport = new StreamableHTTPClientTransport(new URL("/mcp", `${baseUrl}/`), {
  authProvider: { token: async () => token },
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  const instructions = await client.callTool({ name: "agent_instructions.get", arguments: {} });
  await client.callTool({ name: "scope_map.scan", arguments: { workspaceId } });
  const language = await client.callTool({
    name: "context.get_domain_language",
    arguments: { anchor: { workspaceId, projectId }, roleId: "runtime-inspector" },
  });
  const bootstrapId = (language.structuredContent as { bootstrapId: string }).bootstrapId;
  const missing = await client.callTool({
    name: "context.build_task_context",
    arguments: {
      domainLanguageBootstrapId: bootstrapId,
      roleId: "runtime-inspector",
      taskType: "verification",
      goal: "Проверить машинный код ошибки отсутствующего контекстного документа.",
      targetHints: { scopeIds: [projectId] },
      explicitDocuments: [{ selector: "document-id", documentId: `missing-${crypto.randomUUID()}` }],
      execution: { planId: "RUNTIME-INSPECTION", runId: crypto.randomUUID() },
    },
  });
  const textError = JSON.parse((missing.content[0] as { text: string }).text) as { code?: string };
  const structuredError = missing.structuredContent as { error_code?: string } | undefined;
  const overflow = await client.callTool({
    name: "context.build_task_context",
    arguments: {
      domainLanguageBootstrapId: bootstrapId,
      roleId: "runtime-inspector",
      taskType: "verification",
      goal: "Проверить машинный код превышения обязательного бюджета.",
      targetHints: { scopeIds: [projectId] },
      explicitDocuments: [{ selector: "repository-directory", path: projectId, recursive: true }],
      budgetProfile: "compact",
      execution: { planId: "RUNTIME-INSPECTION", runId: crypto.randomUUID() },
    },
  });
  const overflowTextError = JSON.parse((overflow.content[0] as { text: string }).text) as { code?: string };
  const overflowStructuredError = overflow.structuredContent as { error_code?: string } | undefined;
  const serverVersion = client.getServerVersion()?.version;
  const instructionVersion = (instructions.structuredContent as { version?: string } | undefined)?.version;
  const profilesResult = await client.callTool({ name: "context.list_business_evaluation_profiles", arguments: {} });
  const profiles = (profilesResult.structuredContent as { profiles?: Array<{ phase?: string }> } | undefined)?.profiles ?? [];
  const documentationResult = await client.callTool({
    name: "documentation_source.preview",
    arguments: { workspaceId, sourceId: "operator-selected" },
  });
  const documentation = documentationResult.structuredContent as { sourceId?: string; operations?: unknown[] } | undefined;

  if (names.length !== expectedToolCount || new Set(names).size !== names.length) {
    throw new Error(`Expected ${expectedToolCount} unique MCP tools, received ${names.length}.`);
  }
  if (serverVersion !== instructionVersion) {
    throw new Error(`MCP server version '${serverVersion}' differs from instruction version '${instructionVersion}'.`);
  }
  if (textError.code !== "CONTEXT_DOCUMENT_NOT_FOUND" || structuredError?.error_code !== textError.code) {
    throw new Error(`Structured error mismatch: text='${textError.code}', structured='${structuredError?.error_code}'.`);
  }
  if (overflowTextError.code !== "REQUIRED_CONTEXT_EXCEEDS_LIMIT" || overflowStructuredError?.error_code !== overflowTextError.code) {
    throw new Error(`Budget error mismatch: text='${overflowTextError.code}', structured='${overflowStructuredError?.error_code}'.`);
  }
  if (!profiles.some(profile => profile.phase === "retrieval") || !profiles.some(profile => profile.phase === "task-success")) {
    throw new Error("Both retrieval and task-success server-owned profiles must be published.");
  }
  if (documentationResult.isError || documentation?.sourceId !== "operator-selected") {
    throw new Error("The operator-selected documentation source preview is unavailable.");
  }

  console.log(JSON.stringify({
    endpoint: `${baseUrl}/mcp`,
    serverVersion,
    instructionVersion,
    toolCount: names.length,
    tools: names,
    missingDocumentError: { text: textError.code, structured: structuredError.error_code },
    requiredBudgetError: { text: overflowTextError.code, structured: overflowStructuredError.error_code },
    businessEvaluationProfiles: profiles.map(profile => profile.phase),
    documentationSource: { id: documentation.sourceId, operationCount: documentation.operations?.length ?? 0 },
  }, null, 2));
} finally {
  await client.close();
}
