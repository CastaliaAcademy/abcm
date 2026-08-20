import { z } from "zod/v4";

import { AbcmError } from "../core/errors.js";
import { contextLinkGraphWebSocketStepSchema } from "./link-graph-session-schema.js";
import type { ContextLinkGraphSessionService } from "./link-graph-session.js";

export interface ContextLinkGraphWebSocketData {
  sessionId: string;
}

function errorPayload(error: unknown): { error_code: string; message: string; details?: Readonly<Record<string, unknown>> } {
  if (error instanceof AbcmError) {
    return {
      error_code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return { error_code: "REQUEST_INVALID", message: "WebSocket step message is invalid." };
  }
  return { error_code: "INTERNAL_ERROR", message: "An unexpected server error occurred." };
}

export class ContextLinkGraphWebSocketAdapter {
  readonly path = "/v1/context/link-graph/ws" as const;
  readonly #sessions: ContextLinkGraphSessionService;

  constructor(sessions: ContextLinkGraphSessionService) {
    this.#sessions = sessions;
  }

  upgrade(request: Request, server: Bun.Server<ContextLinkGraphWebSocketData>): Response | undefined {
    try {
      if (request.method !== "GET" || request.headers.get("upgrade")?.toLocaleLowerCase("en-US") !== "websocket") {
        return Response.json({ error_code: "REQUEST_INVALID", message: "A WebSocket upgrade request is required." }, { status: 426 });
      }
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map(value => value.trim())
        .filter(Boolean);
      if (!protocols.includes("abcm.link-graph.v1")) {
        throw new AbcmError("CONTEXT_GRAPH_TICKET_INVALID", "Required link-graph WebSocket protocol is missing.");
      }
      const sessionId = protocols.find(value => value.startsWith("abcm.session."))?.slice("abcm.session.".length);
      const ticket = protocols.find(value => value.startsWith("abcm.ticket."))?.slice("abcm.ticket.".length);
      if (sessionId === undefined || ticket === undefined) {
        throw new AbcmError("CONTEXT_GRAPH_TICKET_INVALID", "Link-graph WebSocket session or ticket protocol is missing.");
      }
      this.#sessions.consumeWebSocketTicket(sessionId, ticket);
      const upgraded = server.upgrade(request, {
        data: { sessionId },
        headers: { "sec-websocket-protocol": "abcm.link-graph.v1" },
      });
      if (!upgraded) return Response.json({ error_code: "REQUEST_INVALID", message: "WebSocket upgrade failed." }, { status: 400 });
      return undefined;
    } catch (error) {
      const payload = errorPayload(error);
      const status = error instanceof AbcmError ? error.status : 400;
      return Response.json(payload, { status });
    }
  }

  readonly handlers: Bun.WebSocketHandler<ContextLinkGraphWebSocketData> = {
    data: {} as ContextLinkGraphWebSocketData,
    maxPayloadLength: 1024 * 1024,
    idleTimeout: 120,
    open: ws => {
      try {
        ws.send(JSON.stringify({ type: "session.ready", session: this.#sessions.get(ws.data.sessionId) }));
      } catch (error) {
        ws.send(JSON.stringify({ type: "session.error", error: errorPayload(error) }));
        ws.close(4001, "session unavailable");
      }
    },
    message: async (ws, message) => {
      let requestId: string | undefined;
      try {
        const decoded = JSON.parse(typeof message === "string" ? message : message.toString("utf8")) as unknown;
        requestId = typeof decoded === "object" && decoded !== null && "requestId" in decoded && typeof decoded.requestId === "string"
          ? decoded.requestId
          : undefined;
        const input = contextLinkGraphWebSocketStepSchema.parse(decoded);
        const session = await this.#sessions.step({
          sessionId: ws.data.sessionId,
          sequence: input.sequence,
          previousStateDigest: input.previousStateDigest,
          operation: input.operation,
        });
        ws.send(JSON.stringify({ type: "session.step", requestId: input.requestId, session }));
        if (session.status === "cancelled") ws.close(1000, "session cancelled");
      } catch (error) {
        ws.send(JSON.stringify({ type: "session.error", ...(requestId === undefined ? {} : { requestId }), error: errorPayload(error) }));
      }
    },
  };
}
