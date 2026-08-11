import { resolve } from "node:path";

import { AbcmError } from "../core/errors.js";
import type { ResolvedWorkspace, WorkspaceDefinition } from "./types.js";

const DEFAULT_DENIED_DIRECTORIES = [".git", ".abcm", "node_modules", "vendor", "dist", "build", "coverage"];

export class WorkspaceRegistry {
  readonly #workspaces = new Map<string, ResolvedWorkspace>();

  constructor(definitions: readonly WorkspaceDefinition[]) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: WorkspaceDefinition): ResolvedWorkspace {
    if (this.#workspaces.has(definition.id)) {
      throw new AbcmError("WORKSPACE_ALREADY_EXISTS", `Workspace '${definition.id}' is already registered.`, {
        workspaceId: definition.id,
      });
    }
    const workspace: ResolvedWorkspace = {
      id: definition.id,
      root: resolve(definition.root),
      deniedDirectories: new Set(definition.deniedDirectories ?? DEFAULT_DENIED_DIRECTORIES),
      maxReadBytes: definition.maxReadBytes ?? 1_048_576,
      maxWriteBytes: definition.maxWriteBytes ?? 1_048_576,
      maxListEntries: definition.maxListEntries ?? 10_000,
    };
    this.#workspaces.set(definition.id, workspace);
    return workspace;
  }

  unregister(workspaceId: string): void {
    this.#workspaces.delete(workspaceId);
  }

  has(workspaceId: string): boolean {
    return this.#workspaces.has(workspaceId);
  }

  list(): ResolvedWorkspace[] {
    return [...this.#workspaces.values()];
  }

  get(workspaceId: string): ResolvedWorkspace {
    const workspace = this.#workspaces.get(workspaceId);
    if (!workspace) {
      throw new AbcmError("WORKSPACE_NOT_FOUND", `Workspace '${workspaceId}' is not registered.`, { workspaceId });
    }
    return workspace;
  }
}
