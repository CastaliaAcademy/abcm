import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scope(root: string, relativePath: string, kind: string, id: string, withConvention = true) {
  const directory = join(root, relativePath);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  if (kind === "project") {
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  }
  if (withConvention) {
    await mkdir(join(directory, "domain-language"), { recursive: true });
    await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  }
}

async function serviceFor(root: string) {
  roots.push(root);
  return new ScopeMapService(new WorkspaceRegistry([{ id: "test", root }]));
}

describe("ScopeMapService", () => {
  test("discovers only direct scope children and produces stable digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-map-"));
    await scope(root, "", "workflow", "workflow");
    await scope(root, "project", "project", "project");
    await scope(root, "project/service", "service", "service");
    await scope(root, "src/hidden", "project", "hidden");
    const service = await serviceFor(root);

    const first = await service.scan("test");
    const second = await service.scan("test");

    expect(first.nodes.map(node => node.scopeId)).toEqual(["workflow", "project", "service"]);
    expect(first.digest).toBe(second.digest);
    expect(service.getProjection("test", "agent").nodes.every(node => node.status === "valid")).toBe(true);
  });

  test("keeps invalid branch diagnostics out of agent view", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-map-"));
    await scope(root, "", "workflow", "workflow");
    await scope(root, "project", "project", "project");
    await scope(root, "project/repeated", "project", "repeated");
    await scope(root, "other", "project", "other");
    const service = await serviceFor(root);

    const revision = await service.scan("test");

    expect(revision.diagnostics).toContainEqual(expect.objectContaining({ code: "SCOPE_HIERARCHY_INVALID", path: "project/repeated" }));
    expect(service.getProjection("test", "agent").nodes.map(node => node.scopeId)).not.toContain("repeated");
    expect(service.getProjection("test", "admin").nodes.map(node => node.scopeId)).toContain("repeated");
    expect(service.getProjection("test", "agent").nodes.map(node => node.scopeId)).toContain("other");
  });

  test("warns for missing DomainLanguageConvention", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-map-"));
    await scope(root, "", "workflow", "workflow", false);
    const service = await serviceFor(root);

    const revision = await service.scan("test");

    expect(revision.nodes[0]?.readiness).toBe("warning");
    expect(revision.diagnostics).toContainEqual(expect.objectContaining({ code: "DOMAIN_LANGUAGE_CONFIGURATION_INVALID" }));
  });

  test("marks a project unready when its mandatory language is missing or invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-map-"));
    await scope(root, "", "workflow", "workflow");
    await scope(root, "project", "project", "project");
    await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: русский\n");
    const service = await serviceFor(root);

    const revision = await service.scan("test");

    expect(revision.nodes.find(node => node.scopeId === "project")?.readiness).toBe("warning");
    expect(revision.diagnostics).toContainEqual(expect.objectContaining({
      code: "PROJECT_LANGUAGE_CONFIGURATION_INVALID",
      path: "project/config/context.yaml",
      scopeId: "project",
    }));
  });

  test("rejects a non-workflow root", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-map-"));
    await scope(root, "", "project", "project");
    const service = await serviceFor(root);

    expect(service.scan("test")).rejects.toMatchObject({ code: "WORKSPACE_ROOT_MUST_BE_WORKFLOW" });
  });
});
