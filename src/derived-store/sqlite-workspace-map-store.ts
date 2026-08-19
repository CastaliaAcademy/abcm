import { join } from "node:path";

import type { ContextBuildCacheCatalog, ContextBuildCacheEntry, ContextBuildCacheIdentity } from "../context/context-build-cache.js";
import type {
  ContextBundleCatalogRecord,
  ContextFingerprint,
  ContextFingerprintCatalog,
  ContextFingerprintCatalogRecord,
} from "../context/types.js";
import type {
  DocumentationStateCommit,
  DocumentationStateStore,
  DocumentationCutoverRecord,
  DocumentationSourceState,
  DocumentProvenanceRecord,
  DocumentStorageResolution,
  SyncRunRecord,
  TombstoneRecord,
} from "../documentation/types.js";
import type { MapRevision } from "../scope-map/types.js";
import type { ContextOutcomeCatalog, ContextOutcomeReceipt, ContextOutcomeSubmission } from "../evaluation/context-outcome-receipt.js";
import type { ContextFeedbackCatalog, ContextFeedbackProposal, ContextFeedbackProposalInput } from "../evaluation/context-feedback.js";
import type { BusinessEvaluationCatalog, BusinessEvaluationReceipt } from "../evaluation/context-business-eval-runner.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { SqliteScopeMapStore } from "./sqlite-scope-map-store.js";
import type { ScanLeaseHandle, ScopeMapStore, SqliteWorkspaceMapStoreOptions } from "./types.js";

export class SqliteWorkspaceMapStore implements ScopeMapStore, DocumentationStateStore, ContextFingerprintCatalog, ContextOutcomeCatalog, ContextBuildCacheCatalog, ContextFeedbackCatalog, BusinessEvaluationCatalog {
  readonly scanLeaseRenewalIntervalMs: number;
  readonly #registry: WorkspaceRegistry;
  readonly #options: SqliteWorkspaceMapStoreOptions;
  readonly #stores = new Map<string, SqliteScopeMapStore>();
  readonly #runtimeOwnerTtlMs: number;
  readonly #heartbeat: ReturnType<typeof setInterval>;
  #ownershipError: unknown;

