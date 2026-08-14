import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { InMemoryAbcmObservability, observeOperation, type AbcmObservability } from "../src/core/observability.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";
import { requireStaticBearerToken } from "../src/rest/static-bearer-auth.js";

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

const principal: ContextPrincipal = {
  principalId: "agent:observability",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};

describe("runtime observability", () => {
  test("emits fixed body-free events for critical operations and bounded conflict metrics", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-observability-workspace-"));
    const source = await mkdtemp(join(tmpdir(), "abcm-observability-source-"));
    roots.push(root, source);
    await addScope(root, "", "workflow", "workflow");
    await addScope(root, "project", "project", "commerce");
    await addScope(root, "project/catalog", "service", "catalog");
    await addScope(root, "project/catalog/search", "feature", "search");
    await mkdir(join(root, "artifacts/import"), { recursive: true });
    await writeFile(join(root, "artifacts/import/note.md"), "managed collision");
    await writeFile(join(source, "note.md"), "---\nid: NOTE\nkind: note\ntitle: Note\n---\nDOCUMENT_BODY_SENTINEL\n");

    const observability = new InMemoryAbcmObservability();
    const runtime = createAbcmRuntime({ id: "test", root }, {
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: principal,
      observability,
      documentationSources: [{ id: "docs", workspaceId: "test", root: source, targetBasePath: "artifacts/import" }],
    });
    try {
      await runtime.scopeMap.scan("test");
      const bootstrap = await runtime.domainLanguage.createBootstrap({
        anchor: { workspaceId: "test", projectId: "commerce" },
        roleId: "executor-agent",
      }, principal);
      await runtime.contextBuilder.build({
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        roleId: "executor-agent",
        taskType: "implementation",
        goal: "Resolve observability sentinel goal",
        targetHints: ["search"],
        execution: { planId: "PLAN-0024", runId: "run-1" },
      }, principal);
      await runtime.files.write("test", "project/catalog/search/artifacts/output.md", new TextEncoder().encode("DOCUMENT_BODY_SENTINEL"), { ifNoneMatch: "*" });
      const preview = await runtime.documentation!.preview("test", "docs");
      expect(preview.operations).toContainEqual(expect.objectContaining({ operation: "conflict" }));

      const protectedHandler = requireStaticBearerToken(async () => Response.json({ ok: true }), "AUTH_TOKEN_SENTINEL_1234", observability);
      expect((await protectedHandler(new Request("http://localhost/private"))).status).toBe(401);
      expect((await protectedHandler(new Request("http://localhost/private", { headers: { authorization: "Bearer AUTH_TOKEN_SENTINEL_1234" } }))).status).toBe(200);

      const operations = observability.auditEvents.map(event => event.operation);
      expect(operations).toEqual(expect.arrayContaining([
        "scope_map.scan", "scope_path.resolve", "context.build", "file.write", "documentation.preview", "authentication",
      ]));
      expect(observability.metricPoints).toContainEqual(expect.objectContaining({ name: "abcm_context_bundle_tokens" }));
      expect(observability.metricPoints).toContainEqual(expect.objectContaining({ name: "abcm_documentation_sync_conflicts", value: 1 }));
      const serialized = JSON.stringify(observability);
      expect(serialized).not.toContain("DOCUMENT_BODY_SENTINEL");
      expect(serialized).not.toContain("AUTH_TOKEN_SENTINEL_1234");
      expect(serialized).not.toContain("Resolve observability sentinel goal");
    } finally {
      await runtime.close();
    }
  });

  test("isolates throwing telemetry sinks from observed success and failure", async () => {
    const throwing: AbcmObservability = {
      audit: () => { throw new Error("sink unavailable"); },
      metric: async () => { throw new Error("sink unavailable"); },
    };
    await expect(observeOperation(throwing, { operation: "scope_map.scan" }, async () => "ok")).resolves.toBe("ok");
    const expected = new Error("operation failure");
    await expect(observeOperation(throwing, { operation: "scope_map.scan" }, async () => { throw expected; })).rejects.toBe(expected);
  });
});
