import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function workspace(id: string) {
  const root = await mkdtemp(join(tmpdir(), `abcm-tags-${id}-`));
  roots.push(root);
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "project/config"), { recursive: true });
  await mkdir(join(root, "project/domain-language"), { recursive: true });
  await mkdir(join(root, "project/artifacts/guides"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), `apiVersion: abcm/v1\nkind: workflow\nid: ${id}\nname: ${id}\n`);
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/scope.yaml"), `apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n`);
  await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/artifacts/guides/a.md"), "---\nid: shared-doc\nkind: guide\ntitle: A\ntags: [Alpha/Group]\n---\n# Heading\nText #Beta_Tag and `#ignored`.\n```ts\n#also-ignored\n```\n");
  await writeFile(join(root, "project/artifacts/guides/b.md"), "---\nid: second-doc\nkind: guide\ntitle: B\n---\nRelated #alpha/group.\n");
  return root;
}

describe("tag-derived LinkPackages", () => {
  test("indexes Obsidian tags, updates after file mutation and binds build to one workspace", async () => {
    const firstRoot = await workspace("first");
    const secondRoot = await workspace("second");
    const stateRoot = await mkdtemp(join(tmpdir(), "abcm-tags-state-"));
    roots.push(stateRoot);
    const access = { workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read"] as const };
    const principal = { principalId: "tag-agent", access };
    const runtime = createAbcmRuntime([{ id: "first", root: firstRoot }, { id: "second", root: secondRoot }], {
      contextPrincipal: principal,
      scopeMapAccess: access,
      fileOperations: { stateRoot },
    });
    try {
      await runtime.scopeMap.scan("first");
      await runtime.scopeMap.scan("second");
      const packages = runtime.contextLinkPackages!.list("first");
      const alpha = packages.find(candidate => candidate.tag === "alpha/group")!;
      const secondWorkspaceAlpha = runtime.contextLinkPackages!.list("second").find(candidate => candidate.tag === "alpha/group")!;
      expect(secondWorkspaceAlpha.packageId).not.toBe(alpha.packageId);
      expect(alpha.documentIds).toEqual(["second-doc", "shared-doc"]);
      expect(packages.find(candidate => candidate.tag === "beta_tag")?.documentIds).toEqual(["shared-doc"]);
      expect(packages.some(candidate => candidate.tag.includes("ignored"))).toBe(false);

      const sessionBootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "first", projectId: "project" } }, principal);
      const session = await runtime.contextLinkGraphSessions!.start({
        workspaceId: "first",
        seedDocumentIds: ["shared-doc"],
        request: { domainLanguageBootstrapId: sessionBootstrap.bootstrapId, roleId: "agent", taskType: "research", goal: "Follow tag links", exactScopeIds: ["project"] },
      });
      expect(session.candidates).toContainEqual(expect.objectContaining({ documentId: "second-doc", via: expect.arrayContaining([expect.objectContaining({ edgeType: "tag" })]) }));

      const secondBootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "second", projectId: "project" } }, principal);
      await expect(runtime.contextLinkPackages!.build({
        workspaceId: "first",
        packageId: alpha.packageId,
        request: { domainLanguageBootstrapId: secondBootstrap.bootstrapId, roleId: "agent", taskType: "research", goal: "Attempt cross-workspace substitution", exactScopeIds: ["project"] },
      })).rejects.toMatchObject({ code: "CONTEXT_LINK_PACKAGE_STALE" });
      await expect(runtime.contextLinkPackages!.build({
        workspaceId: "second",
        packageId: alpha.packageId,
        request: { domainLanguageBootstrapId: secondBootstrap.bootstrapId, roleId: "agent", taskType: "research", goal: "Attempt package identity substitution", exactScopeIds: ["project"] },
      })).rejects.toMatchObject({ code: "CONTEXT_LINK_PACKAGE_NOT_FOUND" });

      const original = await runtime.files.read("first", "project/artifacts/guides/b.md");
      await runtime.files.write("first", "project/artifacts/guides/b.md", new TextEncoder().encode("---\nid: second-doc\nkind: guide\ntitle: B\n---\nNo tag now.\n"), { ifMatch: original.entry.checksum });
      const updatedAlpha = runtime.contextLinkPackages!.list("first").find(candidate => candidate.tag === "alpha/group")!;
      expect(updatedAlpha.packageId).toBe(alpha.packageId);
      expect(updatedAlpha.packageDigest).not.toBe(alpha.packageDigest);
      expect(updatedAlpha.documentIds).toEqual(["shared-doc"]);
    } finally {
      await runtime.close();
    }
  });
});
