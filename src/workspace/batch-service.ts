import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { AbcmError } from "../core/errors.js";
import { throwIfAborted } from "../core/operation.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { FileMutationOperation, MutationAuthorizer } from "./types.js";
import type { WorkspaceRegistry } from "./registry.js";
import { SafeWorkspacePath } from "./safe-path.js";
import type { WorkspaceUploadService, CompletedWorkspaceUpload } from "./upload-service.js";
import type {
  WorkspaceBatchApplyInput,
  WorkspaceBatchApplyOutput,
  WorkspaceBatchOperation,
} from "./file-operation-contracts.js";
import { WorkspaceMutationCoordinator } from "./mutation-coordinator.js";

interface PreparedOperation {
  index: number;
  operation: WorkspaceBatchOperation;
  sourcePath?: string;
  targetPath: string;
  sourceAbsolutePath?: string;
  targetAbsolutePath: string;
  checksum: string;
  upload?: CompletedWorkspaceUpload;
}

interface JournalOperation {
  index: number;
  operation: "create" | "update" | "delete" | "move";
  sourcePath?: string;
  targetPath: string;
  checksum: string;
}

interface BatchJournal {
  version: 1;
  batchId: string;
  workspaceId: string;
  idempotencyKey: string;
  requestDigest: string;
  transactionRoot: string;
  phase: "prepared" | "committing" | "canonical_committed" | "applied";
  operations: JournalOperation[];
  createdDirectories: string[];
}

interface StoredReceipt {
  version: 1;
  requestDigest: string;
  output: WorkspaceBatchApplyOutput;
}

export interface WorkspaceBatchServiceOptions {
  stateRoot: string;
  mutationCoordinator: WorkspaceMutationCoordinator;
  authorizeMutation?: MutationAuthorizer;
  maxBatchBytes?: number;
  onCommitted?: (workspaceId: string, changedPaths: readonly string[]) => Promise<void>;
}

const DEFAULT_MAX_BATCH_BYTES = 268_435_456;

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return `sha256:${hash.digest("hex")}`;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function requestDigest(input: WorkspaceBatchApplyInput): string {
  return sha256Text(JSON.stringify(input));
}

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

export class WorkspaceBatchService {
  readonly #registry: WorkspaceRegistry;
  readonly #uploads: WorkspaceUploadService;
  readonly #scopeMap: ScopeMapService;
  readonly #stateRoot: string;
  readonly #coordinator: WorkspaceMutationCoordinator;
  readonly #authorizeMutation: MutationAuthorizer | undefined;
  readonly #maxBatchBytes: number;
  readonly #onCommitted: ((workspaceId: string, changedPaths: readonly string[]) => Promise<void>) | undefined;
  readonly ready: Promise<void>;

