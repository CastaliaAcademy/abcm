import { createHash, randomBytes } from "node:crypto";

import { AbcmError } from "../core/errors.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type { LinkGraphEdgeType, MapRevision, ScopeNode } from "../scope-map/types.js";
import type { BuildTaskContextRequest, ContextBundle, ContextSelectionPreview, SelectionReason } from "./types.js";
import type { ContextLinkGraphSessionStore } from "./link-graph-session-store.js";

export interface ContextLinkGraphBuilder {
  preview(request: BuildTaskContextRequest, principal: ContextPrincipal, signal?: AbortSignal): Promise<ContextSelectionPreview>;
  build(request: BuildTaskContextRequest, principal: ContextPrincipal, signal?: AbortSignal): Promise<ContextBundle>;
}

export interface ContextLinkGraphScopeMap {
  getActiveRevision(workspaceId: string): MapRevision;
}

export interface ContextLinkGraphSessionOptions {
  ttlMs?: number;
  ticketTtlMs?: number;
  maxCandidates?: number;
}

export interface ContextLinkGraphSessionDependencies extends ContextLinkGraphSessionOptions {
  contextBuilder: ContextLinkGraphBuilder;
  scopeMap: ContextLinkGraphScopeMap;
  principal: ContextPrincipal;
  clock?: () => number;
  randomId?: () => string;
  randomTicket?: () => string;
  store?: ContextLinkGraphSessionStore;
}

export interface ContextLinkGraphCandidate {
  documentId: string;
  kind: string;
  title: string;
  scopeId: string;
  relativePath: string;
  checksum: string;
  tokenForecast: number;
  via: readonly {
    edgeId: string;
    edgeType: LinkGraphEdgeType;
    fromDocumentId: string;
  }[];
}

export interface ContextLinkGraphSessionView {
  sessionId: string;
  status: "active" | "cancelled";
  sequence: number;
  stateDigest: string;
  workspaceId: string;
  principalId: string;
  mapRevision: string;
  mapDigest: string;
  linkGraphDigest: string;
  linkGraphPolicyVersion: "v1";
  selectionPolicyVersion: "context-selection/v4";
  seedDocumentIds: readonly string[];
  confirmedDocumentIds: readonly string[];
  candidates: readonly ContextLinkGraphCandidate[];
  projectedTokenEstimate: number;
  lastStep?: {
    sequence: number;
    requestDigest: string;
    previousStateDigest: string;
    resultDigest: string;
    projectedTokenDelta: number;
  };
  fallbackModes: readonly ["direct-search", "explicit-documents", "bounded-resource-read"];
  createdAt: string;
  expiresAt: string;
  websocket?: {
    path: "/v1/context/link-graph/ws";
    protocols: readonly ["abcm.link-graph.v1", string, string];
    ticketExpiresAt: string;
  };
}

export interface ContextLinkGraphStartInput {
  workspaceId: string;
  request: BuildTaskContextRequest;
  seedDocumentIds?: readonly string[];
}

export type ContextLinkGraphStepOperation =
  | { kind: "expand"; fromDocumentIds: readonly string[]; edgeTypes?: readonly LinkGraphEdgeType[] | undefined }
  | { kind: "narrow"; documentIds: readonly string[] }
  | { kind: "confirm"; documentIds: readonly string[] }
  | { kind: "undo" }
  | { kind: "cancel" };

export interface ContextLinkGraphStepInput {
  sessionId: string;
  sequence: number;
  previousStateDigest: string;
  operation: ContextLinkGraphStepOperation;
}

export interface ContextLinkGraphFinalizeInput {
  sessionId: string;
  expectedStateDigest: string;
}

export interface ContextLinkGraphRetrievalReceipt {
  receiptId: string;
  receiptDigest: string;
  sessionId: string;
  workspaceId: string;
  principalId: string;
  mapRevision: string;
  mapDigest: string;
  linkGraphDigest: string;
  linkGraphPolicyVersion: "v1";
  selectionPolicyVersion: "context-selection/v4";
  sequence: number;
  stateDigest: string;
  confirmedDocumentIds: readonly string[];
  selections: readonly {
    documentId: string;
    selectionReasons: readonly SelectionReason[];
  }[];
  projectedTokenEstimate: number;
  contextBundleTokenEstimate: number;
  steps: readonly NonNullable<ContextLinkGraphSessionView["lastStep"]>[];
  contextBundleId: string;
  bundleDigest: string;
  createdAt: string;
}

