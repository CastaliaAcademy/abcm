import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { Database } from "bun:sqlite";

export interface ContextLinkGraphSessionStoreRecord {
  sessionId: string;
  expiresAt: number;
  payload: unknown;
}

export interface ContextLinkGraphSessionStore {
  list(): readonly ContextLinkGraphSessionStoreRecord[];
  put(record: ContextLinkGraphSessionStoreRecord): void;
  delete(sessionId: string): void;
  close(): void;
}

export class SqliteContextLinkGraphSessionStore implements ContextLinkGraphSessionStore {
  readonly #database: Database;

  constructor(stateRoot: string) {
    const root = resolve(stateRoot);
    mkdirSync(root, { recursive: true });
    this.#database = new Database(resolve(root, "context-link-graph.sqlite"), { create: true, strict: true });
    this.#database.run("PRAGMA journal_mode = DELETE");
    this.#database.run("PRAGMA synchronous = FULL");
    this.#database.run(`CREATE TABLE IF NOT EXISTS context_link_graph_sessions (
      session_id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL
    ) STRICT`);
  }

  list(): readonly ContextLinkGraphSessionStoreRecord[] {
    return this.#database
      .query<{ session_id: string; expires_at: number; payload_json: string }, []>(
        "SELECT session_id, expires_at, payload_json FROM context_link_graph_sessions ORDER BY session_id",
      )
      .all()
      .map(row => ({ sessionId: row.session_id, expiresAt: row.expires_at, payload: JSON.parse(row.payload_json) as unknown }));
  }

  put(record: ContextLinkGraphSessionStoreRecord): void {
    this.#database.run(
      `INSERT INTO context_link_graph_sessions(session_id, expires_at, payload_json)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET expires_at = excluded.expires_at, payload_json = excluded.payload_json`,
      [record.sessionId, record.expiresAt, JSON.stringify(record.payload)],
    );
  }

  delete(sessionId: string): void {
    this.#database.run("DELETE FROM context_link_graph_sessions WHERE session_id = ?", [sessionId]);
  }

  close(): void {
    this.#database.close();
  }
}
