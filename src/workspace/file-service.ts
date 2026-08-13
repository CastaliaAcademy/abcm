import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, posix } from "node:path";

import { AbcmError } from "../core/errors.js";
import { throwIfAborted } from "../core/operation.js";
import { WorkspaceRegistry } from "./registry.js";
import { SafeWorkspacePath } from "./safe-path.js";
import type {
  DeletePreconditions,
  FileEntry,
  MoveOptions,
  MutationReconciler,
  MutationAuthorizer,
  ReadFileResult,
  ResolvedWorkspace,
  WritePreconditions,
} from "./types.js";

interface WorkspaceFileServiceOptions {
  onMutation?: MutationReconciler;
  authorizeMutation?: MutationAuthorizer;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return `sha256:${hash.digest("hex")}`;
}

function sha256Bytes(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function contentTypeFor(path: string): string {
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml; charset=utf-8";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".ts") || path.endsWith(".js")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

export class WorkspaceFileService {
  readonly #registry: WorkspaceRegistry;
  readonly #onMutation: MutationReconciler | undefined;
  readonly #authorizeMutation: MutationAuthorizer | undefined;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(registry: WorkspaceRegistry, options: WorkspaceFileServiceOptions = {}) {
    this.#registry = registry;
    this.#onMutation = options.onMutation;
    this.#authorizeMutation = options.authorizeMutation;
  }

  async list(workspaceId: string, path = "", recursive = false, signal?: AbortSignal): Promise<FileEntry[]> {
    throwIfAborted(signal);
    const workspace = this.#registry.get(workspaceId);
    const safePath = await this.#safePath(workspace);
    const resolved = await safePath.resolve(path, { allowRoot: true });
    const rootStat = await stat(resolved.absolutePath);
    if (!rootStat.isDirectory()) throw new AbcmError("FILE_TYPE_UNSUPPORTED", "File listing requires a directory.");

    const entries: FileEntry[] = [];
    const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
      throwIfAborted(signal);
      const children = await readdir(absoluteDirectory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        throwIfAborted(signal);
        if (this.#isDeniedName(workspace, child.name) || child.isSymbolicLink()) continue;
        const relativePath = relativeDirectory === "" ? child.name : posix.join(relativeDirectory, child.name);
        const resolvedChild = await safePath.resolve(relativePath);
        const metadata = await stat(resolvedChild.absolutePath);
        if (child.isDirectory()) {
          entries.push({
            path: relativePath,
            name: child.name,
            kind: "directory",
            size: 0,
            modifiedAt: metadata.mtime.toISOString(),
          });
          if (recursive) await visit(resolvedChild.absolutePath, relativePath);
        } else if (child.isFile()) {
          entries.push({
            path: relativePath,
            name: child.name,
            kind: "file",
            size: metadata.size,
            modifiedAt: metadata.mtime.toISOString(),
            checksum: await sha256File(resolvedChild.absolutePath),
          });
        }
        if (entries.length > workspace.maxListEntries) {
          throw new AbcmError("FILE_TOO_LARGE", "File listing exceeds the configured entry limit.", {
            maxListEntries: workspace.maxListEntries,
          });
        }
      }
    };

    await visit(resolved.absolutePath, resolved.relativePath);
    return entries;
  }

  async read(workspaceId: string, path: string, signal?: AbortSignal): Promise<ReadFileResult> {
    throwIfAborted(signal);
    const workspace = this.#registry.get(workspaceId);
    const safePath = await this.#safePath(workspace);
    const resolved = await safePath.resolve(path);
    const metadata = await stat(resolved.absolutePath);
    if (!metadata.isFile()) throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Only regular files can be read.");
    if (metadata.size > workspace.maxReadBytes) {
      throw new AbcmError("FILE_TOO_LARGE", "File exceeds the configured read limit.", {
        size: metadata.size,
        maxReadBytes: workspace.maxReadBytes,
      });
    }
    const file = Bun.file(resolved.absolutePath);
    const content = new Uint8Array(await file.arrayBuffer());
    throwIfAborted(signal);
    const checksum = sha256Bytes(content);
    return {
      content,
      contentType: contentTypeFor(path),
      entry: {
        path: resolved.relativePath,
        name: basename(resolved.relativePath),
        kind: "file",
        size: content.byteLength,
        modifiedAt: metadata.mtime.toISOString(),
        checksum,
      },
    };
  }

  async write(workspaceId: string, path: string, content: Uint8Array, preconditions: WritePreconditions = {}, signal?: AbortSignal): Promise<FileEntry & { checksum: string }> {
    return this.#write(workspaceId, path, content, preconditions, true, true, signal);
  }

  async writeMirror(
    workspaceId: string,
    path: string,
    content: Uint8Array,
    preconditions: WritePreconditions = {},
    signal?: AbortSignal,
  ): Promise<FileEntry & { checksum: string }> {
    return this.#write(workspaceId, path, content, preconditions, false, false, signal);
  }

  async #write(
    workspaceId: string,
    path: string,
    content: Uint8Array,
    preconditions: WritePreconditions,
    authorize: boolean,
    notify: boolean,
    signal?: AbortSignal,
  ): Promise<FileEntry & { checksum: string }> {
    throwIfAborted(signal);
    const workspace = this.#registry.get(workspaceId);
    if (content.byteLength > workspace.maxWriteBytes) {
      throw new AbcmError("FILE_TOO_LARGE", "Content exceeds the configured write limit.", {
        size: content.byteLength,
        maxWriteBytes: workspace.maxWriteBytes,
      });
    }
    return this.#mutate(async () => {
      throwIfAborted(signal);
      if (authorize) await this.#authorize(workspaceId, [path]);
      throwIfAborted(signal);
      const safePath = await this.#safePath(workspace);
      let resolved = await safePath.resolve(path, { allowMissing: true });
      await mkdir(dirname(resolved.absolutePath), { recursive: true });
      resolved = await safePath.resolve(path, { allowMissing: true });
      const before = await this.#currentChecksum(resolved.absolutePath);
      this.#validateWritePreconditions(before, preconditions);

      const temporaryPath = `${dirname(resolved.absolutePath)}/.${basename(path)}.abcm-${randomUUID()}.tmp`;
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }

      try {
        const beforeCommit = await this.#currentChecksum(resolved.absolutePath);
        if (beforeCommit !== before) {
          throw new AbcmError("FILE_CHECKSUM_MISMATCH", "File changed while the write was being committed.");
        }
        throwIfAborted(signal);
        await rename(temporaryPath, resolved.absolutePath);
      } catch (error) {
        await unlink(temporaryPath).catch(() => undefined);
        throw error;
      }

      if (notify) await this.#notify(workspaceId, [resolved.relativePath]);
      const metadata = await stat(resolved.absolutePath);
      return {
        path: resolved.relativePath,
        name: basename(resolved.relativePath),
        kind: "file" as const,
        size: content.byteLength,
        modifiedAt: metadata.mtime.toISOString(),
        checksum: sha256Bytes(content),
      };
    });
  }

  async delete(workspaceId: string, path: string, preconditions: DeletePreconditions = {}, signal?: AbortSignal): Promise<void> {
    await this.#delete(workspaceId, path, preconditions, true, true, signal);
  }

  async deleteMirror(workspaceId: string, path: string, preconditions: DeletePreconditions = {}, signal?: AbortSignal): Promise<void> {
    await this.#delete(workspaceId, path, preconditions, false, false, signal);
  }

  async #delete(
    workspaceId: string,
    path: string,
    preconditions: DeletePreconditions,
    authorize: boolean,
    notify: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const workspace = this.#registry.get(workspaceId);
    await this.#mutate(async () => {
      throwIfAborted(signal);
      if (authorize) await this.#authorize(workspaceId, [path]);
      throwIfAborted(signal);
      const safePath = await this.#safePath(workspace);
      const resolved = await safePath.resolve(path);
      const metadata = await stat(resolved.absolutePath);
      if (!metadata.isFile()) throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Recursive directory deletion is unsupported.");
      const checksum = await sha256File(resolved.absolutePath);
      this.#validateMatch(checksum, preconditions.ifMatch);
      throwIfAborted(signal);
      await unlink(resolved.absolutePath);
      if (notify) await this.#notify(workspaceId, [resolved.relativePath]);
    });
  }

  async move(workspaceId: string, from: string, to: string, options: MoveOptions = {}, signal?: AbortSignal): Promise<FileEntry & { checksum: string }> {
    return this.#move(workspaceId, from, to, options, true, true, signal);
  }

  async moveMirror(
    workspaceId: string,
    from: string,
    to: string,
    options: MoveOptions = {},
    signal?: AbortSignal,
  ): Promise<FileEntry & { checksum: string }> {
    return this.#move(workspaceId, from, to, options, false, false, signal);
  }

  async #move(
    workspaceId: string,
    from: string,
    to: string,
    options: MoveOptions,
    authorize: boolean,
    notify: boolean,
    signal?: AbortSignal,
  ): Promise<FileEntry & { checksum: string }> {
    throwIfAborted(signal);
    const workspace = this.#registry.get(workspaceId);
    return this.#mutate(async () => {
      throwIfAborted(signal);
      if (authorize) await this.#authorize(workspaceId, [from, to]);
      throwIfAborted(signal);
      const safePath = await this.#safePath(workspace);
      const source = await safePath.resolve(from);
      let target = await safePath.resolve(to, { allowMissing: true });
      const sourceStat = await stat(source.absolutePath);
      if (!sourceStat.isFile()) throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Only regular files can be moved.");
      const checksum = await sha256File(source.absolutePath);
      this.#validateMatch(checksum, options.ifMatch);

      const targetChecksum = await this.#currentChecksum(target.absolutePath);
      if (targetChecksum !== undefined && !options.overwrite) {
        throw new AbcmError("FILE_ALREADY_EXISTS", "Move target already exists.", { path: target.relativePath });
      }
      await mkdir(dirname(target.absolutePath), { recursive: true });
      target = await safePath.resolve(to, { allowMissing: true });
      throwIfAborted(signal);
      if (targetChecksum !== undefined && options.overwrite) await unlink(target.absolutePath);
      await rename(source.absolutePath, target.absolutePath);
      if (notify) await this.#notify(workspaceId, [source.relativePath, target.relativePath]);
      const targetStat = await stat(target.absolutePath);
      return {
        path: target.relativePath,
        name: basename(target.relativePath),
        kind: "file" as const,
        size: targetStat.size,
        modifiedAt: targetStat.mtime.toISOString(),
        checksum,
      };
    });
  }

  async createDirectory(workspaceId: string, path: string, signal?: AbortSignal): Promise<FileEntry> {
    throwIfAborted(signal);
    const workspace = this.#registry.get(workspaceId);
    return this.#mutate(async () => {
      throwIfAborted(signal);
      const safePath = await this.#safePath(workspace);
      let resolved = await safePath.resolve(path, { allowMissing: true });
      if ((await this.#exists(resolved.absolutePath))) {
        throw new AbcmError("FILE_ALREADY_EXISTS", "Directory path already exists.", { path: resolved.relativePath });
      }
      throwIfAborted(signal);
      await mkdir(resolved.absolutePath, { recursive: true });
      resolved = await safePath.resolve(path);
      const metadata = await stat(resolved.absolutePath);
      await this.#notify(workspaceId, [resolved.relativePath]);
      return {
        path: resolved.relativePath,
        name: basename(resolved.relativePath),
        kind: "directory",
        size: 0,
        modifiedAt: metadata.mtime.toISOString(),
      };
    });
  }

  async #safePath(workspace: ResolvedWorkspace): Promise<SafeWorkspacePath> {
    return SafeWorkspacePath.create(workspace.root, workspace.deniedDirectories);
  }

  #isDeniedName(workspace: ResolvedWorkspace, name: string): boolean {
    return workspace.deniedDirectories.has(name) || name === ".env" || name.startsWith(".env.");
  }

  async #currentChecksum(path: string): Promise<string | undefined> {
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Path is not a regular file.");
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

  #validateWritePreconditions(current: string | undefined, preconditions: WritePreconditions): void {
    if (preconditions.ifNoneMatch === "*" && current !== undefined) {
      throw new AbcmError("FILE_ALREADY_EXISTS", "File already exists.");
    }
    this.#validateMatch(current, preconditions.ifMatch);
  }

  #validateMatch(current: string | undefined, expected: string | undefined): void {
    if (expected !== undefined && current !== expected) {
      throw new AbcmError("FILE_CHECKSUM_MISMATCH", "File checksum precondition did not match.", {
        expected,
        actual: current,
      });
    }
  }

  async #notify(workspaceId: string, paths: readonly string[]): Promise<void> {
    if (this.#onMutation) await this.#onMutation(workspaceId, paths);
  }

  async #authorize(workspaceId: string, paths: readonly string[]): Promise<void> {
    if (this.#authorizeMutation) await this.#authorizeMutation(workspaceId, paths);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
