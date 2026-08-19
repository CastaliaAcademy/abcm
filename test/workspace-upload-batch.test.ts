import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceBatchService } from "../src/workspace/batch-service.js";
import type { WorkspaceBatchApplyInput } from "../src/workspace/file-operation-contracts.js";
import { WorkspaceMutationCoordinator } from "../src/workspace/mutation-coordinator.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { WorkspaceUploadService } from "../src/workspace/upload-service.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function checksum(content: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-batch-workspace-"));
  const stateRoot = await mkdtemp(join(tmpdir(), "abcm-batch-state-"));
  roots.push(root, stateRoot);
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const registry = new WorkspaceRegistry([{ id: "test", root, maxWriteBytes: 1024 }]);
  const scopeMap = new ScopeMapService(registry);
  await scopeMap.scan("test");
  const coordinator = new WorkspaceMutationCoordinator();
  const uploads = new WorkspaceUploadService(registry, { stateRoot, maxChunkBytes: 4, maxUploadBytes: 1024 });
  const batch = new WorkspaceBatchService(registry, uploads, scopeMap, {
    stateRoot,
    mutationCoordinator: coordinator,
    maxBatchBytes: 2048,
  });
  await batch.ready;
  return { root, stateRoot, registry, scopeMap, uploads, batch };
}

async function upload(uploads: WorkspaceUploadService, content: string) {
  const bytes = new TextEncoder().encode(content);
  const started = await uploads.start({ workspaceId: "test", size: bytes.byteLength, checksum: checksum(bytes), contentType: "text/plain" });
  for (let index = 0, offset = 0; offset < bytes.byteLength; index += 1, offset += started.chunkSize) {
    const chunk = bytes.slice(offset, offset + started.chunkSize);
    await uploads.append({ workspaceId: "test", uploadId: started.uploadId, index, content: "", encoding: "base64", checksum: checksum(chunk) }, chunk);
  }
  return uploads.complete("test", started.uploadId);
}

