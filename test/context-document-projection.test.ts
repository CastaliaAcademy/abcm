import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

const principal: ContextPrincipal = {
  principalId: "agent:projection",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};

describe("versioned document projections before budget admission", () => {
  test("summary и metadata оцениваются по проекции, сохраняя checksum исходника", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-projection-")); roots.push(root);
    await mkdir(join(root, "domain-language"), { recursive: true });
    await mkdir(join(root, "project/config"), { recursive: true });
    await mkdir(join(root, "project/domain-language"), { recursive: true });
    await mkdir(join(root, "project/artifacts"), { recursive: true });
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: workflow\n");
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: project\n");
    await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
    await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(root, "project/artifacts/required.md"), `---\nid: required\nkind: convention\ntitle: Required\nrequired: true\n---\n${"R".repeat(120)}\n`);
    await writeFile(join(root, "project/artifacts/summary.md"), `---\nid: summary\nkind: guide\ntitle: Summary\nprojection: summary\n---\nКороткое решение.\n\n${"NOISE ".repeat(500)}\n`);
    await writeFile(join(root, "project/artifacts/metadata.md"), `---\nid: metadata\nkind: policy\ntitle: Metadata only\nrequired: true\nprojection: metadata\n---\n${"SECRET_METADATA_BODY ".repeat(200)}\n`);

    const runtime = createAbcmRuntime({ id: "test", root }, {
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: principal,
      context: { budgetProfiles: { projected: { softLimitTokens: 70, hardLimitTokens: 80 } } },
    });
    try {
      await runtime.scopeMap.scan("test");
      const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
      const bundle = await runtime.contextBuilder.build({
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        roleId: "agent",
        taskType: "review",
        goal: "Проверить проект",
        exactScopeIds: ["project"],
        budgetProfile: "projected",
        execution: { planId: "PLAN-0031", runId: "projection" },
      }, principal);

      const summary = bundle.selectedDocuments.find(document => document.documentId === "summary")!;
      const metadata = bundle.selectedDocuments.find(document => document.documentId === "metadata")!;
      expect(bundle.selectedDocuments.map(document => document.documentId)).toEqual(expect.arrayContaining(["required", "summary", "metadata"]));
      expect(summary.projection).toEqual(expect.objectContaining({ mode: "summary", authoritative: false, sourceChecksum: summary.checksum }));
      expect(summary.projection.content).toBe("Короткое решение.");
      expect(summary.tokenEstimate).toBeLessThan(10);
      expect(metadata.projection).toEqual(expect.objectContaining({ mode: "metadata", authoritative: false, sourceChecksum: metadata.checksum }));
      expect(metadata.tokenEstimate).toBe(0);
      expect(JSON.stringify(bundle)).not.toContain("SECRET_METADATA_BODY");
      expect(bundle.cache.projectionPolicyVersion).toBe("document-projection/v1");
    } finally {
      await runtime.close();
    }
  });
});
