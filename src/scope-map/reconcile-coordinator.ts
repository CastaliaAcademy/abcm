import type { WorkspaceRegistry } from "../workspace/registry.js";
import {
  DEFAULT_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS,
  DEFAULT_SCOPE_MAP_RECONCILE_DEBOUNCE_MS,
} from "./reconcile-config.js";
import type { MapRevision } from "./types.js";

export interface ScopeMapScanner {
  scan(workspaceId: string): Promise<MapRevision>;
}

export interface ScopeMapReconcileOptions {
  debounceMs?: number;
  fullReconcileIntervalMs?: number;
  onBackgroundError?: (error: Error, workspaceId: string) => void;
}

interface PendingMutation {
  promise: Promise<MapRevision>;
  resolve: (revision: MapRevision) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function validateTiming(value: number, minimum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer.`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export class ScopeMapReconcileCoordinator {
  readonly #registry: WorkspaceRegistry;
  readonly #scanner: ScopeMapScanner;
  readonly #debounceMs: number;
  readonly #onBackgroundError: ScopeMapReconcileOptions["onBackgroundError"];
  readonly #periodicTimer: ReturnType<typeof setInterval>;
  readonly #pendingMutations = new Map<string, PendingMutation>();
  readonly #inFlight = new Map<string, Promise<MapRevision>>();
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(registry: WorkspaceRegistry, scanner: ScopeMapScanner, options: ScopeMapReconcileOptions = {}) {
    this.#registry = registry;
    this.#scanner = scanner;
    this.#debounceMs = options.debounceMs ?? DEFAULT_SCOPE_MAP_RECONCILE_DEBOUNCE_MS;
    const fullReconcileIntervalMs =
      options.fullReconcileIntervalMs ?? DEFAULT_SCOPE_MAP_FULL_RECONCILE_INTERVAL_MS;
    this.#onBackgroundError = options.onBackgroundError;
    validateTiming(this.#debounceMs, 0, "debounceMs");
    validateTiming(fullReconcileIntervalMs, 1, "fullReconcileIntervalMs");
    this.#periodicTimer = setInterval(() => this.#periodicTick(), fullReconcileIntervalMs);
    this.#periodicTimer.unref();
  }

  requestMutation(workspaceId: string): Promise<MapRevision> {
    if (this.#closed) return Promise.reject(new Error("ScopeMap reconcile coordinator is closed."));
    this.#registry.get(workspaceId);
    const existing = this.#pendingMutations.get(workspaceId);
    if (existing !== undefined) return existing.promise;

    let resolvePromise!: (revision: MapRevision) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<MapRevision>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingMutation = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer: setTimeout(() => this.#flushMutation(workspaceId), this.#debounceMs),
    };
    this.#pendingMutations.set(workspaceId, pending);
    return promise;
  }

  reconcileNow(workspaceId: string): Promise<MapRevision> {
    if (this.#closed) return Promise.reject(new Error("ScopeMap reconcile coordinator is closed."));
    this.#registry.get(workspaceId);
    return this.#start(workspaceId);
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    clearInterval(this.#periodicTimer);
    const pendingWorkspaceIds = [...this.#pendingMutations.keys()];
    for (const pending of this.#pendingMutations.values()) clearTimeout(pending.timer);
    this.#closePromise = (async () => {
      const flushed = pendingWorkspaceIds.map(workspaceId => this.#start(workspaceId));
      await Promise.allSettled([...flushed, ...this.#inFlight.values()]);
    })();
    return this.#closePromise;
  }

  #periodicTick(): void {
    if (this.#closed) return;
    for (const workspace of this.#registry.list()) {
      if (this.#inFlight.has(workspace.id)) continue;
      void this.#start(workspace.id).catch(error => {
        try {
          this.#onBackgroundError?.(asError(error), workspace.id);
        } catch {
          // A reporting callback cannot stop later periodic reconciliation.
        }
      });
    }
  }

  #flushMutation(workspaceId: string): void {
    if (!this.#pendingMutations.has(workspaceId)) return;
    void this.#start(workspaceId);
  }

  #start(workspaceId: string): Promise<MapRevision> {
    const pending = this.#pendingMutations.get(workspaceId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.#pendingMutations.delete(workspaceId);
    }
    const operation = this.#run(workspaceId);
    if (pending !== undefined) operation.then(pending.resolve, pending.reject);
    return operation;
  }

  #run(workspaceId: string): Promise<MapRevision> {
    const existing = this.#inFlight.get(workspaceId);
    if (existing !== undefined) return existing;
    const operation = Promise.resolve().then(() => this.#scanner.scan(workspaceId));
    this.#inFlight.set(workspaceId, operation);
    void operation.then(
      () => {
        if (this.#inFlight.get(workspaceId) === operation) this.#inFlight.delete(workspaceId);
      },
      () => {
        if (this.#inFlight.get(workspaceId) === operation) this.#inFlight.delete(workspaceId);
      },
    );
    return operation;
  }
}
