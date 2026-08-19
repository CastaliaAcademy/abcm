import { createHash } from "node:crypto";

import type { ContextPrincipal } from "../domain-language/types.js";
import type { ConnectedSkillRecord } from "../skills/types.js";
import type { MapRevision } from "../scope-map/types.js";
import type {
  BuildTaskContextRequest,
  ContextBuildCacheMetadata,
  ContextBundle,
  ContextFingerprint,
  MaterializedDocumentProjection,
  SelectedContextDocument,
} from "./types.js";

export const CONTEXT_BUILD_CACHE_POLICY_VERSION = "context-build-cache/v1" as const;
export const DOCUMENT_PROJECTION_POLICY_VERSION = "document-projection/v1" as const;

export interface ContextBuildCacheIdentity {
  workspaceId: string;
  projectId: string;
  principalId: string;
  principalAccessDigest: string;
  workspaceSnapshotDigest: string;
  mapRevision: string;
  requestDigest: string;
  selectionPolicyVersion: string;
  projectionPolicyVersion: typeof DOCUMENT_PROJECTION_POLICY_VERSION;
  cachePolicyVersion: typeof CONTEXT_BUILD_CACHE_POLICY_VERSION;
  keyDigest: string;
  familyDigest: string;
}

export interface ContextBuildCacheEntry {
  identity: ContextBuildCacheIdentity;
  bundle: ContextBuildCacheBundle;
  fingerprint: ContextFingerprint;
}

export type CachedContextDocument = Omit<SelectedContextDocument, "projection"> & {
  projection: Omit<MaterializedDocumentProjection, "content">;
};

export type CachedConnectedSkill = Omit<ConnectedSkillRecord, "body"> & {
  relativePath: string;
};

export type ContextBuildCacheBundle = Omit<
  ContextBundle,
  "cache" | "contextFingerprintLocation" | "selectedDocuments" | "connectedSkills"
> & {
  selectedDocuments: readonly CachedContextDocument[];
  connectedSkills: readonly CachedConnectedSkill[];
};

export interface ContextBuildCacheCatalog {
  lookupContextBuildCache(identity: ContextBuildCacheIdentity): { state: "hit"; entry: ContextBuildCacheEntry } | { state: "miss" | "stale" };
  putContextBuildCache(entry: ContextBuildCacheEntry): void;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

export function createContextBuildCacheIdentity(input: {
  request: BuildTaskContextRequest;
  principal: ContextPrincipal;
  revision: MapRevision;
  workspaceId: string;
  projectId: string;
  budgetProfile: string;
  domainLanguageBootstrapDigest: string;
  selectionPolicyVersion: string;
}): ContextBuildCacheIdentity {
  const { domainLanguageBootstrapId: _bootstrapId, ...semanticRequest } = input.request;
  const principalAccessDigest = digest(input.principal.access);
  const requestDigest = digest({ ...semanticRequest, budgetProfile: input.budgetProfile });
  const common = {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    principalId: input.principal.principalId,
    principalAccessDigest,
    requestDigest,
    selectionPolicyVersion: input.selectionPolicyVersion,
    projectionPolicyVersion: DOCUMENT_PROJECTION_POLICY_VERSION,
    cachePolicyVersion: CONTEXT_BUILD_CACHE_POLICY_VERSION,
  };
  const workspaceSnapshotDigest = input.revision.digest;
  return {
    ...common,
    workspaceSnapshotDigest,
    mapRevision: input.revision.revision,
    keyDigest: digest({ ...common, workspaceSnapshotDigest, mapRevision: input.revision.revision, domainLanguageBootstrapDigest: input.domainLanguageBootstrapDigest }),
    familyDigest: digest(common),
  };
}

export function contextBuildCacheMetadata(identity: ContextBuildCacheIdentity, state: ContextBuildCacheMetadata["state"]): ContextBuildCacheMetadata {
  return {
    state,
    policyVersion: CONTEXT_BUILD_CACHE_POLICY_VERSION,
    projectionPolicyVersion: DOCUMENT_PROJECTION_POLICY_VERSION,
    keyDigest: identity.keyDigest,
    workspaceSnapshotDigest: identity.workspaceSnapshotDigest,
    principalAccessDigest: identity.principalAccessDigest,
  };
}

export class MemoryContextBuildCacheCatalog implements ContextBuildCacheCatalog {
  readonly #entries = new Map<string, ContextBuildCacheEntry>();

  lookupContextBuildCache(identity: ContextBuildCacheIdentity) {
    const entry = this.#entries.get(identity.keyDigest);
    if (entry !== undefined) return { state: "hit" as const, entry };
    return { state: [...this.#entries.values()].some(candidate => candidate.identity.familyDigest === identity.familyDigest) ? "stale" as const : "miss" as const };
  }

  putContextBuildCache(entry: ContextBuildCacheEntry): void {
    this.#entries.set(entry.identity.keyDigest, entry);
  }
}
