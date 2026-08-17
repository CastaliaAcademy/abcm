import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmMcpServer } from "../src/mcp/create-server.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
const staleChecksum = `sha256:${"0".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-mcp-batch-"));
  roots.push(root);
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const files = new WorkspaceFileService(registry);
  const server = createAbcmMcpServer({ files, scopeMap: new ScopeMapService(registry), defaultWorkspaceId: "test" });
  const client = new Client({ name: "batch-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { files, server, client };
}

describe("MCP batch file tools", () => {
  test("creates, updates, and deletes with ordered best-effort results", async () => {
    const { files, server, client } = await fixture();
    try {
      const created = await client.callTool({
        name: "workspace.batch_create_files",
        arguments: {
          workspaceId: "test",
          files: [
            { path: "batch/a.md", content: "alpha" },
            { path: "batch/b.md", content: Buffer.from("bravo").toString("base64"), encoding: "base64" },
          ],
        },
      });
      expect(created.isError).not.toBe(true);
      expect(created.structuredContent).toEqual(expect.objectContaining({ succeeded: 2, failed: 0 }));
      const createResults = (created.structuredContent as { results: Array<{ entry: { checksum: string } }> }).results;
      expect(createResults.map((result, index) => ({ index, checksum: result.entry.checksum }))).toEqual([
        { index: 0, checksum: expect.stringMatching(/^sha256:/) },
        { index: 1, checksum: expect.stringMatching(/^sha256:/) },
      ]);

      const partialCreate = await client.callTool({
        name: "workspace.batch_create_files",
        arguments: {
          workspaceId: "test",
          files: [
            { path: "batch/a.md", content: "must-not-overwrite" },
            { path: "batch/c.md", content: "charlie" },
          ],
        },
      });
      expect(partialCreate.structuredContent).toEqual({
        succeeded: 1,
        failed: 1,
        results: [
          expect.objectContaining({ index: 0, path: "batch/a.md", status: "failed", error: expect.objectContaining({ code: "FILE_ALREADY_EXISTS" }) }),
          expect.objectContaining({ index: 1, path: "batch/c.md", status: "succeeded" }),
        ],
      });
      expect(new TextDecoder().decode((await files.read("test", "batch/a.md")).content)).toBe("alpha");

      const updated = await client.callTool({
        name: "workspace.batch_update_files",
        arguments: {
          workspaceId: "test",
          files: [
            { path: "batch/a.md", content: "alpha-2", ifMatch: createResults[0]!.entry.checksum },
            { path: "batch/b.md", content: "stale", ifMatch: staleChecksum },
          ],
        },
      });
      expect(updated.structuredContent).toEqual({
        succeeded: 1,
        failed: 1,
        results: [
          expect.objectContaining({ index: 0, path: "batch/a.md", status: "succeeded" }),
          expect.objectContaining({ index: 1, path: "batch/b.md", status: "failed", error: expect.objectContaining({ code: "FILE_CHECKSUM_MISMATCH" }) }),
        ],
      });
      const updateChecksum = ((updated.structuredContent as { results: Array<{ entry?: { checksum: string } }> }).results[0]!.entry)!.checksum;
      expect(new TextDecoder().decode((await files.read("test", "batch/b.md")).content)).toBe("bravo");

      const deleted = await client.callTool({
        name: "workspace.batch_delete_files",
        arguments: {
          workspaceId: "test",
          files: [
            { path: "batch/a.md", ifMatch: updateChecksum },
            { path: "batch/b.md", ifMatch: staleChecksum },
          ],
        },
      });
      expect(deleted.structuredContent).toEqual({
        succeeded: 1,
        failed: 1,
        results: [
          { index: 0, path: "batch/a.md", status: "succeeded", deleted: true },
          expect.objectContaining({ index: 1, path: "batch/b.md", status: "failed", error: expect.objectContaining({ code: "FILE_CHECKSUM_MISMATCH" }) }),
        ],
      });
      await expect(files.read("test", "batch/a.md")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
      expect(new TextDecoder().decode((await files.read("test", "batch/b.md")).content)).toBe("bravo");
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("rejects unsafe batch shapes before executing any item", async () => {
    const { files, server, client } = await fixture();
    try {
      const duplicate = await client.callTool({
        name: "workspace.batch_create_files",
        arguments: { workspaceId: "test", files: [{ path: "same.md", content: "one" }, { path: "same.md", content: "two" }] },
      });
      expect(duplicate.isError).toBe(true);
      await expect(files.read("test", "same.md")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });

      const missingChecksum = await client.callTool({
        name: "workspace.batch_update_files",
        arguments: { workspaceId: "test", files: [{ path: "same.md", content: "two" }] },
      });
      expect(missingChecksum.isError).toBe(true);

      const tooLarge = await client.callTool({
        name: "workspace.batch_create_files",
        arguments: { workspaceId: "test", files: Array.from({ length: 101 }, (_, index) => ({ path: `${index}.md`, content: "x" })) },
      });
      expect(tooLarge.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
