import { afterEach, describe, expect, test } from "bun:test";
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

describe("REST upload and atomic batch apply", () => {
  test("accepts raw chunks and applies completed upload bytes atomically", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-rest-upload-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "abcm-rest-upload-state-"));
    roots.push(root, stateRoot);
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await mkdir(join(root, "domain-language"));
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    const runtime = createAbcmRuntime({ id: "test", root }, { fileOperations: { stateRoot, maxChunkBytes: 4 } });
    await runtime.ready;
    await runtime.scopeMap.scan("test");

    try {
      const content = new TextEncoder().encode("raw-bytes");
      const startedResponse = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ size: content.byteLength, checksum: checksum(content), contentType: "text/plain; charset=utf-8" }),
      }));
      expect(startedResponse.status).toBe(201);
      const started = await startedResponse.json() as { uploadId: string; chunkSize: number };
      expect(started.chunkSize).toBe(4);

      for (let offset = 0, index = 0; offset < content.byteLength; offset += 4, index += 1) {
        const chunk = content.slice(offset, offset + 4);
        const chunkResponse = await runtime.restHandler(new Request(`http://localhost/v1/workspaces/test/uploads/${started.uploadId}/chunks/${index}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream", "x-content-sha256": checksum(chunk) },
          body: chunk,
        }));
        expect(chunkResponse.status).toBe(200);
        expect(await chunkResponse.json()).toEqual(expect.objectContaining({ uploadId: started.uploadId, index, accepted: true }));
      }

      const completed = await runtime.restHandler(new Request(`http://localhost/v1/workspaces/test/uploads/${started.uploadId}/complete`, { method: "POST" }));
      expect(completed.status).toBe(200);
      expect(await completed.json()).toEqual(expect.objectContaining({ status: "completed", checksum: checksum(content) }));

      const revision = runtime.scopeMap.getActiveRevision("test").revision;
      const batchBody = {
        idempotencyKey: "rest-upload-batch-1",
        expectedMapRevision: revision,
        operations: [{ operation: "create", path: "rest/raw.txt", uploadId: started.uploadId, ifNoneMatch: "*" }],
      };
      const applied = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/files/batch:apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batchBody),
      }));
      expect(applied.status).toBe(200);
      expect(await applied.json()).toEqual(expect.objectContaining({ status: "applied", replayed: false }));
      expect(new TextDecoder().decode((await runtime.files.read("test", "rest/raw.txt")).content)).toBe("raw-bytes");

      const replayed = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/files/batch:apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batchBody),
      }));
      expect(await replayed.json()).toEqual(expect.objectContaining({ status: "applied", replayed: true }));
    } finally {
      await runtime.close();
    }
  });

  test("validates checksum headers and duplicate touched paths before mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-rest-upload-invalid-"));
    const stateRoot = await mkdtemp(join(tmpdir(), "abcm-rest-upload-invalid-state-"));
    roots.push(root, stateRoot);
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await mkdir(join(root, "domain-language"));
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    const runtime = createAbcmRuntime({ id: "test", root }, { fileOperations: { stateRoot } });
    await runtime.ready;
    await runtime.scopeMap.scan("test");
    try {
      const emptyChecksum = checksum(new Uint8Array());
      const started = await (await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ size: 0, checksum: emptyChecksum }),
      }))).json() as { uploadId: string };
      const missingHeader = await runtime.restHandler(new Request(`http://localhost/v1/workspaces/test/uploads/${started.uploadId}/chunks/0`, { method: "PUT", body: "x" }));
      expect(missingHeader.status).toBe(400);
      expect((await missingHeader.json() as { code: string }).code).toBe("REQUEST_INVALID");

      await runtime.restHandler(new Request(`http://localhost/v1/workspaces/test/uploads/${started.uploadId}/complete`, { method: "POST" }));
      const duplicate = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/files/batch:apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "rest-duplicate-paths",
          expectedMapRevision: runtime.scopeMap.getActiveRevision("test").revision,
          operations: [
            { operation: "create", path: "same.md", uploadId: started.uploadId, ifNoneMatch: "*" },
            { operation: "delete", path: "same.md", ifMatch: emptyChecksum },
          ],
        }),
      }));
      expect(duplicate.status).toBe(400);
      expect((await duplicate.json() as { code: string }).code).toBe("REQUEST_INVALID");
      await expect(runtime.files.read("test", "same.md")).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    } finally {
      await runtime.close();
    }
  });
});
