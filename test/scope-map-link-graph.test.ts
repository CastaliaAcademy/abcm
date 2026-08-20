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
  const root = await mkdtemp(join(tmpdir(), "abcm-link-graph-"));
  roots.push(root);
  await mkdir(join(root, "domain-language"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: Workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await mkdir(join(root, "project", "config"), { recursive: true });
  await mkdir(join(root, "project", "domain-language"), { recursive: true });
  await mkdir(join(root, "project", "artifacts", "adr"), { recursive: true });
  await writeFile(join(root, "project", "scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
  await writeFile(join(root, "project", "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project", "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");

  await writeFile(
    join(root, "project", "artifacts", "adr", "DOC-A.md"),
    [
      "---",
      "id: DOC-A",
      "kind: adr",
      "title: Alpha",
      "aliases: [Alpha Alias]",
      "links: [abcm://artifact/DOC-C]",
      "---",
      "# Decisions",
      "[[DOC-B]]",
      "![[Beta Note]]",
      "[[DOC-B#Runbook]]",
      "[[DOC-B#^critical]]",
      "[[Missing]]",
      "[[Shared]]",
      "```md",
      "[[FencedOnly]]",
      "```",
      "`[[CodeOnly]]`",
      "\\[[EscapedOnly]]",
      "SECRET-LINK-BODY",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "project", "artifacts", "adr", "DOC-B--old-name.md"),
    [
      "---",
      "id: DOC-B",
      "kind: adr",
      "title: Beta",
      "aliases: Beta Note",
      "---",
      "# Runbook",
      "Important constraint ^critical",
      "[[DOC-A]]",
      "",
    ].join("\n"),
  );
  for (const id of ["DOC-C", "DOC-D"] as const) {
    await writeFile(
      join(root, "project", "artifacts", "adr", `${id}.md`),
      `---\nid: ${id}\nkind: adr\ntitle: ${id}\naliases: [Shared]\n---\nBody\n`,
    );
  }

  return { root, service: new ScopeMapService(new WorkspaceRegistry([{ id: "test", root }])) };
}

describe("ScopeMap typed link graph", () => {
  test("publishes a deterministic body-free graph for typed Obsidian and domain links", async () => {
    const { service } = await fixture();
    const first = await service.scan("test");
    const graph = first.linkGraph;

    expect(graph.apiVersion).toBe("abcm/link-graph/v1");
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes.find(node => node.documentId === "DOC-B")).toEqual(
      expect.objectContaining({
        nodeId: "document:DOC-B",
        aliases: ["Beta Note"],
        headings: [{ text: "Runbook", anchor: "runbook" }],
        blocks: ["critical"],
      }),
    );
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "wiki-link", fromDocumentId: "DOC-A", toDocumentId: "DOC-B", status: "resolved" }),
      expect.objectContaining({ type: "embed", fromDocumentId: "DOC-A", toDocumentId: "DOC-B", status: "resolved" }),
      expect.objectContaining({ type: "heading-reference", fromDocumentId: "DOC-A", toDocumentId: "DOC-B", status: "resolved" }),
      expect.objectContaining({ type: "block-reference", fromDocumentId: "DOC-A", toDocumentId: "DOC-B", status: "resolved" }),
      expect.objectContaining({ type: "domain-relation", fromDocumentId: "DOC-A", toDocumentId: "DOC-C", status: "resolved" }),
      expect.objectContaining({ type: "backlink", fromDocumentId: "DOC-B", toDocumentId: "DOC-A", status: "resolved" }),
      expect.objectContaining({ type: "wiki-link", fromDocumentId: "DOC-A", status: "broken", reference: expect.objectContaining({ documentTarget: "Missing" }) }),
      expect.objectContaining({ type: "wiki-link", fromDocumentId: "DOC-A", status: "ambiguous", reference: expect.objectContaining({ documentTarget: "Shared" }) }),
    ]));
    expect(first.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LINK_GRAPH_BROKEN", scopeId: "project" }),
      expect.objectContaining({ code: "LINK_GRAPH_AMBIGUOUS", scopeId: "project" }),
      expect.objectContaining({ code: "LINK_GRAPH_CYCLE", scopeId: "project" }),
    ]));
    expect(JSON.stringify(graph.edges)).not.toContain("CodeOnly");
    expect(JSON.stringify(graph.edges)).not.toContain("FencedOnly");
    expect(JSON.stringify(graph.edges)).not.toContain("EscapedOnly");
    expect(JSON.stringify(first)).not.toContain("SECRET-LINK-BODY");
    expect(service.summarize(first).linkGraphSummary).toEqual({
      policyVersion: "v1",
      digest: graph.digest,
      nodes: 4,
      edges: graph.edges.length,
      resolved: graph.edges.filter(edge => edge.status === "resolved").length,
      broken: 1,
      ambiguous: 1,
    });

    const second = await service.scan("test");
    expect(second.linkGraph).toEqual(first.linkGraph);
    expect(second.digest).toBe(first.digest);
  });

  test("keeps document node identity and resolved targets stable across a file rename", async () => {
    const { root, service } = await fixture();
    const first = await service.scan("test");
    await rename(
      join(root, "project", "artifacts", "adr", "DOC-B--old-name.md"),
      join(root, "project", "artifacts", "adr", "DOC-B--new-name.md"),
    );

    const renamed = await service.scan("test");
    expect(renamed.linkGraph.nodes.find(node => node.documentId === "DOC-B")).toEqual(
      expect.objectContaining({ nodeId: "document:DOC-B", relativePath: "project/artifacts/adr/DOC-B--new-name.md" }),
    );
    expect(renamed.linkGraph.edges).toContainEqual(
      expect.objectContaining({ type: "wiki-link", fromDocumentId: "DOC-A", toDocumentId: "DOC-B", status: "resolved" }),
    );
    expect(renamed.linkGraph.digest).not.toBe(first.linkGraph.digest);
  });
});
