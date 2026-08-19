import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, truncate } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { AbcmError } from "../core/errors.js";
import { throwIfAborted } from "../core/operation.js";
import type { WorkspaceRegistry } from "./registry.js";
import type { WorkspaceUploadChunkInput, WorkspaceUploadStartInput } from "./file-operation-contracts.js";

interface UploadChunkRecord {
  index: number;
  offset: number;
  size: number;
  checksum: string;
}

interface UploadManifest {
  version: 1;
  uploadId: string;
  workspaceId: string;
  size: number;
  checksum: string;
  contentType?: string;
  chunkSize: number;
  receivedBytes: number;
  nextIndex: number;
  chunks: UploadChunkRecord[];
  createdAt: string;
  expiresAt: string;
  status: "uploading" | "completed";
}

export interface WorkspaceUploadServiceOptions {
  stateRoot: string;
  maxUploadBytes?: number;
  maxChunkBytes?: number;
  uploadTtlMs?: number;
  now?: () => Date;
}

export interface CompletedWorkspaceUpload {
  uploadId: string;
  workspaceId: string;
  size: number;
  checksum: string;
  contentType?: string;
  expiresAt: string;
  absolutePath: string;
}

const DEFAULT_MAX_UPLOAD_BYTES = 67_108_864;
const DEFAULT_MAX_CHUNK_BYTES = 1_048_576;
const DEFAULT_UPLOAD_TTL_MS = 86_400_000;

