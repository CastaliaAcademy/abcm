import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function checksum(content: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-mcp-batch-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "abcm-mcp-batch-state-"));
  roots.push(root, stateRoot);
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await mkdir(join(root, "batch"));
  await writeFile(join(root, "batch/update.md"), "before-update");
  await writeFile(join(root, "batch/delete.md"), "delete-me");
  await writeFile(join(root, "batch/move.md"), "move-me");
  const runtime = createAbcmRuntime({ id: "test", root }, { fileOperations: { stateRoot, maxChunkBytes: 4 } });
  await runtime.ready;
  await runtime.scopeMap.scan("test");
  const server = runtime.createMcpServer();
  const client = new Client({ name: "batch-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { runtime, server, client };
}

async function upload(client: Client, content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const started = await client.callTool({
    name: "workspace.upload_start",
    arguments: { workspaceId: "test", size: bytes.byteLength, checksum: checksum(bytes), contentType: "text/plain; charset=utf-8" },
  });
  expect(started.isError).not.toBe(true);
  const uploadId = (started.structuredContent as { uploadId: string }).uploadId;
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += 4, index += 1) {
    const chunk = bytes.slice(offset, offset + 4);
    const result = await client.callTool({
      name: "workspace.upload_chunk",
      arguments: { workspaceId: "test", uploadId, index, content: Buffer.from(chunk).toString("base64"), checksum: checksum(chunk) },
    });
    expect(result.isError).not.toBe(true);
  }
  const completed = await client.callTool({ name: "workspace.upload_complete", arguments: { workspaceId: "test", uploadId } });
  expect(completed.structuredContent).toEqual(expect.objectContaining({ uploadId, status: "completed", checksum: checksum(bytes) }));
  return uploadId;
}

describe("MCP upload and atomic batch file tools", () => {
  test("uploads bytes separately and atomically applies a mixed batch with replay", async () => {
    const { runtime, server, client } = await fixture();
    try {
      const createUploadId = await upload(client, "created");
      const updateUploadId = await upload(client, "updated");
      const updateChecksum = (await runtime.files.read("test", "batch/update.md")).entry.checksum;
      const deleteChecksum = (await runtime.files.read("test", "batch/delete.md")).entry.checksum;
      const moveChecksum = (await runtime.files.read("test", "batch/move.md")).entry.checksum;
      const revision = runtime.scopeMap.getActiveRevision("test").revision;
      const operations = [
        { operation: "create" as const, path: "batch/create.md", uploadId: createUploadId, ifNoneMatch: "*" as const },
        { operation: "update" as const, path: "batch/update.md", uploadId: updateUploadId, ifMatch: updateChecksum },
        { operation: "delete" as const, path: "batch/delete.md", ifMatch: deleteChecksum },
        { operation: "move" as const, from: "batch/move.md", to: "batch/moved.md", ifMatch: moveChecksum, overwrite: false as const },
      ];

      const dryRun = await client.callTool({
        name: "workspace.batch_apply",
        arguments: { workspaceId: "test", idempotencyKey: "mcp-mixed-batch-1", expectedMapRevision: revision, dryRun: true, operations },
      });
      expect(dryRun.structuredContent).toEqual(expect.objectContaining({ status: "validated", replayed: false, mapRevisionBefore: revision, mapRevisionAfter: revision }));
      await expect(runtime.files.read("test", "batch/create.md")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });

      const applied = await client.callTool({
        name: "workspace.batch_apply",
        arguments: { workspaceId: "test", idempotencyKey: "mcp-mixed-batch-1", expectedMapRevision: revision, dryRun: false, operations },
      });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toEqual(expect.objectContaining({ status: "applied", replayed: false, results: expect.arrayContaining([expect.objectContaining({ status: "applied" })]) }));

      const replayed = await client.callTool({
        name: "workspace.batch_apply",
        arguments: { workspaceId: "test", idempotencyKey: "mcp-mixed-batch-1", expectedMapRevision: revision, dryRun: false, operations },
      });
      expect(replayed.structuredContent).toEqual(expect.objectContaining({ status: "applied", replayed: true }));
      expect(new TextDecoder().decode((await runtime.files.read("test", "batch/create.md")).content)).toBe("created");
      expect(new TextDecoder().decode((await runtime.files.read("test", "batch/update.md")).content)).toBe("updated");
      await expect(runtime.files.read("test", "batch/delete.md")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
      await expect(runtime.files.read("test", "batch/move.md")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
      expect(new TextDecoder().decode((await runtime.files.read("test", "batch/moved.md")).content)).toBe("move-me");
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  test("rejects a conflicting chunk and leaves an invalid batch unapplied", async () => {
    const { runtime, server, client } = await fixture();
    try {
      const bytes = new TextEncoder().encode("four");
      const started = await client.callTool({
        name: "workspace.upload_start",
        arguments: { workspaceId: "test", size: bytes.byteLength, checksum: checksum(bytes) },
      });
      const uploadId = (started.structuredContent as { uploadId: string }).uploadId;
      const chunkArguments = { workspaceId: "test", uploadId, index: 0, content: Buffer.from(bytes).toString("base64"), checksum: checksum(bytes) };
      expect((await client.callTool({ name: "workspace.upload_chunk", arguments: chunkArguments })).isError).not.toBe(true);
      expect((await client.callTool({ name: "workspace.upload_chunk", arguments: chunkArguments })).isError).not.toBe(true);
      const conflictBytes = new TextEncoder().encode("F0UR");
      const conflict = await client.callTool({
        name: "workspace.upload_chunk",
        arguments: { ...chunkArguments, content: Buffer.from(conflictBytes).toString("base64"), checksum: checksum(conflictBytes) },
      });
      expect(conflict.isError).toBe(true);
      expect(JSON.parse((conflict.content[0] as { text: string }).text)).toEqual(expect.objectContaining({ code: "UPLOAD_CHUNK_CONFLICT" }));
      await client.callTool({ name: "workspace.upload_complete", arguments: { workspaceId: "test", uploadId } });

      const revision = runtime.scopeMap.getActiveRevision("test").revision;
      const invalid = await client.callTool({
        name: "workspace.batch_apply",
        arguments: {
          workspaceId: "test",
          idempotencyKey: "mcp-invalid-batch-1",
          expectedMapRevision: revision,
          operations: [
            { operation: "create", path: "batch/never-created.md", uploadId, ifNoneMatch: "*" },
            { operation: "delete", path: "batch/delete.md", ifMatch: `sha256:${"0".repeat(64)}` },
          ],
        },
      });
      expect(invalid.isError).toBe(true);
      expect(JSON.parse((invalid.content[0] as { text: string }).text)).toEqual(expect.objectContaining({ code: "FILE_CHECKSUM_MISMATCH" }));
      await expect(runtime.files.read("test", "batch/never-created.md")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
      expect(new TextDecoder().decode((await runtime.files.read("test", "batch/delete.md")).content)).toBe("delete-me");
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });
});
