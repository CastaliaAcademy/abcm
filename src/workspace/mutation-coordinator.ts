import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Database } from "bun:sqlite";

export interface WorkspaceMutationCoordinatorOptions {
  databasePath?: string;
  retryDelayMs?: number;
}

function isDatabaseBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String((error as Error & { code?: unknown }).code) : "";
  return code === "SQLITE_BUSY" || /database is (?:locked|busy)/i.test(error.message);
}

export class WorkspaceMutationCoordinator {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #database: Database | undefined;
  readonly #retryDelayMs: number;
  #closed = false;

  constructor(options: WorkspaceMutationCoordinatorOptions = {}) {
    this.#retryDelayMs = options.retryDelayMs ?? 10;
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 1 || this.#retryDelayMs > 1_000) {
      throw new Error("retryDelayMs must be an integer from 1 through 1000.");
    }
    if (options.databasePath !== undefined) {
      const databasePath = resolve(options.databasePath);
      mkdirSync(dirname(databasePath), { recursive: true });
      this.#database = new Database(databasePath, { create: true, readwrite: true });
      this.#database.run("PRAGMA busy_timeout = 0");
    }
  }

  run<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Workspace mutation coordinator is closed."));
    const serializationKey = this.#database === undefined ? workspaceId : "__external_database_lock__";
    const previous = this.#tails.get(serializationKey) ?? Promise.resolve();
    const result = previous.then(
      () => this.#runWithExternalLock(operation),
      () => this.#runWithExternalLock(operation),
    );
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(serializationKey, tail);
    void tail.then(() => {
      if (this.#tails.get(serializationKey) === tail) this.#tails.delete(serializationKey);
    });
    return result;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database?.close();
  }

  async #runWithExternalLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#database === undefined) return operation();
    while (true) {
      try {
        this.#database.run("BEGIN IMMEDIATE");
        break;
      } catch (error) {
        if (!isDatabaseBusy(error)) throw error;
        await Bun.sleep(this.#retryDelayMs);
      }
    }
    try {
      const result = await operation();
      this.#database.run("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.run("ROLLBACK");
      } catch {
        // A failed COMMIT can already have ended the transaction; preserve the original error.
      }
      throw error;
    }
  }
}