  constructor(
    registry: WorkspaceRegistry,
    uploads: WorkspaceUploadService,
    scopeMap: ScopeMapService,
    options: WorkspaceBatchServiceOptions,
  ) {
    this.#registry = registry;
    this.#uploads = uploads;
    this.#scopeMap = scopeMap;
    this.#stateRoot = resolve(options.stateRoot);
    this.#coordinator = options.mutationCoordinator;
    this.#authorizeMutation = options.authorizeMutation;
    this.#maxBatchBytes = positiveInteger("maxBatchBytes", options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES, 1_073_741_824);
    this.#onCommitted = options.onCommitted;
    for (const workspace of registry.list()) {
      if (isWithin(workspace.root, this.#stateRoot)) {
        throw new Error("Workspace batch state root must be outside every canonical workspace root.");
      }
    }
    this.ready = this.#recoverAll();
  }

  async apply(input: WorkspaceBatchApplyInput, signal?: AbortSignal): Promise<WorkspaceBatchApplyOutput> {
    await this.ready;
    throwIfAborted(signal);
    this.#registry.get(input.workspaceId);
    return this.#coordinator.run(input.workspaceId, () => this.#applyLocked(input, signal));
  }

  async #applyLocked(input: WorkspaceBatchApplyInput, signal?: AbortSignal): Promise<WorkspaceBatchApplyOutput> {
    throwIfAborted(signal);
    const digest = requestDigest(input);
    const stored = await this.#readReceipt(input.workspaceId, input.idempotencyKey);
    if (stored !== undefined) {
      if (stored.requestDigest !== digest) {
        throw new AbcmError("BATCH_IDEMPOTENCY_CONFLICT", "Batch idempotency key was already used with a different request.", {
          idempotencyKey: input.idempotencyKey,
        });
      }
      return { ...stored.output, replayed: true };
    }

    const currentRevision = this.#scopeMap.getActiveRevision(input.workspaceId).revision;
    if (currentRevision !== input.expectedMapRevision) {
      throw new AbcmError("BATCH_REVISION_MISMATCH", "Batch expected MapRevision does not match the active revision.", {
        expected: input.expectedMapRevision,
        actual: currentRevision,
      });
    }

    const prepared = await this.#prepare(input, signal);
    const batchId = `batch_${randomBytes(16).toString("hex")}`;
    const plannedResults = prepared.map(item => this.#result(item, "planned"));
    if (input.dryRun) {
      return {
        batchId,
        status: "validated",
        replayed: false,
        idempotencyKey: input.idempotencyKey,
        mapRevisionBefore: currentRevision,
        mapRevisionAfter: currentRevision,
        results: plannedResults,
        warnings: [],
      };
    }

    const workspace = this.#registry.get(input.workspaceId);
    const transactionRoot = resolve(workspace.root, ".abcm", "file-batches", batchId);
    const journal: BatchJournal = {
      version: 1,
      batchId,
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: digest,
      transactionRoot,
      phase: "prepared",
      operations: prepared.map(item => ({
        index: item.index,
        operation: item.operation.operation,
        ...(item.sourcePath === undefined ? {} : { sourcePath: item.sourcePath }),
        targetPath: item.targetPath,
        checksum: item.checksum,
      })),
      createdDirectories: [],
    };

    await mkdir(resolve(transactionRoot, "stage"), { recursive: true });
    await mkdir(resolve(transactionRoot, "backup"), { recursive: true });
    for (const item of prepared) {
      if (item.upload === undefined) continue;
      const stagePath = resolve(transactionRoot, "stage", String(item.index));
      await copyFile(item.upload.absolutePath, stagePath);
      if (await sha256File(stagePath) !== item.upload.checksum) {
        throw new AbcmError("UPLOAD_CHECKSUM_MISMATCH", "Staged upload bytes changed before batch commit.", { uploadId: item.upload.uploadId });
      }
    }
    await writeJsonAtomic(this.#journalPath(batchId), journal);

    let canonicalCommitted = false;
    let committedOutput: WorkspaceBatchApplyOutput | undefined;
    try {
      throwIfAborted(signal);
      journal.createdDirectories = await this.#missingParentDirectories(workspace.root, prepared);
      journal.phase = "committing";
      await writeJsonAtomic(this.#journalPath(batchId), journal);
      for (const directory of journal.createdDirectories) await mkdir(directory);
      for (const item of prepared) await this.#commitOperation(item, transactionRoot);
      canonicalCommitted = true;
      journal.phase = "canonical_committed";
      await writeJsonAtomic(this.#journalPath(batchId), journal);

      const published = await this.#scopeMap.scan(input.workspaceId);
      const output: WorkspaceBatchApplyOutput = {
        batchId,
        status: "applied",
        replayed: false,
        idempotencyKey: input.idempotencyKey,
        mapRevisionBefore: currentRevision,
        mapRevisionAfter: published.revision,
        results: prepared.map(item => this.#result(item, "applied")),
        warnings: [],
      };
      await writeJsonAtomic(this.#receiptPath(input.workspaceId, input.idempotencyKey), {
        version: 1,
        requestDigest: digest,
        output,
      } satisfies StoredReceipt);
      committedOutput = output;
      journal.phase = "applied";
      await writeJsonAtomic(this.#journalPath(batchId), journal);

      if (this.#onCommitted !== undefined) {
        try {
          await this.#onCommitted(input.workspaceId, this.#changedPaths(prepared));
        } catch {
          output.warnings.push("POST_COMMIT_NOTIFICATION_FAILED");
          await writeJsonAtomic(this.#receiptPath(input.workspaceId, input.idempotencyKey), {
            version: 1,
            requestDigest: digest,
            output,
          } satisfies StoredReceipt);
        }
      }
      await this.#cleanup(journal);
      return output;
    } catch (error) {
      if (committedOutput !== undefined) {
        committedOutput.warnings.push("POST_COMMIT_FINALIZATION_FAILED");
        await writeJsonAtomic(this.#receiptPath(input.workspaceId, input.idempotencyKey), {
          version: 1,
          requestDigest: digest,
          output: committedOutput,
        } satisfies StoredReceipt).catch(() => undefined);
        return committedOutput;
      }
      if (canonicalCommitted || journal.phase === "committing") {
        await this.#rollback(journal);
        await this.#scopeMap.scan(input.workspaceId).catch(() => undefined);
      }
      await this.#cleanup(journal);
      throw error;
    }
  }

  async #prepare(input: WorkspaceBatchApplyInput, signal?: AbortSignal): Promise<PreparedOperation[]> {
    const workspace = this.#registry.get(input.workspaceId);
    const safePath = await SafeWorkspacePath.create(workspace.root, workspace.deniedDirectories);
    const prepared: PreparedOperation[] = [];
    let uploadBytes = 0;
    for (const [index, operation] of input.operations.entries()) {
      throwIfAborted(signal);
      if (operation.operation === "create") {
        await this.#authorize(input.workspaceId, [operation.path], "write");
        const target = await safePath.resolve(operation.path, { allowMissing: true });
        if (await this.#fileChecksum(target.absolutePath) !== undefined) throw new AbcmError("FILE_ALREADY_EXISTS", "File already exists.", { path: operation.path });
        const upload = await this.#uploads.resolveCompleted(input.workspaceId, operation.uploadId);
        uploadBytes += upload.size;
        prepared.push({ index, operation, targetPath: target.relativePath, targetAbsolutePath: target.absolutePath, checksum: upload.checksum, upload });
      } else if (operation.operation === "update") {
        await this.#authorize(input.workspaceId, [operation.path], "write");
        const target = await safePath.resolve(operation.path);
        const checksum = await this.#requiredChecksum(target.absolutePath, operation.path);
        this.#validateChecksum(checksum, operation.ifMatch, operation.path);
        const upload = await this.#uploads.resolveCompleted(input.workspaceId, operation.uploadId);
        uploadBytes += upload.size;
        prepared.push({ index, operation, sourcePath: target.relativePath, targetPath: target.relativePath, sourceAbsolutePath: target.absolutePath, targetAbsolutePath: target.absolutePath, checksum: upload.checksum, upload });
      } else if (operation.operation === "delete") {
        await this.#authorize(input.workspaceId, [operation.path], "delete");
        const target = await safePath.resolve(operation.path);
        const checksum = await this.#requiredChecksum(target.absolutePath, operation.path);
        this.#validateChecksum(checksum, operation.ifMatch, operation.path);
        prepared.push({ index, operation, sourcePath: target.relativePath, targetPath: target.relativePath, sourceAbsolutePath: target.absolutePath, targetAbsolutePath: target.absolutePath, checksum });
      } else {
        await this.#authorize(input.workspaceId, [operation.from, operation.to], "move");
        const source = await safePath.resolve(operation.from);
        const target = await safePath.resolve(operation.to, { allowMissing: true });
        const checksum = await this.#requiredChecksum(source.absolutePath, operation.from);
        this.#validateChecksum(checksum, operation.ifMatch, operation.from);
        if (await this.#fileChecksum(target.absolutePath) !== undefined) throw new AbcmError("FILE_ALREADY_EXISTS", "Move target already exists.", { path: operation.to });
        prepared.push({ index, operation, sourcePath: source.relativePath, targetPath: target.relativePath, sourceAbsolutePath: source.absolutePath, targetAbsolutePath: target.absolutePath, checksum });
      }
      if (uploadBytes > this.#maxBatchBytes) {
        throw new AbcmError("BATCH_TOO_LARGE", "Batch upload bytes exceed the configured limit.", {
          uploadBytes,
          maxBatchBytes: this.#maxBatchBytes,
        });
      }
    }
    return prepared;
  }

  async #commitOperation(item: PreparedOperation, transactionRoot: string): Promise<void> {
    const backup = resolve(transactionRoot, "backup", String(item.index));
    const stage = resolve(transactionRoot, "stage", String(item.index));
    if (item.operation.operation === "create") {
      await rename(stage, item.targetAbsolutePath);
    } else if (item.operation.operation === "update") {
      await rename(item.targetAbsolutePath, backup);
      await rename(stage, item.targetAbsolutePath);
    } else if (item.operation.operation === "delete") {
      await rename(item.targetAbsolutePath, backup);
    } else {
      await rename(item.sourceAbsolutePath!, backup);
      await rename(backup, item.targetAbsolutePath);
    }
  }

  async #rollback(journal: BatchJournal): Promise<void> {
    const workspace = this.#registry.get(journal.workspaceId);
    for (const item of [...journal.operations].reverse()) {
      const target = resolve(workspace.root, ...item.targetPath.split("/"));
      const source = item.sourcePath === undefined ? undefined : resolve(workspace.root, ...item.sourcePath.split("/"));
      const backup = resolve(journal.transactionRoot, "backup", String(item.index));
      if (item.operation === "create") {
        await this.#removeIfChecksum(target, item.checksum);
      } else if (item.operation === "update") {
        const backupExists = await this.#exists(backup);
        if (backupExists) {
          await this.#removeIfChecksum(target, item.checksum);
          await rename(backup, target);
        } else {
          const actual = await this.#fileChecksum(target);
          if (actual === item.checksum) {
            throw new AbcmError("BATCH_RECOVERY_REQUIRED", "Updated batch target has no recoverable backup.", { path: item.targetPath });
          }
        }
      } else if (item.operation === "delete") {
        if (await this.#exists(backup)) await rename(backup, target);
      } else if (source !== undefined) {
        if (await this.#exists(target)) {
          if (await this.#requiredChecksum(target, item.targetPath) !== item.checksum) {
            throw new AbcmError("BATCH_RECOVERY_REQUIRED", "Move target changed during batch recovery.", { path: item.targetPath });
          }
          await rename(target, source);
        } else if (await this.#exists(backup)) {
          await rename(backup, source);
        }
      }
    }
    for (const directory of [...journal.createdDirectories].reverse()) await rmdir(directory).catch(() => undefined);
  }

  async #removeIfChecksum(path: string, checksum: string): Promise<void> {
    const actual = await this.#fileChecksum(path);
    if (actual === undefined) return;
    if (actual !== checksum) throw new AbcmError("BATCH_RECOVERY_REQUIRED", "Batch target changed during recovery.", { path, expected: checksum, actual });
    await unlink(path);
  }

  async #missingParentDirectories(workspaceRoot: string, prepared: readonly PreparedOperation[]): Promise<string[]> {
    const directories = new Set<string>();
    for (const item of prepared) {
      let current = dirname(item.targetAbsolutePath);
      while (current !== workspaceRoot && !await this.#exists(current)) {
        directories.add(current);
        current = dirname(current);
      }
    }
    return [...directories].sort((left, right) => left.split(sep).length - right.split(sep).length || left.localeCompare(right));
  }

  #result(item: PreparedOperation, status: "planned" | "applied") {
    return {
      index: item.index,
      operation: item.operation.operation,
      status,
      ...(item.operation.operation === "move"
        ? { from: item.operation.from, to: item.operation.to }
        : { path: item.operation.path }),
      checksum: item.checksum,
    };
  }

