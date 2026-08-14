import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function addScope(root: string, path: string, id: string, aliases: readonly string[] = []): Promise<void> {
  await mkdir(join(root, path, "domain-language"), { recursive: true });
  await writeFile(
    join(root, path, "scope.yaml"),
    `apiVersion: abcm/v1\nkind: ${path === "" ? "workflow" : "project"}\nid: ${id}\nname: ${id}\naliases: [${aliases.join(", ")}]\n`,
  );
  await writeFile(join(root, path, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
}

async function fixture(): Promise<{ root: string; service: ScopeMapService }> {
  const root = await mkdtemp(join(tmpdir(), "abcm-relations-"));
  roots.push(root);
  await addScope(root, "", "workflow");
  await addScope(root, "source", "source");
  await addScope(root, "target", "target", ["target-alias"]);
  await mkdir(join(root, "source/artifacts/adr"), { recursive: true });
  await writeFile(
    join(root, "source/artifacts/adr/ADR-0001--source.md"),
    "---\nid: ADR-0001\nkind: adr\ntitle: Source\nstatus: accepted\nlinks:\n  - abcm://scope/target-alias\n  - abcm://artifact/MISSING-OPTIONAL\n---\nSECRET-RELATION-BODY\n",
  );
  await mkdir(join(root, "target/artifacts/adr"), { recursive: true });
  await writeFile(
    join(root, "target/artifacts/adr/ADR-0002--target.md"),
    "---\nid: ADR-0002\nkind: adr\ntitle: Target\nstatus: accepted\n---\nTarget body\n",
  );
  await mkdir(join(root, "source/config"), { recursive: true });
  await writeFile(
    join(root, "source/config/relations.yaml"),
    "apiVersion: abcm/v1\nkind: ScopeRelations\nrelations:\n  - id: target-dependency\n    target: abcm://artifact/ADR-0002\n    type: depends-on\n  - id: required-plan\n    target: abcm://plan/PLAN-MISSING\n    type: governed-by\n    required: true\n",
  );
  return { root, service: new ScopeMapService(new WorkspaceRegistry([{ id: "test", root }])) };
}

describe("ScopeMap explicit relations", () => {
  test("resolves stable scope/document links and records optional/required misses deterministically", async () => {
    const { service } = await fixture();

    const first = await service.scan("test");
    const second = await service.scan("test");

    expect(first.digest).toBe(second.digest);
    expect(first.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromId: "source", toId: "target", relationType: "explicit-link", source: "document:ADR-0001", status: "resolved" }),
        expect.objectContaining({ fromId: "source", toId: "ADR-0002", relationType: "depends-on", source: "relations:target-dependency", status: "resolved" }),
        expect.objectContaining({ fromId: "source", toId: "abcm://artifact/MISSING-OPTIONAL", status: "unresolved_optional" }),
        expect.objectContaining({ fromId: "source", toId: "abcm://plan/PLAN-MISSING", status: "unresolved_required" }),
      ]),
    );
    expect(first.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "EXPLICIT_LINK_UNRESOLVED", severity: "warning", scopeId: "source" }),
      ]),
    );
    expect(first.nodes.find(node => node.scopeId === "source")?.readiness).toBe("warning");
    expect(JSON.stringify(first)).not.toContain("SECRET-RELATION-BODY");

    const agent = service.getProjection("test", "agent");
    expect(agent.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromId: "workflow", toId: "source", relationType: "parent-child" }),
        expect.objectContaining({ fromId: "source", toId: "target", relationType: "explicit-link" }),
      ]),
    );
    expect(JSON.stringify(agent)).not.toContain("ADR-0001--source.md");
    expect(JSON.stringify(agent)).not.toContain("SECRET-");
    expect(agent.relations.some(relation => relation.status !== "resolved")).toBe(false);
    expect(service.getProjection("test", "admin").relations).toContainEqual(
      expect.objectContaining({ toId: "abcm://plan/PLAN-MISSING", status: "unresolved_required" }),
    );
  });

  test("publishes strict configuration and physical-path failures without resolving them", async () => {
    const { root, service } = await fixture();
    await writeFile(
      join(root, "source/config/relations.yaml"),
      "apiVersion: abcm/v1\nkind: ScopeRelations\nrelations:\n  - id: forbidden\n    target: /mnt/share/target\n    type: depends-on\n",
    );
    const invalidPath = await service.scan("test");
    expect(invalidPath.relations.some(relation => relation.toId === "/mnt/share/target")).toBe(false);
    expect(invalidPath.diagnostics).toContainEqual(expect.objectContaining({ code: "EXPLICIT_LINK_INVALID", scopeId: "source" }));
    expect(JSON.stringify(service.getProjection("test", "agent"))).not.toContain("/mnt/share/target");

    for (const forbiddenTarget of ["C:\\\\share\\target", "\\\\server\\share\\target", "../target"]) {
      await writeFile(
        join(root, "source/config/relations.yaml"),
        `apiVersion: abcm/v1\nkind: ScopeRelations\nrelations:\n  - id: forbidden\n    target: ${JSON.stringify(forbiddenTarget)}\n    type: depends-on\n`,
      );
      const forbidden = await service.scan("test");
      expect(forbidden.relations.some(relation => relation.toId === forbiddenTarget)).toBe(false);
      expect(forbidden.diagnostics).toContainEqual(expect.objectContaining({ code: "EXPLICIT_LINK_INVALID" }));
    }

    await writeFile(
      join(root, "source/config/relations.yaml"),
      "apiVersion: abcm/v1\nkind: ScopeRelations\nrelations:\n  - id: forbidden\n    target: abcm://scope/target\n    type: depends-on\n    extra: rejected\n",
    );
    const malformed = await service.scan("test");
    expect(malformed.diagnostics).toContainEqual(expect.objectContaining({ code: "RELATIONS_CONFIGURATION_INVALID", scopeId: "source" }));
  });
});
