import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DomainLanguageService } from "../src/domain-language/domain-language-service.js";
import { ScopePathResolver } from "../src/domain-language/scope-path-resolver.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";
import { SkillConnectionResolver } from "../src/skills/skill-connection-resolver.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function scope(root: string, path: string, kind: string, id: string) {
  const dir = join(root, path); await mkdir(join(dir, "domain-language"), { recursive: true });
  await writeFile(join(dir, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  if (kind === "project") {
    await mkdir(join(dir, "config"), { recursive: true });
    await writeFile(join(dir, "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  }
  await writeFile(join(dir, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
}

async function skill(root: string, scopePath: string, name: string, metadata: Record<string, string>, description = name) {
  const dir = join(root, scopePath, "agents/skills", name); await mkdir(dir, { recursive: true });
  const lines = Object.entries(metadata).map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`).join("\n");
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\ncompatibility: ABCM MVP\nmetadata:\n${lines}\n---\n\n# ${name}\n\nBODY-${name}\n`);
}

const principal: ContextPrincipal = { principalId: "agent:skills", access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build"] } };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-skills-")); roots.push(root);
  await scope(root, "", "workflow", "workflow"); await scope(root, "project", "project", "commerce");
  await scope(root, "project/catalog", "service", "catalog"); await scope(root, "project/catalog/search", "feature", "search");
  await skill(root, "", "baseline", { "abcm-skill-strategy": "global", "abcm-roles": "executor" });
  await skill(root, "project", "scoped", { "abcm-skill-strategy": "scope", "abcm-required-kinds": "adr", "abcm-required-tags": "security" });
  await skill(root, "project/catalog", "scoped", { "abcm-skill-strategy": "scope", "abcm-required-links": "abcm://artifact/ADR-1" });
  await skill(root, "", "security-review", { "abcm-skill-strategy": "by-link" });
  await skill(root, "project", "prisma-upgrade", { "abcm-skill-strategy": "by-description", "abcm-task-types": "dependency-upgrade", "abcm-tags": "prisma" }, "Upgrade Prisma dependencies safely");
  await skill(root, "project/catalog", "experimental", { "abcm-skill-strategy": "manual" });
  await skill(root, "project", "legacy", { "abcm-context-strategy": "scope", "abcm-context-base": "all" });
  await mkdir(join(root, "project/catalog/agents/skills/experimental/scripts"), { recursive: true });
  await writeFile(join(root, "project/catalog/agents/skills/experimental/scripts/run.js"), "SECRET-SCRIPT-BODY\n");
  const registry = new WorkspaceRegistry([{ id: "test", root }]); const scopeMap = new ScopeMapService(registry); await scopeMap.scan("test");
  const domainLanguage = new DomainLanguageService(registry, scopeMap); const pathResolver = new ScopePathResolver(domainLanguage, scopeMap);
  const bootstrap = await domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "commerce" } }, principal);
  const path = await pathResolver.resolve({ domainLanguageBootstrapId: bootstrap.bootstrapId, goal: "search" }, principal);
  return { root, scopeMap, path, resolver: new SkillConnectionResolver(registry, scopeMap) };
}

describe("SkillConnectionResolver", () => {
  test("indexes descriptors without bodies and connects all five strategies with local precedence", async () => {
    const { scopeMap, path, resolver } = await fixture();
    const revision = scopeMap.getActiveRevision("test");
    expect(revision.skills.map(skill => skill.skillId)).toEqual(expect.arrayContaining(["baseline", "scoped", "security-review", "prisma-upgrade", "experimental", "legacy"]));
    expect(JSON.stringify(revision.skills)).not.toContain("BODY-");
    expect(JSON.stringify(revision)).not.toContain("SECRET-SCRIPT-BODY");

    const result = await resolver.resolve({
      workspaceId: "test", path, intent: { ...path.normalizedIntent, normalizedGoal: "upgrade prisma dependencies", keywords: ["prisma"] },
      roleId: "executor", taskType: "dependency-upgrade", explicitSkillLinks: ["abcm://skill/security-review"],
      requestedSkillIds: ["experimental"], approvalId: "DEC-1",
    }, principal);

    expect(result.connectedSkills.map(skill => skill.skillId)).toEqual(["baseline", "experimental", "legacy", "prisma-upgrade", "scoped", "security-review"]);
    expect(result.connectedSkills.find(skill => skill.skillId === "scoped")).toEqual(expect.objectContaining({ sourceScopeId: "catalog", connectionReasons: ["scope_owner_or_descendant"] }));
    expect(result.connectedSkills.find(skill => skill.skillId === "experimental")).toEqual(expect.objectContaining({ approvalId: "DEC-1", connectionReasons: ["manual_request"] }));
    expect(result.connectedSkills.every(skill => skill.body.includes(`BODY-${skill.skillId}`))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET-SCRIPT-BODY");
    expect(result.contextRequirements).toContainEqual({ sourceSkillId: "scoped", kind: "explicit_link", value: "abcm://artifact/ADR-1" });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      { code: "SKILL_CONTEXT_BASE_REMOVED", skillId: "legacy" },
      { code: "SKILL_CONTEXT_STRATEGY_DEPRECATED", skillId: "legacy" },
    ]));
  });

  test("keeps manual disconnected and fails required link, description ambiguity, and lower-scope global", async () => {
    const { root, scopeMap, path, resolver } = await fixture();
    const implicit = await resolver.resolve({ workspaceId: "test", path, intent: path.normalizedIntent, roleId: "executor", taskType: "feature" }, principal);
    expect(implicit.connectedSkills.map(skill => skill.skillId)).not.toContain("experimental");
    await expect(resolver.resolve({ workspaceId: "test", path, intent: path.normalizedIntent, roleId: "executor", taskType: "feature", explicitSkillLinks: ["abcm://skill/missing"] }, principal)).rejects.toMatchObject({ code: "REQUIRED_SKILL_LINK_UNRESOLVED" });

    await skill(root, "project", "prisma-migrate", { "abcm-skill-strategy": "by-description", "abcm-task-types": "dependency-upgrade", "abcm-tags": "prisma" }, "Upgrade Prisma dependencies safely");
    await scopeMap.scan("test");
    const currentPath = { ...path, mapRevision: scopeMap.getActiveRevision("test").revision };
    await expect(resolver.resolve({ workspaceId: "test", path: currentPath, intent: { ...path.normalizedIntent, normalizedGoal: "upgrade prisma", keywords: ["prisma"] }, roleId: "executor", taskType: "dependency-upgrade" }, principal)).rejects.toMatchObject({ code: "SKILL_CONNECTION_AMBIGUOUS" });

    await skill(root, "project/catalog", "bad-global", { "abcm-skill-strategy": "global" });
    await scopeMap.scan("test");
    await expect(resolver.resolve({ workspaceId: "test", path: { ...path, mapRevision: scopeMap.getActiveRevision("test").revision }, intent: path.normalizedIntent, roleId: "executor", taskType: "feature" }, principal)).rejects.toMatchObject({ code: "GLOBAL_SKILL_MUST_BE_WORKFLOW_OWNED" });
  });
});