  #changedPaths(prepared: readonly PreparedOperation[]): string[] {
    return [...new Set(prepared.flatMap(item => item.sourcePath === undefined || item.sourcePath === item.targetPath
      ? [item.targetPath]
      : [item.sourcePath, item.targetPath]))].sort();
  }

  async #authorize(workspaceId: string, paths: readonly string[], operation: FileMutationOperation): Promise<void> {
    if (this.#authorizeMutation !== undefined) await this.#authorizeMutation(workspaceId, paths, operation);
  }

  #validateChecksum(actual: string, expected: string, path: string): void {
    if (actual !== expected) throw new AbcmError("FILE_CHECKSUM_MISMATCH", "File checksum precondition did not match.", { path, expected, actual });
  }

  async #requiredChecksum(path: string, relativePath: string): Promise<string> {
    const checksum = await this.#fileChecksum(path);
    if (checksum === undefined) throw new AbcmError("FILE_NOT_FOUND", "Workspace path does not exist.", { path: relativePath });
    return checksum;
  }

  async #fileChecksum(path: string): Promise<string | undefined> {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Only regular files can participate in a batch.", { path });
      return sha256File(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async #readReceipt(workspaceId: string, idempotencyKey: string): Promise<StoredReceipt | undefined> {
    try {
      return JSON.parse(await readFile(this.#receiptPath(workspaceId, idempotencyKey), "utf8")) as StoredReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AbcmError("BATCH_RECOVERY_REQUIRED", "Batch receipt is unreadable.", { idempotencyKey });
    }
  }

  #receiptPath(workspaceId: string, idempotencyKey: string): string {
    const workspaceHash = createHash("sha256").update(workspaceId).digest("hex");
    const keyHash = createHash("sha256").update(idempotencyKey).digest("hex");
    return resolve(this.#stateRoot, "receipts", workspaceHash, `${keyHash}.json`);
  }

  #journalPath(batchId: string): string {
    return resolve(this.#stateRoot, "transactions", `${batchId}.json`);
  }

  async #recoverAll(): Promise<void> {
    const directory = resolve(this.#stateRoot, "transactions");
    await mkdir(directory, { recursive: true });
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !/^batch_[a-f0-9]{32}\.json$/.test(entry.name)) continue;
      const journalPath = resolve(directory, entry.name);
      await this.#coordinator.run("__batch_recovery__", async () => {
        let journal: BatchJournal;
        try {
          journal = JSON.parse(await readFile(journalPath, "utf8")) as BatchJournal;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw new AbcmError("BATCH_RECOVERY_REQUIRED", "Batch recovery journal is unreadable.", { path: journalPath });
        }
        const receipt = await this.#readReceipt(journal.workspaceId, journal.idempotencyKey);
        if (receipt !== undefined && receipt.requestDigest !== journal.requestDigest) {
          throw new AbcmError("BATCH_RECOVERY_REQUIRED", "Batch receipt does not match its recovery journal.", { batchId: journal.batchId });
        }
        if (receipt === undefined && journal.phase !== "prepared") {
          await this.#rollback(journal);
          await this.#scopeMap.scan(journal.workspaceId);
        }
        await this.#cleanup(journal);
      });
    }
  }

  async #cleanup(journal: BatchJournal): Promise<void> {
    await rm(journal.transactionRoot, { recursive: true, force: true });
    await unlink(this.#journalPath(journal.batchId)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}
