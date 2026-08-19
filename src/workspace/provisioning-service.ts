import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stringify } from "yaml";

import { AbcmError } from "../core/errors.js";
import { projectLanguageTagSchema } from "../core/project-language.js";
import { throwIfAborted } from "../core/operation.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { WorkspaceFileService } from "./file-service.js";
import type { WorkspaceRegistry } from "./registry.js";
import type { WorkspaceDefinition } from "./types.js";

const WORKSPACE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export interface WorkspaceProvisioningDependencies {
  registry: WorkspaceRegistry;
  files: WorkspaceFileService;
  scopeMap: ScopeMapService;
  storeRoot: string;
}

export class WorkspaceProvisioningService {
  readonly #dependencies: WorkspaceProvisioningDependencies;
  #creationTail: Promise<void> = Promise.resolve();

  constructor(dependencies: WorkspaceProvisioningDependencies) {
    this.#dependencies = dependencies;
  }

  create(input: { id: string; name?: string; language: string }, signal?: AbortSignal): Promise<{ id: string }> {
    const result = this.#creationTail.then(
      () => this.#create(input, signal),
      () => this.#create(input, signal),
    );
    this.#creationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #create(input: { id: string; name?: string; language: string }, signal?: AbortSignal): Promise<{ id: string }> {
    throwIfAborted(signal);
    if (!WORKSPACE_ID.test(input.id)) {
      throw new AbcmError("REQUEST_INVALID", "Workspace id must be a lowercase portable identifier.", {
        workspaceId: input.id,
      });
    }

    const languageResult = projectLanguageTagSchema.safeParse(input.language);
    if (!languageResult.success) {
      throw new AbcmError("REQUEST_INVALID", "Workspace language must be a valid BCP 47 tag.", { language: input.language });
    }

    const storeRoot = resolve(this.#dependencies.storeRoot);
    const workspaceRoot = resolve(storeRoot, input.id);
    if (dirname(workspaceRoot) !== storeRoot) {
      throw new AbcmError("REQUEST_INVALID", "Workspace root escapes the configured store.", { workspaceId: input.id });
    }
    if (this.#dependencies.registry.has(input.id)) {
      throw new AbcmError("WORKSPACE_ALREADY_EXISTS", `Workspace '${input.id}' is already registered.`, {
        workspaceId: input.id,
      });
    }

    await mkdir(storeRoot, { recursive: true });
    throwIfAborted(signal);
    try {
      await mkdir(workspaceRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new AbcmError("WORKSPACE_ALREADY_EXISTS", `Workspace directory '${input.id}' already exists.`, {
          workspaceId: input.id,
        });
      }
      throw error;
    }

    this.#dependencies.registry.register({ id: input.id, root: workspaceRoot });
    try {
      const scopeManifest = stringify({
        apiVersion: "abcm/v1",
        kind: "workflow",
        id: input.id,
        name: input.name ?? input.id,
      });
      const convention = "---\napiVersion: abcm/v1\nkind: DomainLanguageConvention\nmode: inherit-only\n---\n";
      const contextConfig = stringify({ apiVersion: "abcm/v1", kind: "ContextConfig", language: languageResult.data });
      const architecturePolicy = stringify({
        apiVersion: "abcm/v1",
        kind: "ArchitecturePolicy",
        enforcement: "required",
        architecture: "abcm-mvp-agent-spec-v0.5",
      });
      await this.#dependencies.files.write(
        input.id,
        "scope.yaml",
        new TextEncoder().encode(scopeManifest),
        { ifNoneMatch: "*" },
        signal,
      );
      await this.#dependencies.files.write(
        input.id,
        "domain-language/DomainLanguageConvention.md",
        new TextEncoder().encode(convention),
        { ifNoneMatch: "*" },
        signal,
      );
      await this.#dependencies.files.write(
        input.id,
        "config/context.yaml",
        new TextEncoder().encode(contextConfig),
        { ifNoneMatch: "*" },
        signal,
      );
      await this.#dependencies.files.write(
        input.id,
        "config/architecture.yaml",
        new TextEncoder().encode(architecturePolicy),
        { ifNoneMatch: "*" },
        signal,
      );
      await this.#dependencies.scopeMap.scan(input.id, signal);
      return { id: input.id };
    } catch (error) {
      this.#dependencies.registry.unregister(input.id);
      await rm(workspaceRoot, { recursive: true, force: true });
      throw error;
    }
  }
}

export async function discoverManagedWorkspaces(storeRootInput: string): Promise<WorkspaceDefinition[]> {
  const storeRoot = resolve(storeRootInput);
  await mkdir(storeRoot, { recursive: true });
  const entries = await readdir(storeRoot, { withFileTypes: true });
  const definitions: WorkspaceDefinition[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !WORKSPACE_ID.test(entry.name)) continue;
    const root = resolve(storeRoot, entry.name);
    try {
      if (!(await stat(resolve(root, "scope.yaml"))).isFile()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    definitions.push({ id: entry.name, root });
  }
  return definitions;
}