  constructor(registry: WorkspaceRegistry, options: SqliteWorkspaceMapStoreOptions = {}) {
    this.#registry = registry;
    this.#options = options;
    this.#runtimeOwnerTtlMs = options.runtimeOwnerTtlMs ?? 30_000;
    const scanLeaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.scanLeaseRenewalIntervalMs = options.scanLeaseRenewalIntervalMs ?? Math.floor(scanLeaseTtlMs / 3);
    if (
      !Number.isSafeInteger(this.scanLeaseRenewalIntervalMs) ||
      this.scanLeaseRenewalIntervalMs <= 0 ||
      this.scanLeaseRenewalIntervalMs >= scanLeaseTtlMs
    ) {
      throw new Error("scanLeaseRenewalIntervalMs must be a positive integer smaller than leaseTtlMs.");
    }
    const renewalIntervalMs = options.runtimeOwnerRenewalIntervalMs ?? Math.floor(this.#runtimeOwnerTtlMs / 3);
    if (!Number.isSafeInteger(renewalIntervalMs) || renewalIntervalMs <= 0 || renewalIntervalMs >= this.#runtimeOwnerTtlMs) {
      throw new Error("runtimeOwnerRenewalIntervalMs must be a positive integer smaller than runtimeOwnerTtlMs.");
    }
    this.#heartbeat = setInterval(() => {
      try {
        this.renewOwnership();
      } catch (error) {
        this.#ownershipError = error;
      }
    }, renewalIntervalMs);
    this.#heartbeat.unref();
  }

  beginScan(workspaceId: string): ScanLeaseHandle {
    this.#assertHealthy();
    return this.#store(workspaceId).beginScan(workspaceId);
  }

  publish(lease: ScanLeaseHandle, revision: MapRevision): void {
    this.#assertHealthy();
    this.#store(lease.workspaceId).publish(lease, revision);
  }

  renew(lease: ScanLeaseHandle): ScanLeaseHandle {
    this.#assertHealthy();
    return this.#store(lease.workspaceId).renew(lease);
  }

  fail(lease: ScanLeaseHandle): void {
    this.#assertHealthy();
    this.#store(lease.workspaceId).fail(lease);
  }

  getActive(workspaceId: string): MapRevision | undefined {
    this.#assertHealthy();
    return this.#store(workspaceId).getActive(workspaceId);
  }

  recordContextFingerprint(workspaceId: string, location: string, fingerprint: ContextFingerprint): void {
    this.#assertHealthy();
    this.#store(workspaceId).recordContextFingerprint(workspaceId, location, fingerprint);
  }

  getContextFingerprint(workspaceId: string, fingerprintId: string): ContextFingerprintCatalogRecord | undefined {
    this.#assertHealthy();
    return this.#store(workspaceId).getContextFingerprint(workspaceId, fingerprintId);
  }

  listContextBundles(workspaceId: string): ContextBundleCatalogRecord[] {
    this.#assertHealthy();
    return this.#store(workspaceId).listContextBundles(workspaceId);
  }

  recordContextOutcome(input: ContextOutcomeSubmission): ContextOutcomeReceipt {
    this.#assertHealthy();
    return this.#store(input.workspaceId).recordContextOutcome(input);
  }

  listContextOutcomes(workspaceId: string, fingerprintId: string): ContextOutcomeReceipt[] {
    this.#assertHealthy();
    return this.#store(workspaceId).listContextOutcomes(workspaceId, fingerprintId);
  }

  lookupContextBuildCache(identity: ContextBuildCacheIdentity): { state: "hit"; entry: ContextBuildCacheEntry } | { state: "miss" | "stale" } {
    this.#assertHealthy();
    return this.#store(identity.workspaceId).lookupContextBuildCache(identity);
  }

  putContextBuildCache(entry: ContextBuildCacheEntry): void {
    this.#assertHealthy();
    this.#store(entry.identity.workspaceId).putContextBuildCache(entry);
  }

  recordContextFeedback(input: ContextFeedbackProposalInput): ContextFeedbackProposal {
    this.#assertHealthy();
    return this.#store(input.workspaceId).recordContextFeedback(input);
  }

  listContextFeedback(workspaceId: string, fingerprintId: string): ContextFeedbackProposal[] {
    this.#assertHealthy();
    return this.#store(workspaceId).listContextFeedback(workspaceId, fingerprintId);
  }

  getBusinessEvaluation(workspaceId: string, runId: string): BusinessEvaluationReceipt | undefined {
    this.#assertHealthy();
    return this.#store(workspaceId).getBusinessEvaluation(workspaceId, runId);
  }

  recordBusinessEvaluation(receipt: BusinessEvaluationReceipt): BusinessEvaluationReceipt {
    this.#assertHealthy();
    return this.#store(receipt.workspaceId).recordBusinessEvaluation(receipt);
  }

  listBusinessEvaluations(workspaceId: string, datasetId: string): BusinessEvaluationReceipt[] {
    this.#assertHealthy();
    return this.#store(workspaceId).listBusinessEvaluations(workspaceId, datasetId);
  }

  resolveDocumentStorage(workspaceId: string, targetPath: string): DocumentStorageResolution {
    this.#assertHealthy();
    return this.#store(workspaceId).resolveDocumentStorage(workspaceId, targetPath);
  }

  listDocumentProvenance(workspaceId: string, sourceId: string): DocumentProvenanceRecord[] {
    this.#assertHealthy();
    return this.#store(workspaceId).listDocumentProvenance(workspaceId, sourceId);
  }

  listTombstones(workspaceId: string, sourceId: string): TombstoneRecord[] {
    this.#assertHealthy();
    return this.#store(workspaceId).listTombstones(workspaceId, sourceId);
  }

  listSyncRuns(workspaceId: string, sourceId: string): SyncRunRecord[] {
    this.#assertHealthy();
    return this.#store(workspaceId).listSyncRuns(workspaceId, sourceId);
  }

  getDocumentationSource(workspaceId: string, sourceId: string): DocumentationSourceState | undefined {
    this.#assertHealthy();
    return this.#store(workspaceId).getDocumentationSource(workspaceId, sourceId);
  }

  prepareDocumentationSync(commit: DocumentationStateCommit): void {
    this.#assertHealthy();
    this.#store(commit.source.workspaceId).prepareDocumentationSync(commit);
  }

  getPendingDocumentationSync(workspaceId: string, sourceId: string): DocumentationStateCommit | undefined {
    this.#assertHealthy();
    return this.#store(workspaceId).getPendingDocumentationSync(workspaceId, sourceId);
  }

  commitDocumentationSync(commit: DocumentationStateCommit): void {
    this.#assertHealthy();
    this.#store(commit.source.workspaceId).commitDocumentationSync(commit);
  }

  getDocumentationCutover(workspaceId: string, sourceId: string): DocumentationCutoverRecord | undefined {
    this.#assertHealthy();
    return this.#store(workspaceId).getDocumentationCutover(workspaceId, sourceId);
  }

  commitDocumentationCutover(record: DocumentationCutoverRecord): void {
    this.#assertHealthy();
    this.#store(record.workspaceId).commitDocumentationCutover(record);
  }

  completeDocumentationCutover(workspaceId: string, cutoverId: string, mapRevision: string): DocumentationCutoverRecord {
    this.#assertHealthy();
    return this.#store(workspaceId).completeDocumentationCutover(workspaceId, cutoverId, mapRevision);
  }

  close(): void {
    clearInterval(this.#heartbeat);
    for (const store of this.#stores.values()) store.close();
    this.#stores.clear();
  }

  renewOwnership(): void {
    this.#assertHealthy();
    for (const store of this.#stores.values()) store.renewRuntimeOwner();
  }

  #store(workspaceId: string): SqliteScopeMapStore {
    this.#assertHealthy();
    const existing = this.#stores.get(workspaceId);
    if (existing !== undefined) return existing;
    const workspace = this.#registry.get(workspaceId);
    const store = new SqliteScopeMapStore(join(workspace.root, ".abcm", "abcm.sqlite"), {
      ...this.#options,
      runtimeOwnerTtlMs: this.#runtimeOwnerTtlMs,
    });
    this.#stores.set(workspaceId, store);
    return store;
  }

  #assertHealthy(): void {
    if (this.#ownershipError !== undefined) throw this.#ownershipError;
  }
}
