import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("documentation sync MCP contract", () => {
  test("offers preview/apply/sync tools and preserves mirror read-only policy", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "abcm-sync-mcp-workspace-"));
    const sourceRoot = await mkdtemp(join(tmpdir(), "abcm-sync-mcp-source-"));
    roots.push(workspaceRoot, sourceRoot);
    await mkdir(join(workspaceRoot, "domain-language"));
    await mkdir(join(workspaceRoot, "artifacts", "notes"), { recursive: true });
    await writeFile(join(workspaceRoot, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await writeFile(join(workspaceRoot, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(sourceRoot, "note.md"), "---\nid: OBS-MCP\nkind: note\ntitle: MCP note\n---\nbody\n");

    const runtime = createAbcmRuntime(
      { id: "test", root: workspaceRoot },
      {
        sqliteDerivedStoreEnabled: true,
        documentationSources: [{ id: "obsidian", workspaceId: "test", root: sourceRoot, targetBasePath: "artifacts/notes" }],
      },
    );
    const server = runtime.createMcpServer();
    const client = new Client({ name: "documentation-sync-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name)).toEqual(
        expect.arrayContaining([
          "documentation_source.preview",
          "documentation_source.apply",
          "documentation_source.sync",
          "documentation_source.cutover",
        ]),
      );
      const preview = await client.callTool({
        name: "documentation_source.preview",
        arguments: { workspaceId: "test", sourceId: "obsidian" },
      });
      const importId = (preview.structuredContent as { importId: string }).importId;
      const snapshotDigest = (preview.structuredContent as { snapshotDigest: string }).snapshotDigest;
      const applied = await client.callTool({ name: "documentation_source.apply", arguments: { importId } });
      expect(applied.structuredContent).toEqual(expect.objectContaining({ created: 1, status: "succeeded" }));

      const rejected = await client.callTool({
        name: "workspace.write_file",
        arguments: { workspaceId: "test", path: "artifacts/notes/note.md", content: "local edit" },
      });
      expect(rejected.isError).not.toBe(true);
      expect((rejected.content[0] as { text: string }).text).toContain("MIRROR_DOCUMENT_READ_ONLY");

      const rejectedDelete = await client.callTool({
        name: "workspace.delete_file",
        arguments: { workspaceId: "test", path: "artifacts/notes/note.md" },
      });
      expect(rejectedDelete.isError).not.toBe(true);
      expect((rejectedDelete.content[0] as { text: string }).text).toContain("MIRROR_DOCUMENT_READ_ONLY");

      const rejectedMove = await client.callTool({
        name: "workspace.move_file",
        arguments: { workspaceId: "test", from: "artifacts/notes/note.md", to: "artifacts/notes/moved.md" },
      });
      expect(rejectedMove.isError).not.toBe(true);
      expect((rejectedMove.content[0] as { text: string }).text).toContain("MIRROR_DOCUMENT_READ_ONLY");

      const cutover = await client.callTool({
        name: "documentation_source.cutover",
        arguments: { sourceId: "obsidian", operatorApproved: true, expectedSnapshotDigest: snapshotDigest },
      });
      expect(cutover.structuredContent).toEqual(expect.objectContaining({ status: "completed", storageMode: "managed" }));
      const managedWrite = await client.callTool({
        name: "workspace.write_file",
        arguments: { workspaceId: "test", path: "artifacts/notes/note.md", content: "managed" },
      });
      expect(managedWrite.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