describe("workspace upload and atomic batch services", () => {
  test("persists sequential checksum-bound chunks and accepts identical retries", async () => {
    const { uploads } = await fixture();
    const content = new TextEncoder().encode("abcdef");
    const started = await uploads.start({ workspaceId: "test", size: content.byteLength, checksum: checksum(content) });
    const first = content.slice(0, 4);
    const accepted = await uploads.append({ workspaceId: "test", uploadId: started.uploadId, index: 0, content: "", encoding: "base64", checksum: checksum(first) }, first);
    expect(accepted).toEqual({ uploadId: started.uploadId, index: 0, accepted: true, receivedBytes: 4, nextIndex: 1 });
    await expect(uploads.append({ workspaceId: "test", uploadId: started.uploadId, index: 2, content: "", encoding: "base64", checksum: checksum(content.slice(4)) }, content.slice(4))).rejects.toMatchObject({ code: "UPLOAD_CHUNK_CONFLICT" });
    await expect(uploads.append({ workspaceId: "test", uploadId: started.uploadId, index: 0, content: "", encoding: "base64", checksum: checksum(new TextEncoder().encode("xxxx")) }, new TextEncoder().encode("xxxx"))).rejects.toMatchObject({ code: "UPLOAD_CHUNK_CONFLICT" });
    expect(await uploads.append({ workspaceId: "test", uploadId: started.uploadId, index: 0, content: "", encoding: "base64", checksum: checksum(first) }, first)).toEqual(accepted);
    const second = content.slice(4);
    await uploads.append({ workspaceId: "test", uploadId: started.uploadId, index: 1, content: "", encoding: "base64", checksum: checksum(second) }, second);
    expect(await uploads.complete("test", started.uploadId)).toEqual(expect.objectContaining({ status: "completed", checksum: checksum(content), size: 6 }));
  });

  test("reclaims expired and orphaned upload sessions during startup recovery", async () => {
    const { stateRoot, registry } = await fixture();
    let now = new Date("2026-08-18T00:00:00.000Z");
    const initial = new WorkspaceUploadService(registry, { stateRoot, uploadTtlMs: 1_000, now: () => now });
    const started = await initial.start({ workspaceId: "test", size: 3, checksum: checksum("abc") });
    const workspaceHash = createHash("sha256").update("test").digest("hex");
    const uploadDirectory = join(stateRoot, "uploads", workspaceHash, started.uploadId);
    const orphanDirectory = join(stateRoot, "uploads", workspaceHash, `upl_${"f".repeat(32)}`);
    await mkdir(orphanDirectory, { recursive: true });
    await writeFile(join(orphanDirectory, "content.bin"), "orphan");

    now = new Date("2026-08-18T00:00:02.000Z");
    const recovered = new WorkspaceUploadService(registry, { stateRoot, uploadTtlMs: 1_000, now: () => now });
    await recovered.ready;

    expect(await Bun.file(join(uploadDirectory, "manifest.json")).exists()).toBe(false);
    expect(await Bun.file(join(orphanDirectory, "content.bin")).exists()).toBe(false);
    await expect(recovered.resolveCompleted("test", started.uploadId)).rejects.toMatchObject({ code: "UPLOAD_NOT_FOUND" });
  });

  test("dry-runs and atomically applies a mixed batch with one revision and idempotent receipt", async () => {
    const { root, scopeMap, uploads, batch } = await fixture();
    await writeFile(join(root, "update.md"), "old-update");
    await writeFile(join(root, "delete.md"), "old-delete");
    await writeFile(join(root, "move.md"), "old-move");
    const before = await scopeMap.scan("test");
    const createdUpload = await upload(uploads, "new-create");
    const updatedUpload = await upload(uploads, "new-update");
    const input: WorkspaceBatchApplyInput = {
      workspaceId: "test",
      idempotencyKey: "mixed-batch-001",
      expectedMapRevision: before.revision,
      dryRun: false,
      operations: [
        { operation: "create", path: "nested/create.md", uploadId: createdUpload.uploadId, ifNoneMatch: "*" },
        { operation: "update", path: "update.md", uploadId: updatedUpload.uploadId, ifMatch: checksum("old-update") },
        { operation: "delete", path: "delete.md", ifMatch: checksum("old-delete") },
        { operation: "move", from: "move.md", to: "nested/moved.md", ifMatch: checksum("old-move"), overwrite: false },
      ],
    };
    const preview = await batch.apply({ ...input, idempotencyKey: "mixed-preview-001", dryRun: true });
    expect(preview).toEqual(expect.objectContaining({ status: "validated", mapRevisionBefore: before.revision, mapRevisionAfter: before.revision }));
    expect(await Bun.file(join(root, "update.md")).text()).toBe("old-update");
    expect(await Bun.file(join(root, "nested/create.md")).exists()).toBe(false);

    const applied = await batch.apply(input);
    expect(applied).toEqual(expect.objectContaining({ status: "applied", replayed: false, mapRevisionBefore: before.revision }));
    expect(applied.mapRevisionAfter).toBe(scopeMap.getActiveRevision("test").revision);
    expect(applied.results.map(result => result.status)).toEqual(["applied", "applied", "applied", "applied"]);
    expect(await Bun.file(join(root, "nested/create.md")).text()).toBe("new-create");
    expect(await Bun.file(join(root, "update.md")).text()).toBe("new-update");
    expect(await Bun.file(join(root, "delete.md")).exists()).toBe(false);
    expect(await Bun.file(join(root, "move.md")).exists()).toBe(false);
    expect(await Bun.file(join(root, "nested/moved.md")).text()).toBe("old-move");

    const replay = await batch.apply(input);
    expect(replay).toEqual({ ...applied, replayed: true });
    await expect(batch.apply({ ...input, dryRun: true })).rejects.toMatchObject({ code: "BATCH_IDEMPOTENCY_CONFLICT" });
  });

  test("rejects stale preconditions without applying any operation", async () => {
    const { root, scopeMap, uploads, batch } = await fixture();
    await writeFile(join(root, "existing.md"), "current");
    const before = await scopeMap.scan("test");
    const createdUpload = await upload(uploads, "create");
    const updatedUpload = await upload(uploads, "update");
    await expect(batch.apply({
      workspaceId: "test",
      idempotencyKey: "stale-batch-001",
      expectedMapRevision: before.revision,
      dryRun: false,
      operations: [
        { operation: "create", path: "must-not-exist.md", uploadId: createdUpload.uploadId, ifNoneMatch: "*" },
        { operation: "update", path: "existing.md", uploadId: updatedUpload.uploadId, ifMatch: checksum("stale") },
      ],
    })).rejects.toMatchObject({ code: "FILE_CHECKSUM_MISMATCH" });
    expect(await Bun.file(join(root, "must-not-exist.md")).exists()).toBe(false);
    expect(await Bun.file(join(root, "existing.md")).text()).toBe("current");
  });

  test("rolls canonical bytes back when ScopeMap publication rejects the staged state", async () => {
    const { root, scopeMap, uploads, batch } = await fixture();
    const original = await readFile(join(root, "scope.yaml"), "utf8");
    const before = scopeMap.getActiveRevision("test");
    const invalidUpload = await upload(uploads, "apiVersion: abcm/v1\nkind: project\nid: invalid-root\nname: Invalid\n");
    await expect(batch.apply({
      workspaceId: "test",
      idempotencyKey: "invalid-map-001",
      expectedMapRevision: before.revision,
      dryRun: false,
      operations: [{ operation: "update", path: "scope.yaml", uploadId: invalidUpload.uploadId, ifMatch: checksum(original) }],
    })).rejects.toMatchObject({ code: "WORKSPACE_ROOT_MUST_BE_WORKFLOW" });
    expect(await readFile(join(root, "scope.yaml"), "utf8")).toBe(original);
    expect(scopeMap.getActiveRevision("test").nodes[0]?.scopeId).toBe("test");
  });

  test("recovers prepared and partially committing journals without touching unstarted updates", async () => {
    const { root, stateRoot, registry, scopeMap, uploads } = await fixture();
    await writeFile(join(root, "prepared-original.md"), "prepared-original");
    await writeFile(join(root, "untouched-update.md"), "untouched-original");
    await writeFile(join(root, "crash-created.md"), "crash-created");
    const transactions = join(stateRoot, "transactions");
    await mkdir(transactions, { recursive: true });

    const preparedBatchId = `batch_${"1".repeat(32)}`;
    const preparedTransactionRoot = join(root, ".abcm", "file-batches", preparedBatchId);
    await mkdir(join(preparedTransactionRoot, "backup"), { recursive: true });
    await mkdir(join(preparedTransactionRoot, "stage"), { recursive: true });
    await writeFile(join(transactions, `${preparedBatchId}.json`), JSON.stringify({
      version: 1,
      batchId: preparedBatchId,
      workspaceId: "test",
      idempotencyKey: "prepared-recovery-1",
      requestDigest: checksum("prepared-request"),
      transactionRoot: preparedTransactionRoot,
      phase: "prepared",
      operations: [{
        index: 0,
        operation: "update",
        sourcePath: "prepared-original.md",
        targetPath: "prepared-original.md",
        checksum: checksum("prepared-replacement"),
      }],
      createdDirectories: [],
    }));

    const committingBatchId = `batch_${"2".repeat(32)}`;
    const committingTransactionRoot = join(root, ".abcm", "file-batches", committingBatchId);
    await mkdir(join(committingTransactionRoot, "backup"), { recursive: true });
    await mkdir(join(committingTransactionRoot, "stage"), { recursive: true });
    await writeFile(join(transactions, `${committingBatchId}.json`), JSON.stringify({
      version: 1,
      batchId: committingBatchId,
      workspaceId: "test",
      idempotencyKey: "committing-recovery-1",
      requestDigest: checksum("committing-request"),
      transactionRoot: committingTransactionRoot,
      phase: "committing",
      operations: [
        {
          index: 0,
          operation: "create",
          targetPath: "crash-created.md",
          checksum: checksum("crash-created"),
        },
        {
          index: 1,
          operation: "update",
          sourcePath: "untouched-update.md",
          targetPath: "untouched-update.md",
          checksum: checksum("replacement-never-committed"),
        },
      ],
      createdDirectories: [],
    }));

    const receiptBatchId = `batch_${"3".repeat(32)}`;
    const receiptIdempotencyKey = "receipt-recovery-1";
    const receiptRequestDigest = checksum("receipt-request");
    const receiptTransactionRoot = join(root, ".abcm", "file-batches", receiptBatchId);
    await mkdir(join(receiptTransactionRoot, "backup"), { recursive: true });
    await mkdir(join(receiptTransactionRoot, "stage"), { recursive: true });
    await writeFile(join(root, "receipt-committed.md"), "committed-new");
    await writeFile(join(receiptTransactionRoot, "backup", "0"), "committed-old");
    await writeFile(join(transactions, `${receiptBatchId}.json`), JSON.stringify({
      version: 1,
      batchId: receiptBatchId,
      workspaceId: "test",
      idempotencyKey: receiptIdempotencyKey,
      requestDigest: receiptRequestDigest,
      transactionRoot: receiptTransactionRoot,
      phase: "canonical_committed",
      operations: [{
        index: 0,
        operation: "update",
        sourcePath: "receipt-committed.md",
        targetPath: "receipt-committed.md",
        checksum: checksum("committed-new"),
      }],
      createdDirectories: [],
    }));
    const workspaceHash = createHash("sha256").update("test").digest("hex");
    const keyHash = createHash("sha256").update(receiptIdempotencyKey).digest("hex");
    const receiptDirectory = join(stateRoot, "receipts", workspaceHash);
    await mkdir(receiptDirectory, { recursive: true });
    await writeFile(join(receiptDirectory, `${keyHash}.json`), JSON.stringify({
      version: 1,
      requestDigest: receiptRequestDigest,
      output: {
        batchId: receiptBatchId,
        status: "applied",
        replayed: false,
        idempotencyKey: receiptIdempotencyKey,
        mapRevisionBefore: scopeMap.getActiveRevision("test").revision,
        mapRevisionAfter: scopeMap.getActiveRevision("test").revision,
        results: [{
          index: 0,
          operation: "update",
          status: "applied",
          path: "receipt-committed.md",
          checksum: checksum("committed-new"),
        }],
        warnings: [],
      },
    }));

    const recovered = new WorkspaceBatchService(registry, uploads, scopeMap, {
      stateRoot,
      mutationCoordinator: new WorkspaceMutationCoordinator(),
    });
    await recovered.ready;

    expect(await Bun.file(join(root, "prepared-original.md")).text()).toBe("prepared-original");
    expect(await Bun.file(join(root, "untouched-update.md")).text()).toBe("untouched-original");
    expect(await Bun.file(join(root, "crash-created.md")).exists()).toBe(false);
    expect(await Bun.file(join(transactions, `${preparedBatchId}.json`)).exists()).toBe(false);
    expect(await Bun.file(join(transactions, `${committingBatchId}.json`)).exists()).toBe(false);
    expect(await Bun.file(preparedTransactionRoot).exists()).toBe(false);
    expect(await Bun.file(committingTransactionRoot).exists()).toBe(false);
    expect(await Bun.file(join(root, "receipt-committed.md")).text()).toBe("committed-new");
    expect(await Bun.file(join(transactions, `${receiptBatchId}.json`)).exists()).toBe(false);
    expect(await Bun.file(receiptTransactionRoot).exists()).toBe(false);
  });
});
