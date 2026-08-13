import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<{ root: string; scopeMap: ScopeMapService }> {
  const root = await mkdtemp(join(tmpdir(), "abcm-index-hardening-"));
  roots.push(root);
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "artifacts"), { recursive: true });
  await mkdir(join(root, "agents/skills/unsafe/scripts"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: Workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "artifacts/small.md"), "---\nid: SMALL\nkind: guide\ntitle: Small\n---\nsmall\n");
  await writeFile(join(root, "artifacts/oversized.md"), `---\nid: HUGE\nkind: guide\ntitle: Huge\n---\n${"x".repeat(1024)}`);
  await writeFile(join(root, "artifacts/custom-tag.md"), "---\nid: TAGGED\nkind: guide\ntitle: !!js/function 'process.exit()'\n---\nbody\n");
  await writeFile(join(root, "agents/skills/unsafe/SKILL.md"), "---\nname: unsafe\ndescription: Unsafe fixture\nmetadata:\n  abcm-skill-strategy: manual\n---\n# Unsafe\n");
  await writeFile(join(root, "agents/skills/unsafe/scripts/run.js"), "globalThis.SECURITY_SENTINEL = 'executed';\n");
  const registry = new WorkspaceRegistry([{ id: "test", root, maxIndexBytes: 256 }]);
  const scopeMap = new ScopeMapService(registry);
  return { root, scopeMap };
}

describe("content indexing hardening", () => {
  test("skips oversized bodies, rejects custom YAML tags, and never activates executable resources", async () => {
    const { scopeMap } = await fixture();
    const revision = await scopeMap.scan("test");

    expect(revision.documents.map(document => document.documentId)).toContain("SMALL");
    expect(revision.documents.map(document => document.documentId)).not.toContain("HUGE");
    expect(revision.documents.map(document => document.documentId)).not.toContain("TAGGED");
    expect(revision.files.some(file => file.relativePath === "artifacts/oversized.md")).toBe(false);
    expect(revision.diagnostics).toContainEqual(expect.objectContaining({
      code: "FILE_TOO_LARGE",
      path: "artifacts/oversized.md",
      scopeId: "workflow",
    }));
    expect(revision.executableResources).toContainEqual(expect.objectContaining({
      relativePath: "agents/skills/unsafe/scripts/run.js",
      activationStatus: "required",
    }));
    expect((globalThis as Record<string, unknown>)["SECURITY_SENTINEL"]).toBeUndefined();
    expect(JSON.stringify(revision)).not.toContain("executed");
  });
});
