import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { ContextLinkGraphSessionService } from "../src/context/link-graph-session.js";
import {
  ContextLinkGraphWebSocketAdapter,
} from "../src/context/link-graph-websocket.js";
import { SqliteContextLinkGraphSessionStore } from "../src/context/link-graph-session-store.js";
import type { BuildTaskContextRequest, ContextBundle, ContextSelectionPreview } from "../src/context/types.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";
import type { MapRevision } from "../src/scope-map/types.js";

const request: BuildTaskContextRequest = {
  domainLanguageBootstrapId: "bootstrap-1",
  roleId: "agent",
  taskType: "implementation",
  goal: "Change the public service",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const preview: ContextSelectionPreview = {
  previewDigest: "sha256:preview",
    selectionPolicyVersion: "context-selection/v4",
  workspaceId: "workspace",
  mapRevision: "sha256:map",
  mapDigest: "sha256:map",
  primaryTargetScope: "public",
  affectedScopes: ["public"],
  contextMode: "balanced",
  budgetProfile: "default",
  budget: { softLimitTokens: 1000, hardLimitTokens: 2000 },
  budgetAllocation: [],
  selectedDocuments: [{
    documentId: "DOC-A",
    scopeId: "public",
    relativePath: "project/public/A.md",
    checksum: "sha256:a",
    mandatory: false,
    selectionStage: "background_fallback",
    effectivePriority: 10,
    selectionReasons: ["target_scope"],
    projection: {
      mode: "full",
      authoritative: true,
      sourceDocumentId: "DOC-A",
      sourceChecksum: "sha256:a",
    },
    tokenEstimate: 20,
  }],
  omissions: [],
  warnings: [],
  tokenEstimate: 20,
  fallbackModes: ["direct-search", "explicit-documents", "bounded-resource-read"],
  cache: {
    state: "miss",
    policyVersion: "context-build-cache/v1",
    projectionPolicyVersion: "document-projection/v1",
    keyDigest: "sha256:key",
    workspaceSnapshotDigest: "sha256:snapshot",
    principalAccessDigest: "sha256:access",
  },
};

function revision(): MapRevision {
  const documents = [
    ["DOC-A", "public", "A.md", "sha256:a"],
    ["DOC-B", "public", "B.md", "sha256:b"],
    ["DOC-C", "public", "C.md", "sha256:c"],
    ["DOC-X", "private", "X.md", "sha256:x"],
  ] as const;
  const nodes = documents.map(([documentId, scopeId, path, checksum]) => ({
    nodeId: `document:${documentId}`,
    documentId,
    scopeId,
    relativePath: `project/${scopeId}/${path}`,
    checksum,
    title: documentId,
    aliases: [],
    headings: [],
    blocks: [],
  }));
  const forward = [
    ["edge-ab", "DOC-A", "DOC-B"],
    ["edge-ax", "DOC-A", "DOC-X"],
    ["edge-bc", "DOC-B", "DOC-C"],
  ] as const;
  return {
    revision: "sha256:map",
    digest: "sha256:map",
    createdAt: "2026-08-20T00:00:00.000Z",
    nodes: [
      { scopeId: "workflow", kind: "workflow", name: "Workflow", aliases: [], relativePath: "", rank: 0, status: "valid", readiness: "ready" },
      { scopeId: "project", kind: "project", name: "Project", aliases: [], relativePath: "project", parentScopeId: "workflow", rank: 1, status: "valid", readiness: "ready" },
      { scopeId: "public", kind: "service", name: "Public", aliases: [], relativePath: "project/public", parentScopeId: "project", rank: 2, status: "valid", readiness: "ready" },
      { scopeId: "private", kind: "service", name: "Private", aliases: [], relativePath: "project/private", parentScopeId: "project", rank: 2, status: "valid", readiness: "ready" },
    ],
    relations: [],
    files: documents.map(([documentId, scopeId, path, checksum], index) => ({
      scopeId,
      relativePath: `project/${scopeId}/${path}`,
      size: 80 + index * 4,
      mtime: 1,
      checksum,
      parseStatus: "parsed" as const,
      classification: "context_document" as const,
      storageMode: "managed" as const,
    })),
    documents: documents.map(([documentId, scopeId, path, checksum]) => ({
      documentId,
      kind: "adr",
      title: documentId,
      scopeId,
      relativePath: `project/${scopeId}/${path}`,
      checksum,
      lifecycle: "active",
      requiredSelectors: [],
      roleSelectors: [],
      taskSelectors: [],
      links: [],
      contextPolicy: "default",
      storageMode: "managed",
    })),
    executableResources: [],
    skills: [],
    linkGraph: {
      apiVersion: "abcm/link-graph/v1",
      policyVersion: "v1",
      digest: "sha256:graph",
      nodes,
      edges: forward.map(([edgeId, from, to]) => ({
        edgeId,
        type: "wiki-link" as const,
        fromNodeId: `document:${from}`,
        fromDocumentId: from,
        toNodeId: `document:${to}`,
        toDocumentId: to,
        sourcePath: nodes.find(node => node.documentId === from)!.relativePath,
        sourceLine: 1,
        sourceKind: "body" as const,
        reference: { rawTarget: to, documentTarget: to },
        status: "resolved" as const,
      })),
    },
    diagnostics: [],
  };
}

const principal: ContextPrincipal = {
  principalId: "agent-1",
  access: {
    workspacePermissions: ["context.build"],
    scopeGrants: { public: ["document.read"] },
  },
};

describe("ContextLinkGraphSessionService", () => {
  test("keeps the frontier access-first, deterministic, sequenced, and idempotent", async () => {
    let active = revision();
    const contextBuilder = {
      preview: async () => preview,
      build: async () => ({ bundleDigest: "sha256:bundle" }) as ContextBundle,
    };
    const service = new ContextLinkGraphSessionService({
      contextBuilder,
      scopeMap: { getActiveRevision: () => active },
      principal,
      clock: () => Date.parse("2026-08-20T00:00:00.000Z"),
      randomId: () => "0123456789abcdef01234567",
    });

    await expect(service.start({ workspaceId: "byte-identical-other-workspace", request }))
      .rejects.toMatchObject({ code: "ACCESS_DENIED" });

    const started = await service.start({ workspaceId: "workspace", request });
    expect(started.sequence).toBe(0);
    expect(started.seedDocumentIds).toEqual(["DOC-A"]);
    expect(started.candidates.map(candidate => candidate.documentId)).toEqual(["DOC-B"]);
    expect(JSON.stringify(started)).not.toContain("DOC-X");
    expect(started.fallbackModes).toEqual(["direct-search", "explicit-documents", "bounded-resource-read"]);

    const confirmed = await service.step({
      sessionId: started.sessionId,
      sequence: 1,
      previousStateDigest: started.stateDigest,
      operation: { kind: "confirm", documentIds: ["DOC-B"] },
    });
    expect(confirmed.confirmedDocumentIds).toEqual(["DOC-B"]);
    expect(confirmed.candidates.map(candidate => candidate.documentId)).toEqual(["DOC-B"]);
    expect(confirmed.projectedTokenEstimate).toBe(20);
    expect(confirmed.lastStep).toEqual(expect.objectContaining({
      sequence: 1,
      previousStateDigest: started.stateDigest,
      resultDigest: confirmed.stateDigest,
      projectedTokenDelta: 0,
      requestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    }));
    expect(await service.step({
      sessionId: started.sessionId,
      sequence: 1,
      previousStateDigest: started.stateDigest,
      operation: { kind: "confirm", documentIds: ["DOC-B"] },
    })).toEqual(confirmed);
    await expect(service.step({
      sessionId: started.sessionId,
      sequence: 1,
      previousStateDigest: started.stateDigest,
      operation: { kind: "narrow", documentIds: ["DOC-B"] },
    })).rejects.toMatchObject({ code: "CONTEXT_GRAPH_SEQUENCE_CONFLICT" });

    const expanded = await service.step({
      sessionId: started.sessionId,
      sequence: 2,
      previousStateDigest: confirmed.stateDigest,
      operation: { kind: "expand", fromDocumentIds: ["DOC-B"] },
    });
    expect(expanded.candidates.map(candidate => candidate.documentId)).toEqual(["DOC-B", "DOC-C"]);

    const narrowed = await service.step({
      sessionId: started.sessionId,
      sequence: 3,
      previousStateDigest: expanded.stateDigest,
      operation: { kind: "narrow", documentIds: ["DOC-C"] },
    });
    expect(narrowed.candidates.map(candidate => candidate.documentId)).toEqual(["DOC-C"]);
    expect(narrowed.confirmedDocumentIds).toEqual([]);
    const undone = await service.step({
      sessionId: started.sessionId,
      sequence: 4,
      previousStateDigest: narrowed.stateDigest,
      operation: { kind: "undo" },
    });
    expect(undone.sequence).toBe(4);
    expect(undone.confirmedDocumentIds).toEqual(["DOC-B"]);
    expect(undone.candidates.map(candidate => candidate.documentId)).toEqual(["DOC-B", "DOC-C"]);

    active = { ...active, revision: "sha256:new-map", digest: "sha256:new-map" };
    await expect(service.step({
      sessionId: started.sessionId,
      sequence: 5,
      previousStateDigest: undone.stateDigest,
      operation: { kind: "cancel" },
    })).rejects.toMatchObject({ code: "CONTEXT_GRAPH_SESSION_STALE" });
  });

  test("cancels without building and invalidates a changed principal access revision", async () => {
    let builds = 0;
    const mutableAccess = {
      workspacePermissions: ["context.build"],
      scopeGrants: { public: ["document.read"] },
    };
    const localPrincipal = { principalId: "mutable-agent", access: mutableAccess } as ContextPrincipal;
    const service = new ContextLinkGraphSessionService({
      contextBuilder: {
        preview: async () => preview,
        build: async () => {
          builds++;
          return {} as ContextBundle;
        },
      },
      scopeMap: { getActiveRevision: () => revision() },
      principal: localPrincipal,
    });
    const cancelledStart = await service.start({ workspaceId: "workspace", request });
    const cancelled = await service.step({
      sessionId: cancelledStart.sessionId,
      sequence: 1,
      previousStateDigest: cancelledStart.stateDigest,
      operation: { kind: "cancel" },
    });
    expect(cancelled.status).toBe("cancelled");
    expect(builds).toBe(0);
    await expect(service.finalize({ sessionId: cancelled.sessionId, expectedStateDigest: cancelled.stateDigest }))
      .rejects.toMatchObject({ code: "CONTEXT_GRAPH_SEQUENCE_CONFLICT" });

    const accessStart = await service.start({ workspaceId: "workspace", request });
    mutableAccess.scopeGrants.public = [];
    expect(() => service.get(accessStart.sessionId)).toThrow(expect.objectContaining({ code: "ACCESS_DENIED" }));
  });

  test("finalizes confirmed documents only through the existing ContextBuilder", async () => {
    let finalizedRequest: BuildTaskContextRequest | undefined;
    const contextBuilder = {
      preview: async (input: BuildTaskContextRequest) => ({
        ...preview,
        tokenEstimate: input.explicitDocuments?.some(reference => reference.selector === "document-id" && reference.documentId === "DOC-B") === true
          ? 44
          : 20,
      }),
      build: async (input: BuildTaskContextRequest) => {
        finalizedRequest = input;
        return {
          contextBundleId: "context-bundle-1",
          bundleDigest: "sha256:bundle",
          tokenEstimate: 44,
          selectedDocuments: [{ documentId: "DOC-B", selectionReasons: ["explicit_link"] }],
        } as unknown as ContextBundle;
      },
    };
    const service = new ContextLinkGraphSessionService({
      contextBuilder,
      scopeMap: { getActiveRevision: () => revision() },
      principal,
      randomId: () => "abcdef0123456789abcdef01",
    });
    const started = await service.start({ workspaceId: "workspace", request });
    const confirmed = await service.step({
      sessionId: started.sessionId,
      sequence: 1,
      previousStateDigest: started.stateDigest,
      operation: { kind: "confirm", documentIds: ["DOC-B"] },
    });
    expect(confirmed.lastStep?.projectedTokenDelta).toBe(24);
    expect(confirmed.projectedTokenEstimate).toBe(44);

    const bundle = await service.finalize({ sessionId: started.sessionId, expectedStateDigest: confirmed.stateDigest });

    expect(bundle.bundle.bundleDigest).toBe("sha256:bundle");
    expect(bundle.receipt).toEqual(expect.objectContaining({
      bundleDigest: "sha256:bundle",
      confirmedDocumentIds: ["DOC-B"],
      selections: [{ documentId: "DOC-B", selectionReasons: ["explicit_link"] }],
      projectedTokenEstimate: 44,
      contextBundleTokenEstimate: 44,
      steps: [expect.objectContaining({ sequence: 1, projectedTokenDelta: 24 })],
    }));
    expect(finalizedRequest).toEqual({
      ...request,
      explicitDocuments: [{ selector: "document-id", documentId: "DOC-B" }],
    });
  });

  test("uses a short-lived one-time WebSocket ticket without a bearer token in the URL", async () => {
    const tickets = [
      "ticket_value_abcdefghijklmnopqrstuvwxyz012345",
      "ticket_value_ABCDEFGHIJKLMNOPQRSTUVWXYZ678901",
    ];
    const service = new ContextLinkGraphSessionService({
      contextBuilder: { preview: async () => preview, build: async () => ({}) as ContextBundle },
      scopeMap: { getActiveRevision: () => revision() },
      principal,
      randomId: () => "111111111111111111111111",
      randomTicket: () => tickets.shift()!,
    });
    const started = await service.start({ workspaceId: "workspace", request });
    expect(started.websocket?.path).toBe("/v1/context/link-graph/ws");
    expect(started.websocket?.path).not.toContain("token");
    expect(started.websocket?.protocols[0]).toBe("abcm.link-graph.v1");
    const ticket = started.websocket!.protocols[2]!.slice("abcm.ticket.".length);
    expect(service.consumeWebSocketTicket(started.sessionId, ticket).sessionId).toBe(started.sessionId);
    expect(() => service.consumeWebSocketTicket(started.sessionId, ticket)).toThrow(
      expect.objectContaining({ code: "CONTEXT_GRAPH_TICKET_INVALID" }),
    );
    const reconnected = service.issueWebSocketTicket({ sessionId: started.sessionId, expectedStateDigest: started.stateDigest });
    const reconnectTicket = reconnected.websocket!.protocols[2]!.slice("abcm.ticket.".length);
    expect(reconnectTicket).not.toBe(ticket);
    expect(service.consumeWebSocketTicket(started.sessionId, reconnectTicket).sessionId).toBe(started.sessionId);
  });

  test("transports only sequenced session steps over WebSocket", async () => {
    const service = new ContextLinkGraphSessionService({
      contextBuilder: { preview: async () => preview, build: async () => ({}) as ContextBundle },
      scopeMap: { getActiveRevision: () => revision() },
      principal,
    });
    const started = await service.start({ workspaceId: "workspace", request });
    const adapter = new ContextLinkGraphWebSocketAdapter(service);
    let socketData: { sessionId: string } | undefined;
    const server = {
      upgrade: (_incoming: Request, options: { data: { sessionId: string } }) => {
        socketData = options.data;
        return true;
      },
    } as unknown as Bun.Server<{ sessionId: string }>;
    const upgrade = adapter.upgrade(new Request("http://localhost/v1/context/link-graph/ws", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": started.websocket!.protocols.join(", "),
      },
    }), server);
    expect(upgrade).toBeUndefined();
    expect(socketData).toEqual({ sessionId: started.sessionId });

    const messages: Array<Record<string, unknown>> = [];
    const socket = {
      data: socketData!,
      send: (message: string) => {
        messages.push(JSON.parse(message) as Record<string, unknown>);
        return 1;
      },
      close: () => undefined,
    } as unknown as Bun.ServerWebSocket<{ sessionId: string }>;
    await adapter.handlers.open!(socket);
    await adapter.handlers.message(socket, JSON.stringify({
      requestId: "step-1",
      sequence: 1,
      previousStateDigest: started.stateDigest,
      operation: { kind: "confirm", documentIds: ["DOC-B"] },
    }));
    expect(messages[0]).toEqual(expect.objectContaining({ type: "session.ready" }));
    expect(messages[1]).toEqual(expect.objectContaining({ type: "session.step", requestId: "step-1" }));
    expect(JSON.stringify(messages[1])).toContain("DOC-B");
  });

  test("restores body-free short-TTL session state from SQLite after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-link-session-store-"));
    roots.push(root);
    const now = Date.parse("2026-08-20T00:00:00.000Z");
    const dependencies = {
      contextBuilder: { preview: async () => preview, build: async () => ({}) as ContextBundle },
      scopeMap: { getActiveRevision: () => revision() },
      principal,
      clock: () => now,
      ttlMs: 60_000,
      ticketTtlMs: 10_000,
    };
    const firstStore = new SqliteContextLinkGraphSessionStore(root);
    const first = new ContextLinkGraphSessionService({ ...dependencies, store: firstStore });
    const started = await first.start({ workspaceId: "workspace", request });
    const confirmed = await first.step({
      sessionId: started.sessionId,
      sequence: 1,
      previousStateDigest: started.stateDigest,
      operation: { kind: "confirm", documentIds: ["DOC-B"] },
    });
    firstStore.close();

    const secondStore = new SqliteContextLinkGraphSessionStore(root);
    const restoredService = new ContextLinkGraphSessionService({ ...dependencies, store: secondStore });
    expect(restoredService.get(started.sessionId)).toEqual(confirmed);
    secondStore.close();

    const database = new Database(join(root, "context-link-graph.sqlite"), { readonly: true });
    const payload = database.query<{ payload_json: string }, []>("SELECT payload_json FROM context_link_graph_sessions").get()!.payload_json;
    database.close();
    expect(payload).not.toContain("Confirmed body");
    expect(JSON.parse(payload)).toEqual(expect.objectContaining({ schemaVersion: 1, stateDigest: confirmed.stateDigest }));
  });
});
