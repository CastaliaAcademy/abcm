import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { ContextBuilder } from "../src/context/context-builder.js";
import { DirectoryContextFingerprintStore } from "../src/context/directory-context-fingerprint-store.js";
import { DomainLanguageService } from "../src/domain-language/domain-language-service.js";
import { ScopePathResolver } from "../src/domain-language/scope-path-resolver.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { SkillConnectionResolver } from "../src/skills/skill-connection-resolver.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function addScope(root: string, path: string, kind: string, id: string): Promise<void> {
  const directory = join(root, path);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  if (kind === "project") {
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  }
  await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
}

async function document(root: string, path: string, metadata: string, body: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), `---\n${metadata}\n---\n\n${body}\n`);
}

const principal: ContextPrincipal = {
  principalId: "agent:context",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};

async function fixture(builderOptions: ConstructorParameters<typeof ContextBuilder>[0]["options"] = {}) {
  const root = await mkdtemp(join(tmpdir(), "abcm-context-builder-")); roots.push(root);
  await addScope(root, "", "workflow", "workflow");
  await addScope(root, "project", "project", "commerce");
  await addScope(root, "project/catalog", "service", "catalog");
  await addScope(root, "project/catalog/search", "feature", "search");
  await addScope(root, "other-project", "project", "other-project");
  await document(root, "artifacts/conventions/security.md", "id: security-baseline\nkind: convention\ntitle: Security baseline\nrequired: true", "Never expose SECRET-SOURCE.");
  await document(root, "artifacts/navigation/archive-index.md", "id: archive-index\nkind: index\ntitle: Search archive index", "Navigation-only historical search records.");
  await document(root, "artifacts/templates/search-template.md", "id: search-template\nkind: template\ntitle: Generic search template", "Reusable template, not a task contract.");
  await document(root, "project/artifacts/overview.md", "id: project-overview\nkind: guide\ntitle: Project overview", "Commerce overview and background details.");
  await document(root, "project/catalog/search/artifacts/adr/ADR-SEARCH.md", "id: ADR-SEARCH\nkind: adr\ntitle: Search ADR\nprojection: summary", "# Decision\n\nUse deterministic indexing.\n\n# Consequences\n\nKeep source authoritative.");
  await document(root, "project/catalog/search/artifacts/implementation.md", "id: search-implementation\nkind: guide\ntitle: Search implementation\nrequiredFor: [executor-agent]", "Implement the search boundary exactly.");
  await document(root, "other-project/artifacts/foreign.md", "id: foreign-required\nkind: convention\ntitle: Foreign required\nrequired: true", "FOREIGN-PROJECT-SECRET");
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const files = new WorkspaceFileService(registry);
  const scopeMap = new ScopeMapService(registry); await scopeMap.scan("test");
  const domainLanguage = new DomainLanguageService(registry, scopeMap);
  const builder = new ContextBuilder({
    files,
    scopeMap,
    domainLanguage,
    scopePathResolver: new ScopePathResolver(domainLanguage, scopeMap),
    skillConnectionResolver: new SkillConnectionResolver(registry, scopeMap),
    fingerprintStore: new DirectoryContextFingerprintStore(registry),
    options: builderOptions,
  });
  const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" }, roleId: "executor-agent" }, principal);
  return { root, registry, files, scopeMap, domainLanguage, builder, bootstrap };
}

function request(bootstrapId: string) {
  return {
    domainLanguageBootstrapId: bootstrapId,
    roleId: "executor-agent",
    taskType: "feature-implementation",
    goal: "Implement search",
    targetHints: ["search"],
    explicitDocumentLinks: ["abcm://artifact/ADR-SEARCH"],
    execution: { planId: "PLAN-TEST", runId: "run-1", assignmentId: "assignment-1" },
  } as const;
}

