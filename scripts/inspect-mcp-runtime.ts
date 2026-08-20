import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const baseUrl = (process.env.ABCM_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.ABCM_API_TOKEN;
const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "castalia-public";
const projectId = process.env.ABCM_PROJECT_ID ?? "abcm";
const expectedToolCount = Number(process.env.ABCM_EXPECTED_MCP_TOOL_COUNT ?? "39");
const documentationSourceId = process.env.ABCM_DOCUMENTATION_SOURCE_ID ?? "castalia-public-import";

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
  const instructionContent = (instructions.structuredContent as { content?: string } | undefined)?.content;
  const documentationResult = await client.callTool({
    name: "documentation_source.preview",
    arguments: { workspaceId, sourceId: documentationSourceId },
  });
  const documentation = documentationResult.structuredContent as { sourceId?: string; operations?: unknown[] } | undefined;

  if (names.length !== expectedToolCount || new Set(names).size !== names.length) {
    throw new Error(`Expected ${expectedToolCount} unique MCP tools, received ${names.length}.`);
  }
  if (serverVersion !== "0.1.3" || instructionVersion !== "1.20.0") {
    throw new Error(`Unexpected server/instruction versions: server='${serverVersion}', instructions='${instructionVersion}'.`);
  }
  if (!instructionContent?.includes("не добавляет pairing, device, cursor или conflict операции в MCP manifest")) {
    throw new Error("MCP agent instructions do not contain the current Obsidian plugin boundary.");
  }
  if (textError.code !== "CONTEXT_DOCUMENT_NOT_FOUND" || structuredError?.error_code !== textError.code) {
    throw new Error(`Structured error mismatch: text='${textError.code}', structured='${structuredError?.error_code}'.`);
  }
  if (overflowTextError.code !== "REQUIRED_CONTEXT_EXCEEDS_LIMIT" || overflowStructuredError?.error_code !== overflowTextError.code) {
    throw new Error(`Budget error mismatch: text='${overflowTextError.code}', structured='${overflowStructuredError?.error_code}'.`);
  }
  const forbiddenEvaluationTools = names.filter(name => /outcome|feedback|business_evaluation|task_success/.test(name));
  if (forbiddenEvaluationTools.length > 0) throw new Error(`Centralized evaluation tools are still published: ${forbiddenEvaluationTools.join(", ")}`);
  if (documentationResult.isError || documentation?.sourceId !== documentationSourceId) {
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
    centralizedEvaluationTools: [],
    documentationSource: { id: documentation.sourceId, operationCount: documentation.operations?.length ?? 0 },
  }, null, 2));
} finally {
  await client.close();
}