export interface ContextLinkGraphFinalizeResult {
  bundle: ContextBundle;
  receipt: ContextLinkGraphRetrievalReceipt;
}

interface StateSnapshot {
  candidates: Set<string>;
  confirmed: Set<string>;
  projectedTokenEstimate: number;
}

interface SessionRecord {
  sessionId: string;
  status: "active" | "cancelled";
  sequence: number;
  stateDigest: string;
  workspaceId: string;
  principalId: string;
  principalAccessDigest: string;
  request: BuildTaskContextRequest;
  preview: ContextSelectionPreview;
  mapRevision: string;
  mapDigest: string;
  linkGraphDigest: string;
  seedDocumentIds: string[];
  candidates: Set<string>;
  confirmed: Set<string>;
  projectedTokenEstimate: number;
  lastStep?: ContextLinkGraphSessionView["lastStep"];
  history: StateSnapshot[];
  replays: Map<number, { operationDigest: string; previousStateDigest: string; view: ContextLinkGraphSessionView }>;
  createdAt: number;
  expiresAt: number;
  ticketHash: string;
  ticketExpiresAt: number;
  ticketUsed: boolean;
  retrievalReceipt?: ContextLinkGraphRetrievalReceipt;
}

interface PersistedSessionRecord {
  schemaVersion: 1;
  sessionId: string;
  status: SessionRecord["status"];
  sequence: number;
  stateDigest: string;
  workspaceId: string;
  principalId: string;
  principalAccessDigest: string;
  request: BuildTaskContextRequest;
  preview: ContextSelectionPreview;
  mapRevision: string;
  mapDigest: string;
  linkGraphDigest: string;
  seedDocumentIds: string[];
  candidates: string[];
  confirmed: string[];
  projectedTokenEstimate: number;
  lastStep?: ContextLinkGraphSessionView["lastStep"];
  history: Array<{ candidates: string[]; confirmed: string[]; projectedTokenEstimate: number }>;
  replays: Array<[number, { operationDigest: string; previousStateDigest: string; view: ContextLinkGraphSessionView }]>;
  createdAt: number;
  expiresAt: number;
  ticketHash: string;
  ticketExpiresAt: number;
  ticketUsed: boolean;
  retrievalReceipt?: ContextLinkGraphRetrievalReceipt;
}

