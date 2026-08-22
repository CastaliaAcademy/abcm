import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { ABCM_AGENT_INSTRUCTIONS_VERSION } from "../src/agent-instructions/agent-instructions.js";

const baseUrl = (process.env.ABCM_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.ABCM_API_TOKEN;
const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "castalia-public";
const projectId = process.env.ABCM_PROJECT_ID ?? "abcm";
const expectedToolCount = Number(process.env.ABCM_EXPECTED_MCP_TOOL_COUNT ?? "41");
const documentationSourceId = process.env.ABCM_DOCUMENTATION_SOURCE_ID ?? "castalia-public-import";
const privateWorkspaceId = process.env.ABCM_PRIVATE_WORKSPACE_ID ?? "castalia-private-backend";
const privateDocumentationSourceId = process.env.ABCM_PRIVATE_DOCUMENTATION_SOURCE_ID ?? "castalia-private-backend-docs";

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
  const precisionRequest = {
    domainLanguageBootstrapId: bootstrapId,
    roleId: "runtime-inspector",
    taskType: "contract-audit",
    goal: "Проверить PLAN-0037 и связанные доказательства по точному documentId",
    targetHints: { scopeIds: [projectId] },
    explicitDocuments: [{ selector: "document-id", documentId: "PLAN-0037" }],
    canonicalDomains: ["context", "workspace"],
    canonicalTerms: ["ScopeMap"],
    keywords: ["PLAN-0037", "audit", "lifecycle", "import-status"],
    budgetProfile: "expanded",
  } as const;
  const focusedPrecision = await client.callTool({
    name: "context.preview_task_context_v4",
    arguments: { ...precisionRequest, contextMode: "focused" },
  });
  const repeatedFocusedPrecision = await client.callTool({
    name: "context.preview_task_context_v4",
    arguments: { ...precisionRequest, contextMode: "focused" },
  });
  const balancedPrecision = await client.callTool({
    name: "context.preview_task_context_v4",
    arguments: { ...precisionRequest, contextMode: "balanced" },
  });
  type PrecisionPreview = {
    previewDigest: string;
    contextMode: "focused" | "balanced";
    tokenEstimate: number;
    selectedDocuments: Array<{ documentId: string; mandatory: boolean; selectionStage: "mandatory" | "relevant" | "background_fallback"; tokenEstimate: number }>;
    omissions: unknown[];
  };
  const focused = focusedPrecision.structuredContent as PrecisionPreview;
  const repeatedFocused = repeatedFocusedPrecision.structuredContent as PrecisionPreview;
  const balanced = balancedPrecision.structuredContent as PrecisionPreview;
  const focusedTaskSucceeded = focused.selectedDocuments.some(document => document.documentId === "PLAN-0037" && document.mandatory);
  const balancedTaskSucceeded = balanced.selectedDocuments.some(document => document.documentId === "PLAN-0037" && document.mandatory);
  const relevantTokenRatio = (preview: PrecisionPreview) => preview.tokenEstimate === 0 ? 0 : preview.selectedDocuments
    .filter(document => document.selectionStage !== "background_fallback")
    .reduce((sum, document) => sum + document.tokenEstimate, 0) / preview.tokenEstimate;
  if (
    focusedPrecision.isError || repeatedFocusedPrecision.isError || balancedPrecision.isError ||
    focused.contextMode !== "focused" || balanced.contextMode !== "balanced" ||
    focused.previewDigest !== repeatedFocused.previewDigest ||
    !focusedTaskSucceeded || !balancedTaskSucceeded ||
    focused.selectedDocuments.some(document => document.selectionStage === "background_fallback") ||
    focused.tokenEstimate >= balanced.tokenEstimate || focused.omissions.length >= balanced.omissions.length
  ) {
    throw new Error("Focused context precision regression for PLAN-0037.");
  }
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
  const missingPackage = await client.callTool({
    name: "context.get_link_package",
    arguments: { workspaceId, packageId: `tag-package-${"0".repeat(24)}` },
  });
  const missingPackageTextError = JSON.parse((missingPackage.content[0] as { text: string }).text) as { code?: string };
  const missingPackageStructuredError = missingPackage.structuredContent as { error_code?: string } | undefined;
  const malformed = await client.callTool({ name: "context.get_link_package", arguments: { unexpected: true } });
  const serverVersion = client.getServerVersion()?.version;
  const instructionVersion = (instructions.structuredContent as { version?: string } | undefined)?.version;
  const instructionContent = (instructions.structuredContent as { content?: string } | undefined)?.content;
  const documentationResult = await client.callTool({
    name: "documentation_source.preview",
    arguments: { workspaceId, sourceId: documentationSourceId },
  });
  const documentation = documentationResult.structuredContent as { sourceId?: string; operations?: unknown[] } | undefined;
  const privateDocumentationResult = await client.callTool({
    name: "documentation_source.preview",
    arguments: { workspaceId: privateWorkspaceId, sourceId: privateDocumentationSourceId },
  });
  const privateDocumentation = privateDocumentationResult.structuredContent as {
    sourceId?: string;
    snapshotDigest?: string;
    operations?: Array<{ operation?: string; targetPath?: string; reconciliationDisposition?: string }>;
  } | undefined;

  if (names.length !== expectedToolCount || new Set(names).size !== names.length) {
    throw new Error(`Expected ${expectedToolCount} unique MCP tools, received ${names.length}.`);
  }
  if (serverVersion !== "0.1.7" || instructionVersion !== ABCM_AGENT_INSTRUCTIONS_VERSION) {
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
  if (missingPackageTextError.code !== "CONTEXT_LINK_PACKAGE_NOT_FOUND" || missingPackageStructuredError?.error_code !== missingPackageTextError.code) {
    throw new Error(`LinkPackage error mismatch: text='${missingPackageTextError.code}', structured='${missingPackageStructuredError?.error_code}'.`);
  }
  if (missingPackage.isError || !malformed.isError) {
    throw new Error("Domain failures must be completed typed outcomes while malformed input remains an MCP error.");
  }
  const forbiddenEvaluationTools = names.filter(name => /outcome|feedback|business_evaluation|task_success/.test(name));
  if (forbiddenEvaluationTools.length > 0) throw new Error(`Centralized evaluation tools are still published: ${forbiddenEvaluationTools.join(", ")}`);
  if (documentationResult.isError || documentation?.sourceId !== documentationSourceId) {
    throw new Error("The operator-selected documentation source preview is unavailable.");
  }
  const privateOperations = privateDocumentation?.operations ?? [];
  if (
    privateDocumentationResult.isError ||
    privateDocumentation?.sourceId !== privateDocumentationSourceId ||
    privateOperations.length !== 89 ||
    privateOperations.some(operation =>
      operation.operation !== "unchanged" ||
      operation.reconciliationDisposition !== "adopt-existing" ||
      operation.targetPath?.startsWith("artifacts/imports/operator-selected/") === true
    )
  ) {
    throw new Error("Private documentation reconciliation is incomplete or would create a parallel corpus.");
  }

  console.log(JSON.stringify({
    endpoint: `${baseUrl}/mcp`,
    serverVersion,
    instructionVersion,
    toolCount: names.length,
    tools: names,
    missingDocumentError: { text: textError.code, structured: structuredError.error_code },
    requiredBudgetError: { text: overflowTextError.code, structured: overflowStructuredError.error_code },
    missingLinkPackageError: { text: missingPackageTextError.code, structured: missingPackageStructuredError.error_code },
    centralizedEvaluationTools: [],
    contextPrecision: {
      focused: { previewDigest: focused.previewDigest, selected: focused.selectedDocuments.length, selectedDocuments: focused.selectedDocuments.map(document => ({ documentId: document.documentId, selectionStage: document.selectionStage })), omissions: focused.omissions.length, tokenEstimate: focused.tokenEstimate, relevantTokenRatio: relevantTokenRatio(focused), costPerSuccessfulTask: focusedTaskSucceeded ? focused.tokenEstimate : null },
      balanced: { previewDigest: balanced.previewDigest, selected: balanced.selectedDocuments.length, omissions: balanced.omissions.length, tokenEstimate: balanced.tokenEstimate, relevantTokenRatio: relevantTokenRatio(balanced), costPerSuccessfulTask: balancedTaskSucceeded ? balanced.tokenEstimate : null },
      mandatoryRecall: focusedTaskSucceeded ? 1 : 0,
      taskSuccessNotWorse: focusedTaskSucceeded === balancedTaskSucceeded,
      unauthorizedDisclosureCount: 0,
      deterministic: focused.previewDigest === repeatedFocused.previewDigest,
    },
    documentationSource: { id: documentation.sourceId, operationCount: documentation.operations?.length ?? 0 },
    privateDocumentationSource: {
      id: privateDocumentation.sourceId,
      snapshotDigest: privateDocumentation.snapshotDigest,
      operationCount: privateOperations.length,
      operations: { unchanged: privateOperations.length, conflicts: 0, fallbackCreates: 0 },
    },
  }, null, 2));
} finally {
  await client.close();
}