describe("ContextBuilder", () => {
  test("предварительно объясняет выбор без записи fingerprint и без содержимого документов", async () => {
    const { root, builder, bootstrap } = await fixture();
    const preview = await builder.preview(request(bootstrap.bootstrapId), principal);

    expect(preview.selectionPolicyVersion).toBe("context-selection/v3");
    expect(preview.selectedDocuments.map(item => item.documentId)).toEqual(["security-baseline", "search-implementation", "ADR-SEARCH", "project-overview"]);
    expect(preview.fallbackModes).toEqual(["direct-search", "explicit-documents", "bounded-resource-read"]);
    expect(JSON.stringify(preview)).not.toContain("Never expose SECRET-SOURCE");
    expect(JSON.stringify(preview)).not.toContain("Use deterministic indexing");
    expect(await readFile(join(root, ".abcm", "fingerprints", "sentinel"), "utf8").catch(() => "missing")).toBe("missing");
  });

  test("materializes a deterministic bounded bundle and body-free fingerprint", async () => {
    const { root, builder, bootstrap } = await fixture();
    const first = await builder.build(request(bootstrap.bootstrapId), principal);
    const second = await builder.build(request(bootstrap.bootstrapId), principal);

    expect(second.bundleDigest).toBe(first.bundleDigest);
    expect(second.contextBundleId).toBe(first.contextBundleId);
    expect(first.mapRevision).toBe(bootstrap.mapRevision);
    expect(first.primaryTargetScope).toBe("search");
    expect(first.selectedDocuments.map(item => item.documentId)).toEqual(["security-baseline", "search-implementation", "ADR-SEARCH", "project-overview"]);
    expect(first.selectedDocuments.map(item => item.documentId)).not.toContain("archive-index");
    expect(first.selectedDocuments.map(item => item.documentId)).not.toContain("search-template");
    expect(JSON.stringify(first)).not.toContain("FOREIGN-PROJECT-SECRET");
    expect(first.selectedDocuments.find(item => item.documentId === "security-baseline")?.selectionReasons).toContain("required_applicable");
    expect(first.selectedDocuments.find(item => item.documentId === "search-implementation")?.selectionReasons).toContain("role_required");
    expect(first.selectedDocuments.find(item => item.documentId === "ADR-SEARCH")?.projection).toEqual(expect.objectContaining({ mode: "summary", authoritative: false, sourceDocumentId: "ADR-SEARCH" }));
    expect(first).not.toHaveProperty("scopeMap");
    expect(Object.isFrozen(first)).toBe(true);

    const fingerprint = JSON.parse(await readFile(join(root, first.contextFingerprintLocation, "fingerprint.json"), "utf8")) as unknown;
    const serialized = JSON.stringify(fingerprint);
    expect(serialized).not.toContain("Never expose SECRET-SOURCE");
    expect(serialized).not.toContain("Use deterministic indexing");
    expect(serialized).toContain("ADR-SEARCH");
    expect(await readFile(join(root, first.contextFingerprintLocation, "selected-files.jsonl"), "utf8")).toContain("required_applicable");
  });

  test("fails closed for unreadable mandatory documents", async () => {
    const { builder, bootstrap } = await fixture();
    const restricted: ContextPrincipal = {
      principalId: principal.principalId,
      access: { workspacePermissions: [], scopeGrants: {
        workflow: ["scope.discover", "scope.read_metadata", "context.build"],
        commerce: ["scope.discover", "scope.read_metadata", "context.build", "document.read"],
        catalog: ["scope.discover", "scope.read_metadata", "context.build", "document.read"],
        search: ["scope.discover", "scope.read_metadata", "context.build", "document.read"],
      } },
    };
    await expect(builder.build(request(bootstrap.bootstrapId), restricted)).rejects.toMatchObject({ code: "REQUIRED_CONTEXT_ACCESS_DENIED" });
  });

  test("reserves mandatory content before optional budget and reports boundaries", async () => {
    const { builder, bootstrap } = await fixture({ budgetProfiles: { tiny: { softLimitTokens: 70, hardLimitTokens: 75 } } });
    const result = await builder.build({ ...request(bootstrap.bootstrapId), budgetProfile: "tiny" }, principal);
    expect(result.selectedDocuments.map(item => item.documentId)).toEqual(expect.arrayContaining(["security-baseline", "search-implementation", "ADR-SEARCH"]));
    expect(result.omissions).toContainEqual(expect.objectContaining({ documentId: "project-overview", reason: "budget_exceeded" }));
    expect(result.budgetAllocation.every(bucket =>
      bucket.requestedTokens === bucket.consumedTokens + bucket.omittedTokens &&
      bucket.reservedTokens <= bucket.consumedTokens &&
      bucket.selectedTokens === bucket.consumedTokens
    )).toBe(true);
    const preview = await builder.preview({ ...request(bootstrap.bootstrapId), budgetProfile: "tiny" }, principal);
    expect(preview.budgetAllocation).toEqual(result.budgetAllocation);

    const overflow = await fixture({ budgetProfiles: { impossible: { softLimitTokens: 1, hardLimitTokens: 1 } } });
    await expect(overflow.builder.build({ ...request(overflow.bootstrap.bootstrapId), budgetProfile: "impossible" }, principal)).rejects.toMatchObject({
      code: "REQUIRED_CONTEXT_EXCEEDS_LIMIT",
      details: {
        hardLimitTokens: 1,
        mandatoryTokens: expect.any(Number),
        documentIds: ["security-baseline", "search-implementation", "ADR-SEARCH"],
      },
    });
  });

  test("rejects unresolved explicit documents and stale materialized bytes", async () => {
    const { root, builder, bootstrap } = await fixture();
    await expect(builder.build({ ...request(bootstrap.bootstrapId), explicitDocumentLinks: ["abcm://artifact/MISSING"] }, principal)).rejects.toMatchObject({ code: "CONTEXT_CONFIGURATION_INVALID" });
    await writeFile(join(root, "project/catalog/search/artifacts/implementation.md"), "changed after map publication");
    await expect(builder.build(request(bootstrap.bootstrapId), principal)).rejects.toMatchObject({ code: "DOMAIN_LANGUAGE_BOOTSTRAP_STALE" });
  });

  test("rejects unknown budgets, unsafe execution segments, and derived-store symlink escape", async () => {
    const unknown = await fixture();
    await expect(unknown.builder.build({ ...request(unknown.bootstrap.bootstrapId), budgetProfile: "missing" }, principal)).rejects.toMatchObject({ code: "CONTEXT_CONFIGURATION_INVALID" });
    await expect(unknown.builder.build({ ...request(unknown.bootstrap.bootstrapId), execution: { planId: "../escape", runId: "run" } }, principal)).rejects.toMatchObject({ code: "REQUEST_INVALID" });

    const escaped = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "abcm-context-outside-")); roots.push(outside);
    await symlink(outside, join(escaped.root, ".abcm"), "dir");
    await expect(escaped.builder.build(request(escaped.bootstrap.bootstrapId), principal)).rejects.toMatchObject({ code: "FILE_PATH_FORBIDDEN" });
    expect(await readFile(join(outside, "sentinel"), "utf8").catch(() => "missing")).toBe("missing");
  });

  test("exposes semantically identical buildTaskContext through REST and MCP", async () => {
    const { root } = await fixture();
    const runtime = createAbcmRuntime({ id: "test", root }, { contextPrincipal: principal });
    await runtime.scopeMap.scan("test");
    const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" }, roleId: "executor-agent" }, principal);
    const body = request(bootstrap.bootstrapId);
    const rest = await runtime.restHandler(new Request("http://localhost/v1/context/build-task-context", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(rest.status).toBe(200);
    const restBody = await rest.json() as { bundleDigest: string; selectedDocuments: unknown };

    const server = runtime.createMcpServer();
    const client = new Client({ name: "context-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const mcp = await client.callTool({ name: "context.build_task_context", arguments: body });
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent).toEqual(expect.objectContaining({ bundleDigest: restBody.bundleDigest, selectedDocuments: restBody.selectedDocuments }));
      expect(JSON.stringify(mcp.structuredContent)).not.toContain('"nodes"');

      const previewRestResponse = await runtime.restHandler(new Request("http://localhost/v1/context/preview-task-context", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      const previewRest = await previewRestResponse.json();
      const previewMcp = await client.callTool({ name: "context.preview_task_context", arguments: body });
      expect(previewMcp.isError).not.toBe(true);
      expect(previewMcp.structuredContent).toEqual(previewRest);
      expect(JSON.stringify(previewRest)).not.toContain("Implement the search boundary exactly");
    } finally {
      await client.close(); await server.close(); await runtime.close();
    }
  });

  test("preserves structured multi-scope semantics through REST and MCP", async () => {
    const { root } = await fixture();
    const runtime = createAbcmRuntime({ id: "test", root }, { contextPrincipal: principal });
    await runtime.scopeMap.scan("test");
    const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" }, roleId: "executor-agent" }, principal);
    const body = {
      ...request(bootstrap.bootstrapId),
      goal: "Implement search and coordinate the other project",
      targetHints: {
        scopeIds: ["search", "other-project"],
        componentNames: ["search"],
      },
    };
    const rest = await runtime.restHandler(new Request("http://localhost/v1/context/build-task-context", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(rest.status).toBe(200);
    const restBody = await rest.json() as {
      bundleDigest: string;
      affectedScopes: string[];
      affectedScopeDetails: Array<{ scopeId: string; origin: string; depth: number }>;
      multiScopePolicyDigest: string;
      budgetAllocation: Array<{ bucketId: string }>;
      selectedDocuments: Array<{ documentId: string }>;
    };
    expect(restBody.affectedScopes).toEqual(["search", "other-project"]);
    expect(restBody.affectedScopeDetails).toEqual([
      { scopeId: "search", origin: "primary", depth: 0 },
      { scopeId: "other-project", origin: "explicit", depth: 0 },
    ]);
    expect(restBody.multiScopePolicyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(restBody.budgetAllocation.map(item => item.bucketId)).toEqual(expect.arrayContaining(["search", "other-project"]));
    expect(restBody.selectedDocuments.map(item => item.documentId)).toContain("foreign-required");

    const server = runtime.createMcpServer();
    const client = new Client({ name: "multi-scope-context-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport); await client.connect(clientTransport);
    try {
      const mcp = await client.callTool({ name: "context.build_task_context", arguments: body });
      expect(mcp.isError).not.toBe(true);
      expect(mcp.structuredContent).toEqual(expect.objectContaining({
        bundleDigest: restBody.bundleDigest,
        affectedScopes: restBody.affectedScopes,
        affectedScopeDetails: restBody.affectedScopeDetails,
        multiScopePolicyDigest: restBody.multiScopePolicyDigest,
        budgetAllocation: restBody.budgetAllocation,
      }));
    } finally {
      await client.close(); await server.close(); await runtime.close();
    }
  });
});