function sha256Bytes(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
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

function positiveInteger(name: string, value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return value;
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export class WorkspaceUploadService {
  readonly ready: Promise<void>;
  readonly #registry: WorkspaceRegistry;
  readonly #stateRoot: string;
  readonly #maxUploadBytes: number;
  readonly #maxChunkBytes: number;
  readonly #uploadTtlMs: number;
  readonly #now: () => Date;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(registry: WorkspaceRegistry, options: WorkspaceUploadServiceOptions) {
    this.#registry = registry;
    this.#stateRoot = resolve(options.stateRoot);
    this.#maxUploadBytes = positiveInteger("maxUploadBytes", options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES, 1_073_741_824);
    this.#maxChunkBytes = positiveInteger("maxChunkBytes", options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES, 16_777_216);
    if (this.#maxChunkBytes > this.#maxUploadBytes) throw new Error("maxChunkBytes must not exceed maxUploadBytes.");
    this.#uploadTtlMs = positiveInteger("uploadTtlMs", options.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS, 604_800_000);
    this.#now = options.now ?? (() => new Date());
    for (const workspace of registry.list()) {
      if (isWithin(workspace.root, this.#stateRoot)) {
        throw new Error("Workspace upload state root must be outside every canonical workspace root.");
      }
    }
    this.ready = this.#cleanupExpiredUploads();
  }

  get maxChunkBytes(): number {
    return this.#maxChunkBytes;
  }

  async start(input: WorkspaceUploadStartInput, signal?: AbortSignal) {
    await this.ready;
    throwIfAborted(signal);
    this.#registry.get(input.workspaceId);
    if (input.size > this.#maxUploadBytes) {
      throw new AbcmError("UPLOAD_TOO_LARGE", "Upload exceeds the configured size limit.", {
        size: input.size,
        maxUploadBytes: this.#maxUploadBytes,
      });
    }
    const uploadId = `upl_${randomBytes(16).toString("hex")}`;
    const createdAt = this.#now();
    const manifest: UploadManifest = {
      version: 1,
      uploadId,
      workspaceId: input.workspaceId,
      size: input.size,
      checksum: input.checksum,
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      chunkSize: this.#maxChunkBytes,
      receivedBytes: 0,
      nextIndex: 0,
      chunks: [],
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.#uploadTtlMs).toISOString(),
      status: "uploading",
    };
    const directory = this.#uploadDirectory(input.workspaceId, uploadId);
    await mkdir(directory, { recursive: true });
    const content = await open(resolve(directory, "content.bin"), "wx", 0o600);
    await content.close();
    await writeJsonAtomic(resolve(directory, "manifest.json"), manifest);
    return {
      uploadId,
      workspaceId: input.workspaceId,
      size: input.size,
      checksum: input.checksum,
      chunkSize: this.#maxChunkBytes,
      expiresAt: manifest.expiresAt,
    };
  }

  append(input: WorkspaceUploadChunkInput, content: Uint8Array, signal?: AbortSignal) {
    return this.#serialize(input.uploadId, async () => {
      await this.ready;
      throwIfAborted(signal);
      if (content.byteLength > this.#maxChunkBytes) {
        throw new AbcmError("UPLOAD_CHUNK_INVALID", "Upload chunk exceeds the configured size limit.", {
          size: content.byteLength,
          maxChunkBytes: this.#maxChunkBytes,
        });
      }
      const actualChecksum = sha256Bytes(content);
      if (actualChecksum !== input.checksum) {
        throw new AbcmError("UPLOAD_CHECKSUM_MISMATCH", "Upload chunk checksum did not match decoded bytes.", {
          expected: input.checksum,
          actual: actualChecksum,
        });
      }
      const manifest = await this.#load(input.workspaceId, input.uploadId);
      if (manifest.status !== "uploading") throw new AbcmError("UPLOAD_STATE_INVALID", "Completed uploads are immutable.");
      const previous = manifest.chunks[input.index];
      if (previous !== undefined) {
        if (previous.checksum !== input.checksum || previous.size !== content.byteLength) {
          throw new AbcmError("UPLOAD_CHUNK_CONFLICT", "Upload chunk index was already used with different bytes.", { index: input.index });
        }
        return { uploadId: input.uploadId, index: input.index, accepted: true as const, receivedBytes: manifest.receivedBytes, nextIndex: manifest.nextIndex };
      }
      if (input.index !== manifest.nextIndex) {
        throw new AbcmError("UPLOAD_CHUNK_CONFLICT", "Upload chunks must be sent in strict sequential order.", {
          expectedIndex: manifest.nextIndex,
          actualIndex: input.index,
        });
      }
      if (manifest.receivedBytes + content.byteLength > manifest.size) {
        throw new AbcmError("UPLOAD_CHUNK_INVALID", "Upload chunk exceeds the declared upload size.", {
          declaredSize: manifest.size,
          receivedBytes: manifest.receivedBytes,
          chunkBytes: content.byteLength,
        });
      }
      const contentPath = this.#contentPath(input.workspaceId, input.uploadId);
      const metadata = await stat(contentPath);
      if (metadata.size < manifest.receivedBytes) throw new AbcmError("UPLOAD_STATE_INVALID", "Upload content is shorter than its durable manifest.");
      if (metadata.size > manifest.receivedBytes) await truncate(contentPath, manifest.receivedBytes);
      const handle = await open(contentPath, "a", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      manifest.chunks.push({ index: input.index, offset: manifest.receivedBytes, size: content.byteLength, checksum: input.checksum });
      manifest.receivedBytes += content.byteLength;
      manifest.nextIndex += 1;
      await writeJsonAtomic(this.#manifestPath(input.workspaceId, input.uploadId), manifest);
      return { uploadId: input.uploadId, index: input.index, accepted: true as const, receivedBytes: manifest.receivedBytes, nextIndex: manifest.nextIndex };
    });
  }

  complete(workspaceId: string, uploadId: string, signal?: AbortSignal) {
    return this.#serialize(uploadId, async () => {
      await this.ready;
      throwIfAborted(signal);
      const manifest = await this.#load(workspaceId, uploadId);
      if (manifest.status === "completed") return this.#completed(manifest);
      if (manifest.receivedBytes !== manifest.size) {
        throw new AbcmError("UPLOAD_INCOMPLETE", "Upload has not received its declared number of bytes.", {
          expected: manifest.size,
          actual: manifest.receivedBytes,
        });
      }
      const actualChecksum = await sha256File(this.#contentPath(workspaceId, uploadId));
      throwIfAborted(signal);
      if (actualChecksum !== manifest.checksum) {
        throw new AbcmError("UPLOAD_CHECKSUM_MISMATCH", "Completed upload checksum did not match its declaration.", {
          expected: manifest.checksum,
          actual: actualChecksum,
        });
      }
      manifest.status = "completed";
      await writeJsonAtomic(this.#manifestPath(workspaceId, uploadId), manifest);
      return this.#completed(manifest);
    });
  }

  async resolveCompleted(workspaceId: string, uploadId: string): Promise<CompletedWorkspaceUpload> {
    await this.ready;
    const manifest = await this.#load(workspaceId, uploadId);
    if (manifest.status !== "completed") throw new AbcmError("UPLOAD_INCOMPLETE", "Upload must be completed before batch application.");
    return { ...this.#completed(manifest), absolutePath: this.#contentPath(workspaceId, uploadId) };
  }

  abort(workspaceId: string, uploadId: string, signal?: AbortSignal): Promise<void> {
    return this.#serialize(uploadId, async () => {
      await this.ready;
      throwIfAborted(signal);
      this.#assertUploadId(uploadId);
      this.#registry.get(workspaceId);
      await rm(this.#uploadDirectory(workspaceId, uploadId), { recursive: true, force: true });
    });
  }

  #completed(manifest: UploadManifest) {
    return {
      uploadId: manifest.uploadId,
      workspaceId: manifest.workspaceId,
      size: manifest.size,
      checksum: manifest.checksum,
      ...(manifest.contentType === undefined ? {} : { contentType: manifest.contentType }),
      expiresAt: manifest.expiresAt,
      status: "completed" as const,
    };
  }

  async #load(workspaceId: string, uploadId: string): Promise<UploadManifest> {
    this.#registry.get(workspaceId);
    this.#assertUploadId(uploadId);
    let manifest: UploadManifest;
    try {
      manifest = JSON.parse(await readFile(this.#manifestPath(workspaceId, uploadId), "utf8")) as UploadManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AbcmError("UPLOAD_NOT_FOUND", "Upload session was not found.", { uploadId });
      throw new AbcmError("UPLOAD_STATE_INVALID", "Upload manifest is unreadable.", { uploadId });
    }
    if (manifest.version !== 1 || manifest.uploadId !== uploadId || manifest.workspaceId !== workspaceId) {
      throw new AbcmError("UPLOAD_STATE_INVALID", "Upload manifest identity is invalid.", { uploadId });
    }
    if (this.#now().getTime() >= Date.parse(manifest.expiresAt)) {
      await rm(this.#uploadDirectory(workspaceId, uploadId), { recursive: true, force: true });
      throw new AbcmError("UPLOAD_EXPIRED", "Upload session has expired.", { uploadId });
    }
    return manifest;
  }

  async #cleanupExpiredUploads(): Promise<void> {
    const uploadsRoot = resolve(this.#stateRoot, "uploads");
    await mkdir(uploadsRoot, { recursive: true });
    for (const workspaceEntry of await readdir(uploadsRoot, { withFileTypes: true })) {
      if (!workspaceEntry.isDirectory() || !/^[a-f0-9]{64}$/.test(workspaceEntry.name)) continue;
      const workspaceDirectory = resolve(uploadsRoot, workspaceEntry.name);
      for (const uploadEntry of await readdir(workspaceDirectory, { withFileTypes: true })) {
        if (!uploadEntry.isDirectory() || !/^upl_[a-f0-9]{32}$/.test(uploadEntry.name)) continue;
        const uploadDirectory = resolve(workspaceDirectory, uploadEntry.name);
        let manifest: UploadManifest;
        try {
          manifest = JSON.parse(await readFile(resolve(uploadDirectory, "manifest.json"), "utf8")) as UploadManifest;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            await rm(uploadDirectory, { recursive: true, force: true });
            continue;
          }
          throw new AbcmError("UPLOAD_STATE_INVALID", "Upload manifest is unreadable during startup recovery.", {
            uploadId: uploadEntry.name,
          });
        }
        if (manifest.version !== 1 || manifest.uploadId !== uploadEntry.name || typeof manifest.workspaceId !== "string" || typeof manifest.expiresAt !== "string") {
          throw new AbcmError("UPLOAD_STATE_INVALID", "Upload manifest identity is invalid during startup recovery.", {
            uploadId: uploadEntry.name,
          });
        }
        const workspaceHash = createHash("sha256").update(manifest.workspaceId).digest("hex");
        const expiresAt = Date.parse(manifest.expiresAt);
        if (workspaceHash !== workspaceEntry.name || !Number.isFinite(expiresAt)) {
          throw new AbcmError("UPLOAD_STATE_INVALID", "Upload manifest identity is invalid during startup recovery.", {
            uploadId: uploadEntry.name,
          });
        }
        if (this.#now().getTime() >= expiresAt) {
          await rm(uploadDirectory, { recursive: true, force: true });
        }
      }
    }
  }

  #serialize<T>(uploadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(uploadId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(uploadId, tail);
    void tail.then(() => {
      if (this.#tails.get(uploadId) === tail) this.#tails.delete(uploadId);
    });
    return result;
  }

  #workspaceDirectory(workspaceId: string): string {
    return resolve(this.#stateRoot, "uploads", createHash("sha256").update(workspaceId).digest("hex"));
  }

  #uploadDirectory(workspaceId: string, uploadId: string): string {
    this.#assertUploadId(uploadId);
    return resolve(this.#workspaceDirectory(workspaceId), uploadId);
  }

  #manifestPath(workspaceId: string, uploadId: string): string {
    return resolve(this.#uploadDirectory(workspaceId, uploadId), "manifest.json");
  }

  #contentPath(workspaceId: string, uploadId: string): string {
    return resolve(this.#uploadDirectory(workspaceId, uploadId), "content.bin");
  }

  #assertUploadId(uploadId: string): void {
    if (!/^upl_[a-f0-9]{32}$/.test(uploadId)) throw new AbcmError("UPLOAD_NOT_FOUND", "Upload session was not found.", { uploadId });
  }
}
