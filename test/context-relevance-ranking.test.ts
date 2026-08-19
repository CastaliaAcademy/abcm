import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

const principal: ContextPrincipal = {
  principalId: "agent:ranking",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};

async function addScope(root: string, path: string, kind: string, id: string): Promise<void> {
  const directory = join(root, path);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  if (kind === "project") {
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  }
}

async function document(root: string, path: string, frontmatter: string, body: string): Promise<void> {
  await mkdir(join(root, path, ".."), { recursive: true });
  await writeFile(join(root, path), `---\n${frontmatter}\n---\n\n${body}\n`);
}

describe("ранжирование релевантности контекста", () => {
  test("обязательные и exact-scope документы не вытесняются ancestor template/index шумом", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-context-ranking-")); roots.push(root);
    await addScope(root, "", "workflow", "workflow");
    await addScope(root, "project", "project", "commerce");
    await addScope(root, "project/orders", "service", "orders");
    await addScope(root, "project/orders/refund", "feature", "refund");

    await document(root, "artifacts/safety.md", "id: safety\nkind: convention\ntitle: Safety\nrequired: true", "Запрещено раскрывать закрытые данные.");
    await document(root, "artifacts/templates/refund.md", "id: workflow-template\nkind: template\ntitle: Refund workflow template", "TEMPLATE_NOISE ".repeat(200));
    await document(root, "artifacts/navigation/refund-index.md", "id: workflow-index\nkind: index\ntitle: Refund registry index", "INDEX_NOISE ".repeat(200));
    await document(root, "project/artifacts/role.md", "id: role-contract\nkind: guide\ntitle: Executor contract\nrequiredFor: [executor-agent]", "Исполнять только подтверждённый план.");
    await document(root, "project/artifacts/background.md", "id: ancestor-background\nkind: guide\ntitle: Refund background", "ANCESTOR_NOISE ".repeat(120));
    await document(root, "project/orders/refund/artifacts/task.md", "id: task-contract\nkind: policy\ntitle: Refund review policy\ntaskTypes: [review]", "Проверить идемпотентность возврата.");
    await document(root, "project/orders/refund/artifacts/decision.md", "id: refund-decision\nkind: adr\ntitle: Refund decision", "Использовать журнал операций.");
    await document(root, "project/orders/refund/artifacts/implementation.md", "id: refund-implementation\nkind: guide\ntitle: Refund implementation", "GOLD ".repeat(40));

    const runtime = createAbcmRuntime({ id: "test", root }, {
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: principal,
      context: { budgetProfiles: { adversarial: { softLimitTokens: 230, hardLimitTokens: 300 } } },
    });
    try {
      await runtime.scopeMap.scan("test");
      const bootstrap = await runtime.domainLanguage.createBootstrap({
        anchor: { workspaceId: "test", projectId: "commerce" },
        roleId: "executor-agent",
      }, principal);
      const request = {
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        roleId: "executor-agent",
        taskType: "review",
        goal: "Проверить реализацию возврата",
        exactScopeIds: ["refund"],
        explicitDocumentLinks: ["abcm://artifact/refund-decision"],
        budgetProfile: "adversarial",
        execution: { planId: "PLAN-0031", runId: "ranking-adversarial" },
      } as const;

      const preview = await runtime.contextBuilder.preview(request, principal);
      const bundle = await runtime.contextBuilder.build(request, principal);
      const selectedIds = bundle.selectedDocuments.map(item => item.documentId);

      expect(selectedIds).toEqual(["safety", "role-contract", "task-contract", "refund-decision", "refund-implementation"]);
      expect(bundle.selectedDocuments.map(item => item.selectionReasons[0])).toEqual([
        "required_applicable",
        "role_required",
        "task_type_required",
        "explicit_link",
        "target_scope",
      ]);
      expect(bundle.omissions).toContainEqual(expect.objectContaining({
        documentId: "ancestor-background",
        reason: "budget_exceeded",
        selectionReasons: ["optional_background"],
      }));
      expect([...selectedIds, ...bundle.omissions.map(item => item.documentId)]).not.toContain("workflow-template");
      expect([...selectedIds, ...bundle.omissions.map(item => item.documentId)]).not.toContain("workflow-index");
      expect(preview.selectedDocuments.map(item => item.documentId)).toEqual(selectedIds);
      expect(preview.omissions).toEqual(bundle.omissions);

      const repeated = await runtime.contextBuilder.build(request, principal);
      expect(repeated.bundleDigest).toBe(bundle.bundleDigest);
      expect(repeated.selectedDocuments.map(item => item.documentId)).toEqual(selectedIds);
    } finally {
      await runtime.close();
    }
  });
});
