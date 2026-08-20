import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Database } from "bun:sqlite";

export interface StoredArtifactApproval {
  receiptId: string;
  payloadDigest: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  consumedBy?: string;
}

export interface StoredArtifactAmendmentOperation {
  operationDigest: string;
  approvalReceiptId: string;
  payload: unknown;
}

export interface ArtifactAmendmentReceiptStore {
  get(receiptId: string): unknown | undefined;
  getByApproval(approvalReceiptId: string): unknown | undefined;
  put(receiptId: string, lineageId: string, approvalReceiptId: string, payload: unknown): void;
  issueApproval(approval: StoredArtifactApproval): void;
  getApproval(receiptId: string): StoredArtifactApproval | undefined;
  reserveApproval(receiptId: string, payloadDigest: string, operation: StoredArtifactAmendmentOperation, now: string): StoredArtifactApproval | undefined;
  getOperationByApproval(approvalReceiptId: string): StoredArtifactAmendmentOperation | undefined;
  releaseApproval(receiptId: string, operationDigest: string): void;
  close(): void;
}

export class SqliteArtifactAmendmentReceiptStore implements ArtifactAmendmentReceiptStore {
  readonly #database: Database;

  constructor(stateRoot: string) {
    const root = resolve(stateRoot);
    mkdirSync(root, { recursive: true });
    this.#database = new Database(resolve(root, "artifact-amendments.sqlite"), { create: true, strict: true });
    this.#database.run("PRAGMA journal_mode = WAL");
    this.#database.run("PRAGMA synchronous = FULL");
    this.#database.run(`CREATE TABLE IF NOT EXISTS artifact_amendment_receipts (
      receipt_id TEXT PRIMARY KEY,
      lineage_id TEXT NOT NULL,
      approval_receipt_id TEXT,
      payload_json TEXT NOT NULL
    ) STRICT`);
    const columns = this.#database.query<{ name: string }, []>("PRAGMA table_info(artifact_amendment_receipts)").all();
    if (!columns.some(column => column.name === "approval_receipt_id")) {
      this.#database.run("ALTER TABLE artifact_amendment_receipts ADD COLUMN approval_receipt_id TEXT");
    }
    this.#database.run("CREATE UNIQUE INDEX IF NOT EXISTS artifact_amendment_approval_result ON artifact_amendment_receipts(approval_receipt_id) WHERE approval_receipt_id IS NOT NULL");
    this.#database.run(`CREATE TABLE IF NOT EXISTS artifact_amendment_approvals (
      receipt_id TEXT PRIMARY KEY,
      payload_digest TEXT NOT NULL,
      approved_by TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_by TEXT
    ) STRICT`);
    this.#database.run(`CREATE TABLE IF NOT EXISTS artifact_amendment_operations (
      operation_digest TEXT PRIMARY KEY,
      approval_receipt_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL
    ) STRICT`);
  }

  get(receiptId: string): unknown | undefined {
    const row = this.#database.query<{ payload_json: string }, [string]>("SELECT payload_json FROM artifact_amendment_receipts WHERE receipt_id = ?").get(receiptId);
    return row === null ? undefined : JSON.parse(row.payload_json) as unknown;
  }

  getByApproval(approvalReceiptId: string): unknown | undefined {
    const row = this.#database.query<{ payload_json: string }, [string]>("SELECT payload_json FROM artifact_amendment_receipts WHERE approval_receipt_id = ?").get(approvalReceiptId);
    return row === null ? undefined : JSON.parse(row.payload_json) as unknown;
  }

  put(receiptId: string, lineageId: string, approvalReceiptId: string, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    const existing = this.#database.query<{ payload_json: string }, [string]>("SELECT payload_json FROM artifact_amendment_receipts WHERE receipt_id = ?").get(receiptId);
    if (existing !== null && existing.payload_json !== serialized) throw new Error(`Amendment receipt '${receiptId}' is immutable.`);
    this.#database.run(
      "INSERT OR IGNORE INTO artifact_amendment_receipts(receipt_id, lineage_id, approval_receipt_id, payload_json) VALUES (?, ?, ?, ?)",
      [receiptId, lineageId, approvalReceiptId, serialized],
    );
  }

  issueApproval(approval: StoredArtifactApproval): void {
    this.#database.run(
      "INSERT INTO artifact_amendment_approvals(receipt_id, payload_digest, approved_by, approved_at, expires_at, consumed_by) VALUES (?, ?, ?, ?, ?, NULL)",
      [approval.receiptId, approval.payloadDigest, approval.approvedBy, approval.approvedAt, approval.expiresAt],
    );
  }

  getApproval(receiptId: string): StoredArtifactApproval | undefined {
    const row = this.#database.query<{
      receipt_id: string; payload_digest: string; approved_by: string; approved_at: string; expires_at: string; consumed_by: string | null;
    }, [string]>("SELECT * FROM artifact_amendment_approvals WHERE receipt_id = ?").get(receiptId);
    return row === null ? undefined : {
      receiptId: row.receipt_id,
      payloadDigest: row.payload_digest,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      expiresAt: row.expires_at,
      ...(row.consumed_by === null ? {} : { consumedBy: row.consumed_by }),
    };
  }

  reserveApproval(receiptId: string, payloadDigest: string, operation: StoredArtifactAmendmentOperation, now: string): StoredArtifactApproval | undefined {
    const transaction = this.#database.transaction(() => {
      const approval = this.getApproval(receiptId);
      if (approval === undefined || approval.payloadDigest !== payloadDigest || approval.expiresAt <= now) return undefined;
      if (approval.consumedBy !== undefined && approval.consumedBy !== operation.operationDigest) return undefined;
      const serialized = JSON.stringify(operation.payload);
      const existing = this.#database.query<{ operation_digest: string; payload_json: string }, [string]>(
        "SELECT operation_digest, payload_json FROM artifact_amendment_operations WHERE approval_receipt_id = ?",
      ).get(receiptId);
      if (existing !== null && (existing.operation_digest !== operation.operationDigest || existing.payload_json !== serialized)) return undefined;
      if (approval.consumedBy === undefined) {
        this.#database.run("UPDATE artifact_amendment_approvals SET consumed_by = ? WHERE receipt_id = ? AND consumed_by IS NULL", [operation.operationDigest, receiptId]);
      }
      this.#database.run(
        "INSERT OR IGNORE INTO artifact_amendment_operations(operation_digest, approval_receipt_id, payload_json) VALUES (?, ?, ?)",
        [operation.operationDigest, receiptId, serialized],
      );
      return { ...approval, consumedBy: operation.operationDigest };
    });
    return transaction.immediate();
  }

  getOperationByApproval(approvalReceiptId: string): StoredArtifactAmendmentOperation | undefined {
    const row = this.#database.query<{ operation_digest: string; approval_receipt_id: string; payload_json: string }, [string]>(
      "SELECT operation_digest, approval_receipt_id, payload_json FROM artifact_amendment_operations WHERE approval_receipt_id = ?",
    ).get(approvalReceiptId);
    return row === null ? undefined : {
      operationDigest: row.operation_digest,
      approvalReceiptId: row.approval_receipt_id,
      payload: JSON.parse(row.payload_json) as unknown,
    };
  }

  releaseApproval(receiptId: string, operationDigest: string): void {
    const transaction = this.#database.transaction(() => {
      this.#database.run("DELETE FROM artifact_amendment_operations WHERE approval_receipt_id = ? AND operation_digest = ?", [receiptId, operationDigest]);
      this.#database.run("UPDATE artifact_amendment_approvals SET consumed_by = NULL WHERE receipt_id = ? AND consumed_by = ?", [receiptId, operationDigest]);
    });
    transaction.immediate();
  }

  close(): void { this.#database.close(); }
}
