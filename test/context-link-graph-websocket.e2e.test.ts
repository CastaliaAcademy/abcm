import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import type { ContextLinkGraphWebSocketData } from "../src/context/link-graph-websocket.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

interface SocketProbe {
  ws: WebSocket;
  next(): Promise<Record<string, unknown>>;
}

function connect(url: string, protocols: readonly string[]): Promise<SocketProbe> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [...protocols]);
    const queued: Record<string, unknown>[] = [];
    const waiting: Array<(message: Record<string, unknown>) => void> = [];
    const timer = setTimeout(() => reject(new Error("WebSocket connection timed out.")), 3_000);
    ws.onmessage = event => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      const receiver = waiting.shift();
      if (receiver === undefined) queued.push(message);
      else receiver(message);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket upgrade rejected."));
    };
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        ws,
        next: () => new Promise<Record<string, unknown>>((resolveMessage, rejectMessage) => {
          const available = queued.shift();
          if (available !== undefined) return resolveMessage(available);
          const messageTimer = setTimeout(() => rejectMessage(new Error("WebSocket message timed out.")), 3_000);
          waiting.push(message => {
            clearTimeout(messageTimer);
            resolveMessage(message);
          });
        }),
      });
    };
  });
}

describe("ABCM real link-graph WebSocket", () => {
  test("consumes a ticket once and reconnects only after explicit reissue", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-link-graph-ws-"));
    roots.push(root);
    await mkdir(join(root, "domain-language"), { recursive: true });
    await mkdir(join(root, "project", "config"), { recursive: true });
    await mkdir(join(root, "project", "domain-language"), { recursive: true });
    await mkdir(join(root, "project", "artifacts"), { recursive: true });
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: Workflow\n");
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
    await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
    await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(root, "project/artifacts/A.md"), "---\nid: DOC-A\nkind: adr\ntitle: Alpha\n---\n[[DOC-B]]\n");
    await writeFile(join(root, "project/artifacts/B.md"), "---\nid: DOC-B\nkind: adr\ntitle: Beta\n---\nBody must stay outside the session state.\n");
    const access = {
      workspacePermissions: ["scope.discover", "scope.read_metadata", "scope_map.read_full", "context.build", "document.read"] as const,
    };
    const principal = { principalId: "websocket-agent", access };
    const runtime = createAbcmRuntime({ id: "test", root }, { contextPrincipal: principal, scopeMapAccess: access });
    await runtime.scopeMap.scan("test");
    const bootstrap = await runtime.domainLanguage.createBootstrap(
      { anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" },
      principal,
    );
    const session = await runtime.contextLinkGraphSessions!.start({
      workspaceId: "test",
      seedDocumentIds: ["DOC-A"],
      request: {
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        roleId: "agent",
        taskType: "implementation",
        goal: "Проверить WebSocket",
        exactScopeIds: ["project"],
      },
    });
    const adapter = runtime.contextLinkGraphWebSocket!;
    const server = Bun.serve<ContextLinkGraphWebSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, bunServer) => adapter.upgrade(request, bunServer),
      websocket: adapter.handlers,
    });
    const url = new URL(adapter.path, server.url);
    url.protocol = "ws:";

    try {
      const first = await connect(url.href, session.websocket!.protocols);
      const ready = await first.next();
      expect(ready.type).toBe("session.ready");
      expect(JSON.stringify(ready)).not.toContain("Body must stay outside");
      first.ws.send(JSON.stringify({
        requestId: "confirm-1",
        sequence: 1,
        previousStateDigest: session.stateDigest,
        operation: { kind: "confirm", documentIds: ["DOC-B"] },
      }));
      const step = await first.next() as { type: string; session: { stateDigest: string; confirmedDocumentIds: string[] } };
      expect(step.type).toBe("session.step");
      expect(step.session.confirmedDocumentIds).toEqual(["DOC-B"]);
      first.ws.close();

      await expect(connect(url.href, session.websocket!.protocols)).rejects.toThrow("upgrade rejected");
      const reissued = runtime.contextLinkGraphSessions!.issueWebSocketTicket({
        sessionId: session.sessionId,
        expectedStateDigest: step.session.stateDigest,
      });
      const second = await connect(url.href, reissued.websocket!.protocols);
      const reconnected = await second.next() as { type: string; session: { sequence: number; stateDigest: string } };
      expect(reconnected.type).toBe("session.ready");
      expect(reconnected.session.sequence).toBe(1);
      second.ws.send(JSON.stringify({
        requestId: "undo-2",
        sequence: 2,
        previousStateDigest: reconnected.session.stateDigest,
        operation: { kind: "undo" },
      }));
      const undo = await second.next() as { type: string; session: { sequence: number; confirmedDocumentIds: string[] } };
      expect(undo.type).toBe("session.step");
      expect(undo.session.sequence).toBe(2);
      expect(undo.session.confirmedDocumentIds).toEqual([]);
      second.ws.close();
    } finally {
      server.stop(true);
      await runtime.close();
    }
  });
});
