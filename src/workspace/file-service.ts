import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, posix } from "node:path";

import { AbcmError } from "../core/errors.js";
import { observeOperation, type AbcmObservability } from "../core/observability.js";
import { throwIfAborted } from "../core/operation.js";
import { WorkspaceRegistry } from "./registry.js";
import { WorkspaceMutationCoordinator } from "./mutation-coordinator.js";
import { SafeWorkspacePath } from "./safe-path.js";
import type {
  DeletePreconditions,
  DeleteDirectoryOptions,
  FileEntry,
  FileMutationOperation,
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
  observability?: AbcmObservability;
  mutationCoordinator?: WorkspaceMutationCoordinator;
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
  readonly #observability: AbcmObservability | undefined;
  readonly #mutationCoordinator: WorkspaceMutationCoordinator;

  constructor(registry: WorkspaceRegistry, options: WorkspaceFileServiceOptions = {}) {
    this.#registry = registry;
    this.#onMutation = options.onMutation;
    this.#authorizeMutation = options.authorizeMutation;
    this.#observability = options.observability;
    this.#mutationCoordinator = options.mutationCoordinator ?? new WorkspaceMutationCoordinator();
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
    return observeOperation(this.#observability, {
      operation: "file.write",
      workspaceId,
      successMetrics: () => [{ name: "abcm_file_mutation_total", value: 1, unit: "count", operation: "file.write", outcome: "success" }],
    }, () => this.#write(workspaceId, path, content, preconditions, true, true, signal));
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
    return this.#mutate(workspaceId, async () => {
      throwIfAborted(signal);
      if (authorize) await this.#authorize(workspaceId, [path], "write");
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
    await observeOperation(this.#observability, {
      operation: "file.delete",
      workspaceId,
      successMetrics: () => [{ name: "abcm_file_mutation_total", value: 1, unit: "count", operation: "file.delete", outcome: "success" }],
    }, () => this.#delete(workspaceId, path, preconditions, true, true, signal));
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
    await this.#mutate(workspaceId, async () => {
      throwIfAborted(signal);
      if (authorize) await this.#authorize(workspaceId, [path], "delete");
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
    return observeOperation(this.#observability, {
      operation: "file.move",
      workspaceId,
      successMetrics: () => [{ name: "abcm_file_mutation_total", value: 1, unit: "count", operation: "file.move", outcome: "success" }],
    }, () => this.#move(workspaceId, from, to, options, true, true, signal));
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
    return this.#mutate(workspaceId, async () => {
      throwIfAborted(signal);
      if (authorize) await this.#authorize(workspaceId, [from, to], "move");
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

  async deleteDirectory(
    workspaceId: string,
    path: string,
    options: DeleteDirectoryOptions,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!options.recursive) {
      throw new AbcmError("REQUEST_INVALID", "Recursive directory deletion requires recursive=true.");
    }
    await observeOperation(this.#observability, {
      operation: "directory.delete",
      workspaceId,
      successMetrics: () => [{ name: "abcm_file_mutation_total", value: 1, unit: "count", operation: "directory.delete", outcome: "success" }],
    }, async () => {
      throwIfAborted(signal);
      const workspace = this.#registry.get(workspaceId);
      await this.#mutate(workspaceId, async () => {
        const safePath = await this.#safePath(workspace);
        const resolved = await safePath.resolve(path);
        const metadata = await stat(resolved.absolutePath);
        if (!metadata.isDirectory()) throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Directory deletion requires a directory.");
        const files = await this.#directoryFiles(workspace, safePath, resolved.absolutePath, resolved.relativePath, signal);
        await this.#authorize(workspaceId, files.length === 0 ? [resolved.relativePath] : files, "delete");
        throwIfAborted(signal);
        await rm(resolved.absolutePath, { recursive: true, force: false });
        await this.#notify(workspaceId, files.length === 0 ? [resolved.relativePath] : files);
      });
    });
  }

  async moveDirectory(
    workspaceId: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<FileEntry> {
    return observeOperation(this.#observability, {
      operation: "directory.move",
      workspaceId,
      successMetrics: () => [{ name: "abcm_file_mutation_total", value: 1, unit: "count", operation: "directory.move", outcome: "success" }],
    }, async () => {
      throwIfAborted(signal);
      const workspace = this.#registry.get(workspaceId);
      return this.#mutate(workspaceId, async () => {
        const safePath = await this.#safePath(workspace);
        const source = await safePath.resolve(from);
        let target = await safePath.resolve(to, { allowMissing: true });
        const sourceMetadata = await stat(source.absolutePath);
        if (!sourceMetadata.isDirectory()) throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Directory move requires a directory.");
        const sourceKey = source.relativePath.toLowerCase();
        const targetKey = target.relativePath.toLowerCase();
        if (targetKey === sourceKey || targetKey.startsWith(`${sourceKey}/`)) {
          throw new AbcmError("FILE_PATH_INVALID", "Directory cannot be moved onto itself or into its descendant.");
        }
        if (await this.#exists(target.absolutePath)) {
          throw new AbcmError("FILE_ALREADY_EXISTS", "Directory move target already exists.", { path: target.relativePath });
        }
        const sourceFiles = await this.#directoryFiles(workspace, safePath, source.absolutePath, source.relativePath, signal);
        const movedFiles = sourceFiles.map(path => posix.join(target.relativePath, path.slice(source.relativePath.length + 1)));
        const authorizationPaths = sourceFiles.length === 0
          ? [source.relativePath, target.relativePath]
          : sourceFiles.flatMap((path, index) => [path, movedFiles[index]!]);
        await this.#authorize(workspaceId, authorizationPaths, "move");
        await mkdir(dirname(target.absolutePath), { recursive: true });
        target = await safePath.resolve(to, { allowMissing: true });
        throwIfAborted(signal);
        await rename(source.absolutePath, target.absolutePath);
        if (sourceFiles.length === 0) {
          await this.#notify(workspaceId, [source.relativePath, target.relativePath]);
        } else {
          for (let index = 0; index < sourceFiles.length; index += 1) {
            await this.#notify(workspaceId, [sourceFiles[index]!, movedFiles[index]!]);
          }
        }
        const targetMetadata = await stat(target.absolutePath);
        return {
          path: target.relativePath,
          name: basename(target.relativePath),
          kind: "directory" as const,
          size: 0,
          modifiedAt: targetMetadata.mtime.toISOString(),
        };
      });
    });
  }

  async createDirectory(workspaceId: string, path: string, signal?: AbortSignal): Promise<FileEntry> {
    throwIfAborted(signal);
    const workspace = this.#registry.get(workspaceId);
    return this.#mutate(workspaceId, async () => {
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

  async #directoryFiles(
    workspace: ResolvedWorkspace,
    safePath: SafeWorkspacePath,
    absoluteDirectory: string,
    relativeDirectory: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const files: string[] = [];
    const visit = async (absolute: string, relative: string): Promise<void> => {
      throwIfAborted(signal);
      const children = await readdir(absolute, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        throwIfAborted(signal);
        if (this.#isDeniedName(workspace, child.name)) {
          throw new AbcmError("FILE_PATH_FORBIDDEN", "Directory mutation contains a reserved path.", { path: posix.join(relative, child.name) });
        }
        if (child.isSymbolicLink()) {
          throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Directory mutation does not support symbolic links.", { path: posix.join(relative, child.name) });
        }
        const childPath = posix.join(relative, child.name);
        const resolved = await safePath.resolve(childPath);
        if (child.isDirectory()) await visit(resolved.absolutePath, childPath);
        else if (child.isFile()) files.push(childPath);
        else throw new AbcmError("FILE_TYPE_UNSUPPORTED", "Directory mutation supports only regular files and directories.", { path: childPath });
        if (files.length > workspace.maxListEntries) {
          throw new AbcmError("FILE_TOO_LARGE", "Directory mutation exceeds the configured entry limit.", { maxListEntries: workspace.maxListEntries });
        }
      }
    };
    await visit(absoluteDirectory, relativeDirectory);
    return files;
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

  async #authorize(workspaceId: string, paths: readonly string[], operation: FileMutationOperation): Promise<void> {
    if (this.#authorizeMutation) await this.#authorizeMutation(workspaceId, paths, operation);
  }

  #mutate<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    return this.#mutationCoordinator.run(workspaceId, operation);
  }
}
