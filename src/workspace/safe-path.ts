import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, resolve, sep, win32 } from "node:path";

import { AbcmError } from "../core/errors.js";

export interface ResolvePathOptions {
  allowMissing?: boolean;
  allowRoot?: boolean;
}

export interface SafePathResult {
  root: string;
  absolutePath: string;
  relativePath: string;
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export class SafeWorkspacePath {
  readonly #root: string;
  readonly #deniedDirectories: ReadonlySet<string>;

  private constructor(root: string, deniedDirectories: ReadonlySet<string>) {
    this.#root = root;
    this.#deniedDirectories = deniedDirectories;
  }

  static async create(root: string, deniedDirectories: ReadonlySet<string> = new Set([".git", ".abcm", "node_modules", "vendor", "dist", "build", "coverage"])) {
    return new SafeWorkspacePath(await realpath(root), deniedDirectories);
  }

  async resolve(input: string, options: ResolvePathOptions = {}): Promise<SafePathResult> {
    this.#validateSyntax(input, options.allowRoot ?? false);
    const relativePath = input === "" ? "" : posix.normalize(input);
    const segments = relativePath === "" ? [] : relativePath.split("/");
    this.#validateSegments(segments);

    const absolutePath = resolve(this.#root, ...segments);
    if (!isWithinRoot(this.#root, absolutePath)) {
      throw new AbcmError("FILE_PATH_INVALID", "Path escapes the workspace root.", { path: input });
    }

    await this.#rejectSymlinkComponents(segments, options.allowMissing ?? false);
    return { root: this.#root, absolutePath, relativePath };
  }

  #validateSyntax(input: string, allowRoot: boolean): void {
    if (typeof input !== "string" || (!allowRoot && input.length === 0)) {
      throw new AbcmError("FILE_PATH_INVALID", "A non-empty workspace-relative path is required.", { path: input });
    }
    if (
      input.includes("\0") ||
      input.includes("\\") ||
      isAbsolute(input) ||
      win32.isAbsolute(input) ||
      /^[a-zA-Z]:/.test(input) ||
      /%(?:2e|2f|5c)/i.test(input)
    ) {
      throw new AbcmError("FILE_PATH_INVALID", "Path is not a canonical workspace-relative path.", { path: input });
    }
  }

  #validateSegments(segments: readonly string[]): void {
    for (const segment of segments) {
      if (segment === "" || segment === "." || segment === "..") {
        throw new AbcmError("FILE_PATH_INVALID", "Path contains a non-canonical segment.", { segment });
      }
      if (this.#deniedDirectories.has(segment) || segment === ".env" || segment.startsWith(".env.")) {
        throw new AbcmError("FILE_PATH_FORBIDDEN", "Path is reserved or denied by workspace policy.", { segment });
      }
    }
  }

  async #rejectSymlinkComponents(segments: readonly string[], allowMissing: boolean): Promise<void> {
    let current = this.#root;
    for (const segment of segments) {
      current = resolve(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink()) {
          throw new AbcmError("FILE_PATH_FORBIDDEN", "Symbolic links are not addressable through the file API.", {
            path: current,
          });
        }
      } catch (error) {
        if (error instanceof AbcmError) throw error;
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new AbcmError("FILE_NOT_FOUND", "Workspace path does not exist.", { path: current });
        }
        throw error;
      }
    }
  }
}
