import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; service: ScopeMapService }> {
  const root = await mkdtemp(join(tmpdir(), "abcm-content-index-"));
  roots.push(root);
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: Workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");

  await mkdir(join(root, "project", "domain-language"), { recursive: true });
  await writeFile(join(root, "project", "scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
  await writeFile(join(root, "project", "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project", "README.md"), "Project overview\n");

  await mkdir(join(root, "project", "artifacts", "adr"), { recursive: true });
  await writeFile(
    join(root, "project", "artifacts", "adr", "ADR-0001--old-name.md"),
    "---\nid: ADR-0001\nkind: adr\ntitle: Stable decision\nstatus: accepted\nrequired: true\naudiences: [executor-agent]\nlinks: [abcm://scope/project]\n---\nSECRET-DOCUMENT-BODY\n",
  );
  await mkdir(join(root, "project", "src"), { recursive: true });
  await writeFile(join(root, "project", "src", "index.js"), "SECRET-SOURCE-BODY\n");
  await mkdir(join(root, "project", "agents", "skills", "review", "scripts"), { recursive: true });
  await writeFile(join(root, "project", "agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review changes\n---\n");
  await writeFile(join(root, "project", "agents", "skills", "review", "scripts", "run.js"), "SECRET-SCRIPT-BODY\n");

  return { root, service: new ScopeMapService(new WorkspaceRegistry([{ id: "test", root }])) };
}

describe("ScopeMap content indexes", () => {
  test("indexes managed metadata while keeping ordinary source and bodies out", async () => {
    const { service } = await fixture();
    const revision = await service.scan("test");

    expect(revision.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scopeId: "project", relativePath: "project/README.md", classification: "context_document" }),
        expect.objectContaining({ scopeId: "project", relativePath: "project/artifacts/adr/ADR-0001--old-name.md", classification: "context_document" }),
        expect.objectContaining({ scopeId: "project", relativePath: "project/agents/skills/review/SKILL.md", classification: "agent_definition" }),
      ]),
    );
    expect(revision.files.some(file => file.relativePath === "project/src/index.js")).toBe(false);
    expect(revision.documents).toEqual([
      expect.objectContaining({
        documentId: "ADR-0001",
        kind: "adr",
        scopeId: "project",
        relativePath: "project/artifacts/adr/ADR-0001--old-name.md",
        lifecycle: "accepted",
        worker: null,
        requiredSelectors: ["always"],
        roleSelectors: ["executor-agent"],
        links: ["abcm://scope/project"],
      }),
    ]);
    expect(revision.executableResources).toEqual([
      expect.objectContaining({
        scopeId: "project",
        relativePath: "project/agents/skills/review/scripts/run.js",
        language: "javascript",
        activationStatus: "required",
      }),
    ]);
    expect(revision.documents.some(document => document.relativePath.endsWith("run.js"))).toBe(false);
    expect(JSON.stringify(revision)).not.toContain("SECRET-");

    const projection = service.getProjection("test", "admin");
    expect(projection.resourceSummary).toEqual({ indexedFiles: 8, documents: 1, executableResources: 1 });
    expect(JSON.stringify(projection)).not.toContain("ADR-0001--old-name.md");
    expect(JSON.stringify(projection)).not.toContain("run.js");
    expect(JSON.stringify(projection)).not.toContain("src/index.js");
  });

  test("keeps artifact identity across rename and rejects duplicate ids from the active index", async () => {
    const { root, service } = await fixture();
    const first = await service.scan("test");
    const original = first.documents[0]!;
    await rename(
      join(root, "project", "artifacts", "adr", "ADR-0001--old-name.md"),
      join(root, "project", "artifacts", "adr", "ADR-0001--new-name.md"),
    );
    const renamed = await service.scan("test");
    expect(renamed.documents).toHaveLength(1);
    expect(renamed.documents[0]).toEqual(
      expect.objectContaining({ documentId: original.documentId, checksum: original.checksum, relativePath: "project/artifacts/adr/ADR-0001--new-name.md" }),
    );

    await writeFile(
      join(root, "project", "artifacts", "adr", "ADR-0001--duplicate.md"),
      "---\nid: ADR-0001\nkind: adr\ntitle: Duplicate\nstatus: draft\n---\nDuplicate body\n",
    );
    const duplicate = await service.scan("test");
    expect(duplicate.documents).toEqual([]);
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ code: "DOCUMENT_ID_DUPLICATE", scopeId: "project" }),
    );
  });
});
