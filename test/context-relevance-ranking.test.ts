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
    await addScope(root, "hidden", "project", "hidden");
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

  test("focused mode отделяет точный документ от generic scope background", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-context-exact-document-")); roots.push(root);
    await addScope(root, "", "workflow", "workflow");
    await addScope(root, "project", "project", "commerce");

    await document(root, "artifacts/safety.md", "id: safety\nkind: convention\ntitle: Safety\nrequired: true", "Соблюдать границы доступа.");
    await document(root, "project/artifacts/migration-report.md", "id: migration-report\nkind: report\ntitle: Migration report\nrequiredFor: [documentation-migration]", "Проверить migration gate.");
    await document(root, "project/artifacts/plans/PLAN-0037/plan.md", "id: PLAN-0037\nkind: plan\ntitle: Current plan", "Исправить connected errors.");
    await document(root, "project/artifacts/reports/current-evidence.md", "id: current-evidence\nkind: report\ntitle: Current audit evidence", "Актуальное доказательство.");
    await document(root, "project/artifacts/plans/PLAN-0036/plan.md", "id: PLAN-0036\nkind: plan\ntitle: Old plan", "Исторический план. ".repeat(200));
    await document(root, "project/artifacts/evals/baseline.md", "id: old-baseline\nkind: report\ntitle: Old baseline", "Исторический baseline. ".repeat(200));
    await document(root, "project/artifacts/adr/ADR-0001.md", "id: ADR-0001\nkind: adr\ntitle: Old decision", "Старое решение.");
    await document(root, "hidden/artifacts/secret.md", "id: forbidden-secret\nkind: report\ntitle: Forbidden secret", "FORBIDDEN-MARKER");

    const scopedPrincipal: ContextPrincipal = {
      principalId: "agent:focused-benchmark",
      access: { workspacePermissions: [], scopeGrants: {
        workflow: ["scope.discover", "scope.read_metadata", "context.build", "document.read"],
        commerce: ["scope.discover", "scope.read_metadata", "context.build", "document.read"],
      } },
    };

    const runtime = createAbcmRuntime({ id: "test", root }, {
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: scopedPrincipal,
      context: { budgetProfiles: {
        roomy: { softLimitTokens: 4_000, hardLimitTokens: 8_000 },
        benchmark: { softLimitTokens: 300, hardLimitTokens: 1_000 },
      } },
    });
    try {
      await runtime.scopeMap.scan("test");
      const bootstrap = await runtime.domainLanguage.createBootstrap({
        anchor: { workspaceId: "test", projectId: "commerce" },
        roleId: "executor-agent",
      }, scopedPrincipal);
      const baseRequest = {
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        roleId: "executor-agent",
        taskType: "documentation-migration",
        goal: "Проверить PLAN-0037 перед миграцией",
        exactScopeIds: ["commerce"],
        keywords: ["audit"],
        explicitDocuments: [{ selector: "document-id", documentId: "PLAN-0037" }],
        contextMode: "focused",
        budgetProfile: "roomy",
      } as const;

      const narrow = await runtime.contextBuilder.preview(baseRequest, scopedPrincipal);
      expect(narrow.selectionPolicyVersion).toBe("context-selection/v4");
      expect(narrow.selectedDocuments.map(item => item.documentId)).toEqual(["safety", "migration-report", "PLAN-0037", "current-evidence"]);
      expect(narrow.contextMode).toBe("focused");
      expect(narrow.selectedDocuments.map(item => item.selectionStage)).toEqual(["mandatory", "mandatory", "mandatory", "relevant"]);
      expect(narrow.selectedDocuments.find(item => item.documentId === "PLAN-0037")?.selectionReasons).toEqual(["explicit_link"]);
      expect(narrow.omissions).toEqual([]);

      const scopeWide = await runtime.contextBuilder.preview({ ...baseRequest, contextMode: "balanced" }, scopedPrincipal);
      expect(scopeWide.contextMode).toBe("balanced");
      expect(scopeWide.selectedDocuments.map(item => item.documentId)).toEqual([
        "safety",
        "migration-report",
        "PLAN-0037",
        "current-evidence",
        "ADR-0001",
        "old-baseline",
        "PLAN-0036",
      ]);
      expect(scopeWide.selectedDocuments.filter(item => item.selectionReasons.includes("target_scope")).map(item => item.documentId)).toEqual([
        "ADR-0001",
        "old-baseline",
        "PLAN-0036",
      ]);
      expect(scopeWide.selectedDocuments.filter(item => item.selectionReasons.includes("target_scope")).every(item => item.selectionStage === "background_fallback")).toBe(true);

      const focusedRuns = await Promise.all(Array.from({ length: 10 }, () => runtime.contextBuilder.preview({ ...baseRequest, budgetProfile: "benchmark" }, scopedPrincipal)));
      const balancedRuns = await Promise.all(Array.from({ length: 10 }, () => runtime.contextBuilder.preview({ ...baseRequest, contextMode: "balanced", budgetProfile: "benchmark" }, scopedPrincipal)));
      expect(new Set(focusedRuns.map(run => run.previewDigest)).size).toBe(1);
      expect(new Set(balancedRuns.map(run => run.previewDigest)).size).toBe(1);
      const focusedRun = focusedRuns[0]!;
      const balancedRun = balancedRuns[0]!;
      const mandatoryGold = ["safety", "migration-report", "PLAN-0037"];
      const taskSuccess = (run: typeof focusedRun) => mandatoryGold.every(id => run.selectedDocuments.some(document => document.documentId === id)) && run.selectedDocuments.some(document => document.documentId === "current-evidence");
      const relevantTokens = (run: typeof focusedRun) => run.selectedDocuments.filter(document => document.selectionStage !== "background_fallback").reduce((sum, document) => sum + document.tokenEstimate, 0);
      expect(taskSuccess(focusedRun)).toBe(true);
      expect(taskSuccess(balancedRun)).toBe(true);
      expect(focusedRun.selectedDocuments.filter(document => document.mandatory).length / mandatoryGold.length).toBe(1);
      expect(focusedRun.omissions.length).toBeLessThan(balancedRun.omissions.length);
      expect(relevantTokens(focusedRun) / focusedRun.tokenEstimate).toBeGreaterThan(relevantTokens(balancedRun) / balancedRun.tokenEstimate);
      expect(focusedRun.tokenEstimate).toBeLessThan(balancedRun.tokenEstimate);
      expect(JSON.stringify(focusedRun)).not.toContain("forbidden-secret");
      expect(JSON.stringify(balancedRun)).not.toContain("forbidden-secret");
    } finally {
      await runtime.close();
    }
  });
});
