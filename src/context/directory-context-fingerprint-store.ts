import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import { stringify } from "yaml";

import { AbcmError } from "../core/errors.js";
import type { ContextExecutionBinding, ContextFingerprint, ContextFingerprintCatalog, ContextFingerprintStore } from "./types.js";
import { WorkspaceRegistry } from "../workspace/registry.js";

function safeSegment(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new AbcmError("REQUEST_INVALID", `${field} must be a safe context fingerprint path segment.`);
  }
  return value;
}

async function ensureOwnedDirectory(root: string, relative: string): Promise<string> {
  let current = root;
  for (const segment of relative.split("/")) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new AbcmError("FILE_PATH_FORBIDDEN", `Context fingerprint directory '${relative}' is not an owned regular directory.`);
    }
  }
  return current;
}

export class DirectoryContextFingerprintStore implements ContextFingerprintStore {
  readonly #registry: WorkspaceRegistry;
  readonly #catalog: ContextFingerprintCatalog | undefined;

  constructor(registry: WorkspaceRegistry, catalog?: ContextFingerprintCatalog) {
    this.#registry = registry;
    this.#catalog = catalog;
  }

  async write(workspaceId: string, execution: ContextExecutionBinding | undefined, fingerprint: ContextFingerprint): Promise<string> {
    const workspace = this.#registry.get(workspaceId);
    const planId = safeSegment(execution?.planId ?? "adhoc", "planId");
    const runId = safeSegment(execution?.runId ?? fingerprint.fingerprintId, "runId");
    const fingerprintId = safeSegment(fingerprint.fingerprintId, "fingerprintId");
    const relative = execution?.assignmentId === undefined
      ? posix.join(".abcm", "artifacts", "plans", planId, "context-fingerprints", "execution", runId, fingerprintId)
      : posix.join(".abcm", "artifacts", "plans", planId, "context-fingerprints", "subagents", safeSegment(execution.assignmentId, "assignmentId"), runId, fingerprintId);
    const parentRelative = dirname(relative).replaceAll("\\", "/");
    const parent = await ensureOwnedDirectory(workspace.root, parentRelative);
    const absolute = join(parent, fingerprintId);
    const temporary = `${absolute}.tmp-${randomUUID()}`;
    await mkdir(temporary, { mode: 0o700 });
    const json = `${JSON.stringify(fingerprint, null, 2)}\n`;
    const selected = fingerprint.selectedDocuments.map(item => JSON.stringify(item)).join("\n") + (fingerprint.selectedDocuments.length === 0 ? "" : "\n");
    const checksums = fingerprint.selectedDocuments.map(item => `${item.checksum.replace(/^sha256:/, "")}  ${item.relativePath}`).join("\n") + (fingerprint.selectedDocuments.length === 0 ? "" : "\n");
    try {
      await Promise.all([
        writeFile(join(temporary, "fingerprint.json"), json, { flag: "wx", mode: 0o600 }),
        writeFile(join(temporary, "fingerprint.yaml"), stringify(fingerprint), { flag: "wx", mode: 0o600 }),
        writeFile(join(temporary, "selected-files.jsonl"), selected, { flag: "wx", mode: 0o600 }),
        writeFile(join(temporary, "checksums.sha256"), checksums, { flag: "wx", mode: 0o600 }),
      ]);
      await rename(temporary, absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
      const existing = await readFile(join(absolute, "fingerprint.json"), "utf8");
      await rm(temporary, { recursive: true, force: true });
      if (existing !== json) throw new Error(`Context fingerprint location '${relative}' is immutable.`);
    }
    this.#catalog?.recordContextFingerprint(workspaceId, relative, fingerprint);
    return relative;
  }
}
