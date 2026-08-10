import { resolve } from "node:path";

import { AbcmError } from "../core/errors.js";
import type { ResolvedWorkspace, WorkspaceDefinition } from "./types.js";

const DEFAULT_DENIED_DIRECTORIES = [".git", ".abcm", "node_modules", "vendor", "dist", "build", "coverage"];

export class WorkspaceRegistry {
  readonly #workspaces = new Map<string, ResolvedWorkspace>();

  constructor(definitions: readonly WorkspaceDefinition[]) {
    for (const definition of definitions) {
      if (this.#workspaces.has(definition.id)) throw new Error(`Duplicate workspace id: ${definition.id}`);
      this.#workspaces.set(definition.id, {
        id: definition.id,
        root: resolve(definition.root),
        deniedDirectories: new Set(definition.deniedDirectories ?? DEFAULT_DENIED_DIRECTORIES),
        maxReadBytes: definition.maxReadBytes ?? 1_048_576,
        maxWriteBytes: definition.maxWriteBytes ?? 1_048_576,
        maxListEntries: definition.maxListEntries ?? 10_000,
      });
    }
  }

  get(workspaceId: string): ResolvedWorkspace {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) {
      throw new AbcmError("WORKSPACE_NOT_FOUND", `Workspace '${workspaceId}' is not registered.`, { workspaceId });
    }
    return workspace;
  }
}