const FALLBACK_MODES = ["direct-search", "explicit-documents", "bounded-resource-read"] as const;
const WEBSOCKET_PATH = "/v1/context/link-graph/ws" as const;
const WEBSOCKET_PROTOCOL = "abcm.link-graph.v1" as const;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function accessDigest(principal: ContextPrincipal): string {
  return digest({
    principalId: principal.principalId,
    workspacePermissions: sorted(principal.access.workspacePermissions),
    scopeGrants: Object.fromEntries(
      Object.entries(principal.access.scopeGrants ?? {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([scopeId, permissions]) => [scopeId, sorted(permissions)]),
    ),
  });
}

function hasDocumentAccess(principal: ContextPrincipal, node: ScopeNode): boolean {
  if (principal.access.workspacePermissions.includes("document.read")) return true;
  if (principal.access.scopeGrants?.[node.scopeId]?.includes("document.read") === true) return true;
  return node.aliases.some(alias => principal.access.scopeGrants?.[alias]?.includes("document.read") === true);
}

export class ContextLinkGraphSessionService {
  readonly #contextBuilder: ContextLinkGraphBuilder;
  readonly #scopeMap: ContextLinkGraphScopeMap;
  readonly #principal: ContextPrincipal;
  readonly #clock: () => number;
  readonly #randomId: () => string;
  readonly #randomTicket: () => string;
  readonly #ttlMs: number;
  readonly #ticketTtlMs: number;
  readonly #maxCandidates: number;
  readonly #store: ContextLinkGraphSessionStore | undefined;
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(dependencies: ContextLinkGraphSessionDependencies) {
    this.#contextBuilder = dependencies.contextBuilder;
    this.#scopeMap = dependencies.scopeMap;
    this.#principal = dependencies.principal;
    this.#clock = dependencies.clock ?? Date.now;
    this.#randomId = dependencies.randomId ?? (() => randomBytes(12).toString("hex"));
    this.#randomTicket = dependencies.randomTicket ?? (() => randomBytes(32).toString("base64url"));
    this.#ttlMs = dependencies.ttlMs ?? 15 * 60_000;
    this.#ticketTtlMs = dependencies.ticketTtlMs ?? 60_000;
    this.#maxCandidates = dependencies.maxCandidates ?? 256;
    this.#store = dependencies.store;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs <= 0) throw new Error("Context link-graph session ttlMs must be positive.");
    if (!Number.isSafeInteger(this.#ticketTtlMs) || this.#ticketTtlMs <= 0 || this.#ticketTtlMs > this.#ttlMs) {
      throw new Error("Context link-graph ticketTtlMs must be positive and no greater than ttlMs.");
    }
    if (!Number.isSafeInteger(this.#maxCandidates) || this.#maxCandidates <= 0) throw new Error("Context link-graph maxCandidates must be positive.");
    for (const stored of this.#store?.list() ?? []) {
      if (stored.expiresAt <= this.#clock()) {
        this.#store?.delete(stored.sessionId);
        continue;
      }
      const session = this.#deserialize(stored.payload);
      if (session.sessionId !== stored.sessionId || session.expiresAt !== stored.expiresAt) {
        throw new AbcmError("DERIVED_STORE_CORRUPT", "Context link-graph session store identity is inconsistent.");
      }
      this.#sessions.set(session.sessionId, session);
    }
  }

  async start(input: ContextLinkGraphStartInput, signal?: AbortSignal): Promise<ContextLinkGraphSessionView> {
    const preview = await this.#contextBuilder.preview(input.request, this.#principal, signal);
    const revision = this.#scopeMap.getActiveRevision(input.workspaceId);
    if (preview.workspaceId !== input.workspaceId || revision.revision !== preview.mapRevision || revision.digest !== preview.mapDigest) {
      throw new AbcmError("ACCESS_DENIED", "Context preview does not belong to the requested workspace revision.");
    }
    const accessible = this.#accessibleDocumentIds(revision);
    const requestedSeeds = input.seedDocumentIds ?? preview.selectedDocuments.map(document => document.documentId);
    const seedDocumentIds = sorted(requestedSeeds.filter(documentId => accessible.has(documentId)));
    if (requestedSeeds.some(documentId => !accessible.has(documentId))) {
      throw new AbcmError("CONTEXT_DOCUMENT_ACCESS_DENIED", "A requested graph seed is not accessible.");
    }
    const now = this.#clock();
    const ticket = this.#randomTicket();
    const sessionId = `graph-session-${this.#randomId()}`;
    const initialCandidates = this.#neighbors(revision, seedDocumentIds, accessible);
    for (const documentId of seedDocumentIds) initialCandidates.delete(documentId);
    const session: SessionRecord = {
      sessionId,
      status: "active",
      sequence: 0,
      stateDigest: "",
      workspaceId: input.workspaceId,
      principalId: this.#principal.principalId,
      principalAccessDigest: accessDigest(this.#principal),
      request: input.request,
      preview,
      mapRevision: revision.revision,
      mapDigest: revision.digest,
      linkGraphDigest: revision.linkGraph.digest,
      seedDocumentIds,
      candidates: initialCandidates,
      confirmed: new Set<string>(),
      projectedTokenEstimate: preview.tokenEstimate,
      history: [],
      replays: new Map(),
      createdAt: now,
      expiresAt: now + this.#ttlMs,
      ticketHash: digest(ticket),
      ticketExpiresAt: now + this.#ticketTtlMs,
      ticketUsed: false,
    };
    session.stateDigest = this.#stateDigest(session);
    this.#sessions.set(sessionId, session);
    this.#persist(session);
    return this.#view(session, revision, { ticket });
  }

  get(sessionId: string): ContextLinkGraphSessionView {
    const session = this.#session(sessionId);
    const revision = this.#validateActive(session);
    return this.#view(session, revision);
  }

  async step(input: ContextLinkGraphStepInput, signal?: AbortSignal): Promise<ContextLinkGraphSessionView> {
    const session = this.#session(input.sessionId);
    const revision = this.#validateActive(session);
    const operationDigest = digest(input.operation);
    const replay = session.replays.get(input.sequence);
    if (replay !== undefined) {
      if (replay.operationDigest !== operationDigest || input.previousStateDigest !== replay.previousStateDigest) {
        throw new AbcmError("CONTEXT_GRAPH_SEQUENCE_CONFLICT", "Graph session sequence was reused with different state or operation.");
      }
      return replay.view;
    }
    if (session.status !== "active") throw new AbcmError("CONTEXT_GRAPH_SESSION_STALE", "Graph session is not active.");
    if (input.sequence !== session.sequence + 1 || input.previousStateDigest !== session.stateDigest) {
      throw new AbcmError("CONTEXT_GRAPH_SEQUENCE_CONFLICT", "Graph session sequence or previous state digest does not match.");
    }
    const accessible = this.#accessibleDocumentIds(revision);
    const before = {
      candidates: new Set(session.candidates),
      confirmed: new Set(session.confirmed),
      projectedTokenEstimate: session.projectedTokenEstimate,
    };
    const historyLength = session.history.length;
    const previousLastStep = session.lastStep;
    session.history.push(before);
    try {
      if (input.operation.kind === "expand") {
        const visible = new Set([...session.seedDocumentIds, ...session.candidates, ...session.confirmed]);
        if (input.operation.fromDocumentIds.some(documentId => !visible.has(documentId))) {
          throw new AbcmError("CONTEXT_GRAPH_SEQUENCE_CONFLICT", "Graph expansion source is not present in the visible session state.");
        }
        const additions = this.#neighbors(revision, input.operation.fromDocumentIds, accessible, input.operation.edgeTypes);
        for (const documentId of session.seedDocumentIds) additions.delete(documentId);
        for (const documentId of additions) session.candidates.add(documentId);
        if (session.candidates.size > this.#maxCandidates) {
          session.candidates = new Set(sorted(session.candidates).slice(0, this.#maxCandidates));
        }
      } else if (input.operation.kind === "narrow") {
        if (input.operation.documentIds.some(documentId => !session.candidates.has(documentId))) {
          throw new AbcmError("CONTEXT_GRAPH_SEQUENCE_CONFLICT", "Graph narrowing can only retain visible candidates.");
        }
        session.candidates = new Set(sorted(input.operation.documentIds));
        for (const documentId of [...session.confirmed]) if (!session.candidates.has(documentId)) session.confirmed.delete(documentId);
      } else if (input.operation.kind === "confirm") {
        if (input.operation.documentIds.some(documentId => !session.candidates.has(documentId) || !accessible.has(documentId))) {
          throw new AbcmError("CONTEXT_DOCUMENT_ACCESS_DENIED", "Only accessible visible graph candidates can be confirmed.");
        }
        for (const documentId of input.operation.documentIds) session.confirmed.add(documentId);
        if ((session.request.explicitDocuments?.length ?? 0) + session.confirmed.size > 64) {
          throw new AbcmError("CONTEXT_CONFIGURATION_INVALID", "Graph session confirmation exceeds the 64-document explicit selector limit.");
        }
      } else if (input.operation.kind === "undo") {
        session.history.pop();
        const previous = session.history.pop();
        if (previous === undefined) throw new AbcmError("CONTEXT_GRAPH_SEQUENCE_CONFLICT", "Graph session has no operation to undo.");
        session.candidates = previous.candidates;
        session.confirmed = previous.confirmed;
        session.projectedTokenEstimate = previous.projectedTokenEstimate;
      } else {
        session.status = "cancelled";
      }
      if (
        input.operation.kind !== "expand" &&
        input.operation.kind !== "cancel" &&
        input.operation.kind !== "undo" &&
        sorted(before.confirmed).join("\0") !== sorted(session.confirmed).join("\0")
      ) {
        const projected = await this.#contextBuilder.preview(this.#requestWithConfirmed(session), this.#principal, signal);
        if (projected.mapRevision !== session.mapRevision || projected.mapDigest !== session.mapDigest) {
          throw new AbcmError("CONTEXT_GRAPH_SESSION_STALE", "Context projection changed revisions during a graph step.");
        }
        session.projectedTokenEstimate = projected.tokenEstimate;
      }
    } catch (error) {
      session.history.length = historyLength;
      session.candidates = before.candidates;
      session.confirmed = before.confirmed;
      session.projectedTokenEstimate = before.projectedTokenEstimate;
      session.lastStep = previousLastStep;
      throw error;
    }
    session.sequence = input.sequence;
    session.stateDigest = this.#stateDigest(session);
    session.lastStep = {
      sequence: input.sequence,
      requestDigest: operationDigest,
      previousStateDigest: input.previousStateDigest,
      resultDigest: session.stateDigest,
      projectedTokenDelta: session.projectedTokenEstimate - before.projectedTokenEstimate,
    };
    const view = this.#view(session, revision);
    session.replays.set(input.sequence, { operationDigest, previousStateDigest: input.previousStateDigest, view });
    this.#persist(session);
    return view;
  }

  async finalize(input: ContextLinkGraphFinalizeInput, signal?: AbortSignal): Promise<ContextLinkGraphFinalizeResult> {
    const session = this.#session(input.sessionId);
    this.#validateActive(session);
    if (session.status !== "active" || session.stateDigest !== input.expectedStateDigest) {
      throw new AbcmError("CONTEXT_GRAPH_SEQUENCE_CONFLICT", "Graph session state changed before finalization.");
    }
    const bundle = await this.#contextBuilder.build(this.#requestWithConfirmed(session), this.#principal, signal);
    if (session.retrievalReceipt !== undefined && session.retrievalReceipt.bundleDigest !== bundle.bundleDigest) {
      throw new AbcmError("CONTEXT_GRAPH_SESSION_STALE", "Repeated graph finalization produced a different bundle digest.");
    }
    if (session.retrievalReceipt === undefined) {
      const createdAt = new Date(this.#clock()).toISOString();
      const receiptBody = {
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        principalId: session.principalId,
        mapRevision: session.mapRevision,
        mapDigest: session.mapDigest,
        linkGraphDigest: session.linkGraphDigest,
        linkGraphPolicyVersion: "v1" as const,
        selectionPolicyVersion: session.preview.selectionPolicyVersion,
        sequence: session.sequence,
        stateDigest: session.stateDigest,
        confirmedDocumentIds: sorted(session.confirmed),
        selections: sorted(session.confirmed).map(documentId => {
          const selected = bundle.selectedDocuments.find(document => document.documentId === documentId);
          if (selected === undefined) {
            throw new AbcmError("CONTEXT_GRAPH_SESSION_STALE", "A confirmed graph document is absent from the finalized ContextBundle.");
          }
          return { documentId, selectionReasons: selected.selectionReasons };
        }),
        projectedTokenEstimate: session.projectedTokenEstimate,
        contextBundleTokenEstimate: bundle.tokenEstimate,
        steps: [...session.replays.values()].map(replay => replay.view.lastStep!).filter(Boolean),
        contextBundleId: bundle.contextBundleId,
        bundleDigest: bundle.bundleDigest,
        createdAt,
      };
      const receiptDigest = digest(receiptBody);
      session.retrievalReceipt = {
        receiptId: `graph-receipt-${receiptDigest.slice("sha256:".length, "sha256:".length + 24)}`,
        receiptDigest,
        ...receiptBody,
      };
      this.#persist(session);
    }
    return { bundle, receipt: session.retrievalReceipt };
  }

  issueWebSocketTicket(input: ContextLinkGraphFinalizeInput): ContextLinkGraphSessionView {
    const session = this.#session(input.sessionId);
    const revision = this.#validateActive(session);
    if (session.status !== "active" || session.stateDigest !== input.expectedStateDigest) {
      throw new AbcmError("CONTEXT_GRAPH_SEQUENCE_CONFLICT", "Graph session state changed before WebSocket ticket issuance.");
    }
    const ticket = this.#randomTicket();
    session.ticketHash = digest(ticket);
    session.ticketExpiresAt = Math.min(session.expiresAt, this.#clock() + this.#ticketTtlMs);
    session.ticketUsed = false;
    this.#persist(session);
    return this.#view(session, revision, { ticket });
  }

  consumeWebSocketTicket(sessionId: string, ticket: string): ContextLinkGraphSessionView {
    const session = this.#session(sessionId);
    const revision = this.#validateActive(session);
    if (session.status !== "active" || session.ticketUsed || this.#clock() > session.ticketExpiresAt || digest(ticket) !== session.ticketHash) {
      throw new AbcmError("CONTEXT_GRAPH_TICKET_INVALID", "Graph session WebSocket ticket is invalid, expired, or already used.");
    }
    session.ticketUsed = true;
    this.#persist(session);
    return this.#view(session, revision);
  }

  #session(sessionId: string): SessionRecord {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new AbcmError("CONTEXT_GRAPH_SESSION_NOT_FOUND", "Graph session was not found.");
    if (this.#clock() > session.expiresAt) {
      this.#sessions.delete(sessionId);
      this.#store?.delete(sessionId);
      throw new AbcmError("CONTEXT_GRAPH_SESSION_EXPIRED", "Graph session expired.");
    }
    if (session.principalId !== this.#principal.principalId || session.principalAccessDigest !== accessDigest(this.#principal)) {
      throw new AbcmError("ACCESS_DENIED", "Graph session principal binding does not match.");
    }
    return session;
  }

  #validateActive(session: SessionRecord): MapRevision {
    const revision = this.#scopeMap.getActiveRevision(session.workspaceId);
    if (
      revision.revision !== session.mapRevision ||
      revision.digest !== session.mapDigest ||
      revision.linkGraph.digest !== session.linkGraphDigest ||
      revision.linkGraph.policyVersion !== "v1"
    ) {
      throw new AbcmError("CONTEXT_GRAPH_SESSION_STALE", "Graph session is pinned to an older ScopeMap or link-graph policy.");
    }
    return revision;
  }

  #accessibleDocumentIds(revision: MapRevision): Set<string> {
    const nodes = new Map(revision.nodes.map(node => [node.scopeId, node]));
    return new Set(revision.documents
      .filter(document => {
        const node = nodes.get(document.scopeId);
        return node !== undefined && hasDocumentAccess(this.#principal, node);
      })
      .map(document => document.documentId));
  }

  #neighbors(
    revision: MapRevision,
    fromDocumentIds: readonly string[],
    accessible: ReadonlySet<string>,
    edgeTypes?: readonly LinkGraphEdgeType[],
  ): Set<string> {
    const from = new Set(fromDocumentIds);
    const allowedTypes = edgeTypes === undefined ? undefined : new Set(edgeTypes);
    const candidates = new Set<string>();
    for (const edge of revision.linkGraph.edges) {
      if (
        edge.status !== "resolved" ||
        edge.toDocumentId === undefined ||
        !from.has(edge.fromDocumentId) ||
        !accessible.has(edge.toDocumentId) ||
        allowedTypes?.has(edge.type) === false
      ) continue;
      candidates.add(edge.toDocumentId);
    }
    if (allowedTypes === undefined || allowedTypes.has("tag")) {
      for (const tagPackage of revision.linkGraph.tagPackages ?? []) {
        if (!tagPackage.documentIds.some(documentId => from.has(documentId))) continue;
        for (const documentId of tagPackage.documentIds) {
          if (!from.has(documentId) && accessible.has(documentId)) candidates.add(documentId);
        }
      }
    }
    return new Set(sorted(candidates).slice(0, this.#maxCandidates));
  }

  #stateDigest(session: SessionRecord): string {
    return digest({
      sessionId: session.sessionId,
      status: session.status,
      sequence: session.sequence,
      workspaceId: session.workspaceId,
      principalAccessDigest: session.principalAccessDigest,
      mapRevision: session.mapRevision,
      linkGraphDigest: session.linkGraphDigest,
      seeds: session.seedDocumentIds,
      candidates: sorted(session.candidates),
      confirmed: sorted(session.confirmed),
      projectedTokenEstimate: session.projectedTokenEstimate,
    });
  }

  #view(session: SessionRecord, revision: MapRevision, websocket?: { ticket: string }): ContextLinkGraphSessionView {
    const candidates = sorted(session.candidates).map(documentId => {
      const document = revision.documents.find(candidate => candidate.documentId === documentId)!;
      const file = revision.files.find(candidate => candidate.relativePath === document.relativePath);
      const edgeVia = revision.linkGraph.edges
        .filter(edge => edge.status === "resolved" && edge.toDocumentId === documentId && (
          session.seedDocumentIds.includes(edge.fromDocumentId) ||
          session.candidates.has(edge.fromDocumentId) ||
          session.confirmed.has(edge.fromDocumentId)
        ))
        .map(edge => ({ edgeId: edge.edgeId, edgeType: edge.type, fromDocumentId: edge.fromDocumentId }))
        .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
      const visible = new Set([...session.seedDocumentIds, ...session.candidates, ...session.confirmed]);
      const tagVia = (revision.linkGraph.tagPackages ?? []).flatMap(tagPackage => {
        if (!tagPackage.documentIds.includes(documentId)) return [];
        const fromDocumentId = tagPackage.documentIds.find(candidate => candidate !== documentId && visible.has(candidate));
        return fromDocumentId === undefined ? [] : [{
          edgeId: `tag:${tagPackage.packageId}:${fromDocumentId}:${documentId}`,
          edgeType: "tag" as const,
          fromDocumentId,
        }];
      });
      const via = [...edgeVia, ...tagVia].sort((left, right) => left.edgeId.localeCompare(right.edgeId));
      return {
        documentId: document.documentId,
        kind: document.kind,
        title: document.title,
        scopeId: document.scopeId,
        relativePath: document.relativePath,
        checksum: document.checksum,
        tokenForecast: Math.max(1, Math.ceil((file?.size ?? 0) / 4)),
        via,
      };
    });
    return {
      sessionId: session.sessionId,
      status: session.status,
      sequence: session.sequence,
      stateDigest: session.stateDigest,
      workspaceId: session.workspaceId,
      principalId: session.principalId,
      mapRevision: session.mapRevision,
      mapDigest: session.mapDigest,
      linkGraphDigest: session.linkGraphDigest,
      linkGraphPolicyVersion: "v1",
      selectionPolicyVersion: session.preview.selectionPolicyVersion,
      seedDocumentIds: session.seedDocumentIds,
      confirmedDocumentIds: sorted(session.confirmed),
      candidates,
      projectedTokenEstimate: session.projectedTokenEstimate,
      ...(session.lastStep === undefined ? {} : { lastStep: session.lastStep }),
      fallbackModes: FALLBACK_MODES,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      ...(websocket === undefined ? {} : {
        websocket: {
          path: WEBSOCKET_PATH,
          protocols: [
            WEBSOCKET_PROTOCOL,
            `abcm.session.${session.sessionId}`,
            `abcm.ticket.${websocket.ticket}`,
          ],
          ticketExpiresAt: new Date(session.ticketExpiresAt).toISOString(),
        },
      }),
    };
  }

  #requestWithConfirmed(session: SessionRecord): BuildTaskContextRequest {
    const existing = session.request.explicitDocuments ?? [];
    const existingIds = new Set(existing.filter(reference => reference.selector === "document-id").map(reference => reference.documentId));
    const confirmed = sorted(session.confirmed)
      .filter(documentId => !existingIds.has(documentId))
      .map(documentId => ({ selector: "document-id" as const, documentId }));
    return {
      ...session.request,
      ...(existing.length + confirmed.length === 0 ? {} : { explicitDocuments: [...existing, ...confirmed] }),
    };
  }

  #persist(session: SessionRecord): void {
    const payload: PersistedSessionRecord = {
      schemaVersion: 1,
      sessionId: session.sessionId,
      status: session.status,
      sequence: session.sequence,
      stateDigest: session.stateDigest,
      workspaceId: session.workspaceId,
      principalId: session.principalId,
      principalAccessDigest: session.principalAccessDigest,
      request: session.request,
      preview: session.preview,
      mapRevision: session.mapRevision,
      mapDigest: session.mapDigest,
      linkGraphDigest: session.linkGraphDigest,
      seedDocumentIds: session.seedDocumentIds,
      candidates: sorted(session.candidates),
      confirmed: sorted(session.confirmed),
      projectedTokenEstimate: session.projectedTokenEstimate,
      ...(session.lastStep === undefined ? {} : { lastStep: session.lastStep }),
      history: session.history.map(snapshot => ({
        candidates: sorted(snapshot.candidates),
        confirmed: sorted(snapshot.confirmed),
        projectedTokenEstimate: snapshot.projectedTokenEstimate,
      })),
      replays: [...session.replays.entries()].sort(([left], [right]) => left - right),
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      ticketHash: session.ticketHash,
      ticketExpiresAt: session.ticketExpiresAt,
      ticketUsed: session.ticketUsed,
      ...(session.retrievalReceipt === undefined ? {} : { retrievalReceipt: session.retrievalReceipt }),
    };
    this.#store?.put({ sessionId: session.sessionId, expiresAt: session.expiresAt, payload });
  }

  #deserialize(value: unknown): SessionRecord {
    if (typeof value !== "object" || value === null || (value as { schemaVersion?: unknown }).schemaVersion !== 1) {
      throw new AbcmError("DERIVED_STORE_CORRUPT", "Context link-graph session store contains an unsupported payload.");
    }
    const stored = value as PersistedSessionRecord;
    if (
      typeof stored.sessionId !== "string" ||
      typeof stored.workspaceId !== "string" ||
      typeof stored.principalId !== "string" ||
      typeof stored.stateDigest !== "string" ||
      !Number.isSafeInteger(stored.sequence) ||
      !Array.isArray(stored.candidates) ||
      !Array.isArray(stored.confirmed) ||
      !Array.isArray(stored.history) ||
      !Array.isArray(stored.replays)
    ) {
      throw new AbcmError("DERIVED_STORE_CORRUPT", "Context link-graph session store payload is invalid.");
    }
    return {
      sessionId: stored.sessionId,
      status: stored.status,
      sequence: stored.sequence,
      stateDigest: stored.stateDigest,
      workspaceId: stored.workspaceId,
      principalId: stored.principalId,
      principalAccessDigest: stored.principalAccessDigest,
      request: stored.request,
      preview: stored.preview,
      mapRevision: stored.mapRevision,
      mapDigest: stored.mapDigest,
      linkGraphDigest: stored.linkGraphDigest,
      seedDocumentIds: stored.seedDocumentIds,
      candidates: new Set(stored.candidates),
      confirmed: new Set(stored.confirmed),
      projectedTokenEstimate: stored.projectedTokenEstimate,
      ...(stored.lastStep === undefined ? {} : { lastStep: stored.lastStep }),
      history: stored.history.map(snapshot => ({
        candidates: new Set(snapshot.candidates),
        confirmed: new Set(snapshot.confirmed),
        projectedTokenEstimate: snapshot.projectedTokenEstimate,
      })),
      replays: new Map(stored.replays),
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
      ticketHash: stored.ticketHash,
      ticketExpiresAt: stored.ticketExpiresAt,
      ticketUsed: stored.ticketUsed,
      ...(stored.retrievalReceipt === undefined ? {} : { retrievalReceipt: stored.retrievalReceipt }),
    };
  }
}
