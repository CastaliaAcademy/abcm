import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";

import { parseDocument } from "yaml";

import { AbcmError } from "../core/errors.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { DocumentRecord, MapRevision } from "../scope-map/types.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type { ArtifactAmendmentReceiptStore, StoredArtifactAmendmentOperation, StoredArtifactApproval } from "./amendment-store.js";

export interface ArtifactAmendmentApprovalReceipt {
  receiptId: string;
  decision: "approved";
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  payloadDigest: string;
}

export interface ArtifactAmendmentPreviewInput {
  workspaceId: string;
  draftPath: string;
  ifMatch: string;
  expectedMapRevision: string;
}

export interface ArtifactAmendmentPreview {
  workspaceId: string;
  draftPath: string;
  artifactId: string;
  lineageId: string;
  baseArtifactId: string;
  baseChecksum: string;
  expectedLineageHead: string;
  draftChecksum: string;
  acceptedChecksum: string;
  mapRevision: string;
  previewDigest: string;
  approvalPayloadDigest: string;
}

export interface AcceptArtifactAmendmentInput extends ArtifactAmendmentPreviewInput {
  expectedPreviewDigest: string;
  approvalReceiptId: string;
}

export interface ArtifactAmendmentReceipt {
  receiptId: string;
  receiptDigest: string;
  workspaceId: string;
  draftPath: string;
  previewDigest: string;
  lineageId: string;
  baseArtifactId: string;
  baseChecksum: string;
  artifactId: string;
  supersedes: string;
  draftChecksum: string;
  acceptedChecksum: string;
  approvalReceiptId: string;
  approvalPayloadDigest: string;
  approvedBy: string;
  approvedAt: string;
  previousMapRevision: string;
  mapRevision: string;
  acceptedAt: string;
}

export interface IntegratedArtifactAmendmentInput {
  workspaceId: string;
  path: string;
  baseChecksum: string;
  content: Uint8Array;
  operationId: string;
  integrationIdentity: string;
}

export interface ArtifactLineageView {
  workspaceId: string;
  mapRevision: string;
  lineageId: string;
  status: "valid" | "ambiguous";
  headArtifactId?: string;
  artifacts: readonly {
    artifactId: string;
    checksum: string;
    lifecycle: string;
    supersedes?: string;
  }[];
}

interface PreparedPreview {
  preview: ArtifactAmendmentPreview;
  acceptedBytes: Uint8Array;
}

interface PendingArtifactAmendment {
  preview: ArtifactAmendmentPreview;
  acceptedAt: string;
}

interface PendingIntegratedArtifactAmendment {
  workspaceId: string;
  path: string;
  archivePath: string;
  artifactId: string;
  lineageId: string;
  baseArtifactId: string;
  baseChecksum: string;
  sourceChecksum: string;
  acceptedChecksum: string;
  acceptedContentBase64: string;
  previousMapRevision: string;
  approvedBy: string;
  approvedAt: string;
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(stable(value)).digest("hex")}`;
}

function acceptedBytes(content: Uint8Array, supersedes: string): Uint8Array {
  const source = new TextDecoder().decode(content);
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(source);
  if (match === null) throw new AbcmError("ARTIFACT_AMENDMENT_INVALID", "Amendment draft must contain YAML frontmatter.");
  const lines = match[2]!.split(/\r?\n/);
  const statusIndex = lines.findIndex(line => /^status\s*:/.test(line));
  if (statusIndex === -1) throw new AbcmError("ARTIFACT_AMENDMENT_INVALID", "Amendment draft must declare status: draft.");
  lines[statusIndex] = "status: accepted";
  const supersedesIndex = lines.findIndex(line => /^supersedes\s*:/.test(line));
  if (supersedesIndex === -1) lines.push(`supersedes: ${supersedes}`);
  else lines[supersedesIndex] = `supersedes: ${supersedes}`;
  return new TextEncoder().encode(`${match[1]}${lines.join("\n")}${match[3]}${source.slice(match[0].length)}`);
}

function integratedAcceptedBytes(
  content: Uint8Array,
  base: Pick<DocumentRecord, "artifactId" | "checksum" | "kind" | "lineageId">,
  artifactId: string,
): Uint8Array {
  const source = new TextDecoder().decode(content);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (match === null) throw new AbcmError("ARTIFACT_AMENDMENT_INVALID", "Integrated amendment must contain YAML frontmatter.");
  const document = parseDocument(match[1] ?? "", { schema: "core", strict: true, uniqueKeys: true, merge: false });
  const issues = [...document.errors, ...document.warnings];
  if (issues.length > 0 || document.contents === null) {
    throw new AbcmError("ARTIFACT_AMENDMENT_INVALID", "Integrated amendment frontmatter is invalid.");
  }
  document.set("id", artifactId);
  document.set("kind", base.kind);
  document.set("status", "accepted");
  document.set("lineageId", base.lineageId ?? base.artifactId!);
  document.set("amends", base.artifactId!);
  document.set("baseArtifactId", base.artifactId!);
  document.set("baseChecksum", base.checksum);
  document.set("expectedLineageHead", base.artifactId!);
  document.set("supersedes", base.artifactId!);
  const frontmatter = document.toString({ lineWidth: 0 }).trimEnd();
  return new TextEncoder().encode(`---\n${frontmatter}\n---\n${source.slice(match[0].length)}`);
}

function artifactIdForIntegratedAmendment(
  base: DocumentRecord,
  sourceChecksum: string,
  operationId: string,
  integrationIdentity: string,
): string {
  const lineage = (base.lineageId ?? base.artifactId ?? base.documentId)
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 220) || "artifact";
  const revisionDigest = digest({
    baseArtifactId: base.artifactId,
    sourceChecksum,
    operationId,
    integrationIdentity,
  });
  return `${base.kind.toLocaleUpperCase("en-US")}-${lineage}-${revisionDigest.slice(7, 31)}`;
}

function artifact(revision: MapRevision, artifactId: string): DocumentRecord | undefined {
  return revision.documents.find(document => document.artifactId === artifactId);
}

export class ArtifactAmendmentService {
  readonly #files: WorkspaceFileService;
  readonly #scopeMap: ScopeMapService;
  readonly #store: ArtifactAmendmentReceiptStore | undefined;
  readonly #clock: () => Date;
  readonly #operatorIdentity: string;
  readonly #approvalTtlMs: number;
  readonly #tails = new Map<string, Promise<void>>();

  constructor(
    files: WorkspaceFileService,
    scopeMap: ScopeMapService,
    options: { store?: ArtifactAmendmentReceiptStore; clock?: () => Date; operatorIdentity?: string; approvalTtlMs?: number } = {},
  ) {
    this.#files = files;
    this.#scopeMap = scopeMap;
    this.#store = options.store;
    this.#clock = options.clock ?? (() => new Date());
    this.#operatorIdentity = options.operatorIdentity ?? "abcm-operator";
    this.#approvalTtlMs = options.approvalTtlMs ?? 15 * 60_000;
  }

  async preview(input: ArtifactAmendmentPreviewInput, signal?: AbortSignal): Promise<ArtifactAmendmentPreview> {
    return (await this.#prepare(input, signal)).preview;
  }

  async acceptIntegratedEdit(
    input: IntegratedArtifactAmendmentInput,
    signal?: AbortSignal,
  ): Promise<ArtifactAmendmentReceipt | undefined> {
    const sourceChecksum = digestBytes(input.content);
    const approvalReceiptId = `integration-approval-${digest({
      workspaceId: input.workspaceId,
      operationId: input.operationId,
      integrationIdentity: input.integrationIdentity,
    }).slice(7, 39)}`;
    const existing = this.#store?.getByApproval(approvalReceiptId) as ArtifactAmendmentReceipt | undefined;
    if (existing !== undefined) {
      if (
        existing.workspaceId !== input.workspaceId ||
        existing.draftPath !== input.path ||
        existing.draftChecksum !== sourceChecksum ||
        existing.baseChecksum !== input.baseChecksum
      ) {
        throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REPLAY", "Integrated amendment identity was reused with different content.");
      }
      return existing;
    }
    const storedOperation = this.#store?.getOperationByApproval(approvalReceiptId);
    if (storedOperation !== undefined) {
      return this.#finishIntegratedEdit(
        storedOperation.payload as PendingIntegratedArtifactAmendment,
        storedOperation.operationDigest,
        approvalReceiptId,
        signal,
      );
    }

    let revision: MapRevision;
    try {
      revision = this.#scopeMap.getActiveRevision(input.workspaceId);
    } catch (error) {
      if (!(error instanceof AbcmError) || error.code !== "MAP_NOT_BUILT") throw error;
      revision = await this.#scopeMap.scan(input.workspaceId, signal);
    }
    const current = revision.documents.find(document => document.relativePath === input.path);
    if (
      current === undefined ||
      !["adr", "rfc"].includes(current.kind.toLocaleLowerCase("en-US")) ||
      current.lifecycle.toLocaleLowerCase("en-US") !== "accepted"
    ) return undefined;
    if (current.checksum !== input.baseChecksum) {
      throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Integrated amendment base checksum is stale.", {
        expected: current.checksum,
        actual: input.baseChecksum,
      });
    }
    if (current.artifactId === undefined) {
      throw new AbcmError("ARTIFACT_AMENDMENT_INVALID", "Accepted ADR/RFC has no artifact identity.");
    }
    if (this.#store === undefined) {
      throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Durable integrated amendment storage is not configured.");
    }

    const artifactId = artifactIdForIntegratedAmendment(
      current,
      sourceChecksum,
      input.operationId,
      input.integrationIdentity,
    );
    if (revision.documents.some(document => document.artifactId === artifactId)) {
      throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Generated integrated amendment artifact identity already exists.", {
        artifactId,
      });
    }
    const accepted = integratedAcceptedBytes(input.content, current, artifactId);
    const configuredApprovedBy = `${this.#operatorIdentity}/obsidian/${input.integrationIdentity}`;
    const approval = this.#store.getApproval(approvalReceiptId);
    if (approval !== undefined && approval.approvedBy !== configuredApprovedBy) {
      throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REPLAY", "Integrated amendment approval identity is already bound to another integration.");
    }
    const approvedAt = approval?.approvedAt ?? this.#clock().toISOString();
    const approvedBy = approval?.approvedBy ?? configuredApprovedBy;
    const pending: PendingIntegratedArtifactAmendment = {
      workspaceId: input.workspaceId,
      path: input.path,
      archivePath: posix.join(posix.dirname(input.path), "revisions", `${encodeURIComponent(current.artifactId)}.md`),
      artifactId,
      lineageId: current.lineageId ?? current.artifactId,
      baseArtifactId: current.artifactId,
      baseChecksum: current.checksum,
      sourceChecksum,
      acceptedChecksum: digestBytes(accepted),
      acceptedContentBase64: Buffer.from(accepted).toString("base64"),
      previousMapRevision: revision.revision,
      approvedBy,
      approvedAt,
    };
    const payloadDigest = digest(pending);
    const operationDigest = digest({ approvalReceiptId, pending });
    if (approval === undefined) {
      this.#store.issueApproval({
        receiptId: approvalReceiptId,
        payloadDigest,
        approvedBy,
        approvedAt,
        expiresAt: new Date(this.#clock().getTime() + this.#approvalTtlMs).toISOString(),
      });
    } else if (approval.payloadDigest !== payloadDigest || approval.approvedBy !== approvedBy) {
      throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REPLAY", "Integrated amendment approval identity is already bound to another payload.");
    }
    const reserved = this.#store.reserveApproval(
      approvalReceiptId,
      payloadDigest,
      { operationDigest, approvalReceiptId, payload: pending },
      this.#clock().toISOString(),
    );
    if (reserved === undefined) {
      throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Integrated amendment approval could not be reserved.");
    }
    return this.#finishIntegratedEdit(pending, operationDigest, approvalReceiptId, signal);
  }

  getLineage(workspaceId: string, lineageId: string): ArtifactLineageView {
    const revision = this.#scopeMap.getActiveRevision(workspaceId);
    const lineage = revision.artifactLineages?.find(candidate => candidate.lineageId === lineageId);
    if (lineage === undefined) throw new AbcmError("ARTIFACT_LINEAGE_NOT_FOUND", "Artifact lineage was not found.");
    const artifacts = lineage.artifactIds.map(artifactId => artifact(revision, artifactId)!).map(document => ({
      artifactId: document.artifactId!,
      checksum: document.checksum,
      lifecycle: document.lifecycle,
      ...(document.supersedes === undefined ? {} : { supersedes: document.supersedes }),
    }));
    return {
      workspaceId,
      mapRevision: revision.revision,
      lineageId,
      status: lineage.status,
      ...(lineage.headArtifactId === undefined ? {} : { headArtifactId: lineage.headArtifactId }),
      artifacts,
    };
  }

  async issueApproval(
    input: ArtifactAmendmentPreviewInput & { expectedPreviewDigest: string },
    signal?: AbortSignal,
  ): Promise<ArtifactAmendmentApprovalReceipt> {
    if (this.#store === undefined) throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Durable operator approval storage is not configured.");
    const prepared = await this.#prepare(input, signal);
    if (prepared.preview.previewDigest !== input.expectedPreviewDigest) {
      throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Amendment preview changed before operator approval.");
    }
    const approvedAt = this.#clock();
    const receipt: ArtifactAmendmentApprovalReceipt = {
      receiptId: `amendment-approval-${randomBytes(16).toString("hex")}`,
      decision: "approved",
      approvedBy: this.#operatorIdentity,
      approvedAt: approvedAt.toISOString(),
      expiresAt: new Date(approvedAt.getTime() + this.#approvalTtlMs).toISOString(),
      payloadDigest: prepared.preview.approvalPayloadDigest,
    };
    this.#store.issueApproval(receipt);
    return receipt;
  }

  async accept(input: AcceptArtifactAmendmentInput, signal?: AbortSignal): Promise<ArtifactAmendmentReceipt> {
    const existing = this.#store?.getByApproval(input.approvalReceiptId) as ArtifactAmendmentReceipt | undefined;
    if (existing !== undefined) return this.#idempotentReceipt(existing, input);
    const storedOperation = this.#store?.getOperationByApproval(input.approvalReceiptId);
    if (storedOperation !== undefined) {
      const pending = this.#pendingOperation(storedOperation, input);
      return this.#serialize(`${input.workspaceId}\0${pending.preview.lineageId}`, () => this.#finishPending(input, pending, storedOperation.operationDigest, signal));
    }
    const initial = await this.#prepare(input, signal);
    return this.#serialize(`${input.workspaceId}\0${initial.preview.lineageId}`, async () => {
        const repeated = this.#store?.getByApproval(input.approvalReceiptId) as ArtifactAmendmentReceipt | undefined;
        if (repeated !== undefined) return this.#idempotentReceipt(repeated, input);
        const resumedOperation = this.#store?.getOperationByApproval(input.approvalReceiptId);
        if (resumedOperation !== undefined) {
          return this.#finishPending(input, this.#pendingOperation(resumedOperation, input), resumedOperation.operationDigest, signal);
        }
        const prepared = await this.#prepare(input, signal);
        if (prepared.preview.previewDigest !== input.expectedPreviewDigest) {
          throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Amendment preview changed before acceptance.");
        }
        if (this.#store === undefined) throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Durable operator approval storage is not configured.");
        const operationDigest = this.#operationDigest(input);
        const pending: PendingArtifactAmendment = { preview: prepared.preview, acceptedAt: this.#clock().toISOString() };
        const approval = this.#store.reserveApproval(
          input.approvalReceiptId,
          prepared.preview.approvalPayloadDigest,
          { operationDigest, approvalReceiptId: input.approvalReceiptId, payload: pending },
          this.#clock().toISOString(),
        );
        if (approval === undefined) {
          throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Operator approval is missing, expired, mismatched or already consumed.");
        }
        return this.#finishPending(input, pending, operationDigest, signal, approval, prepared.acceptedBytes);
    });
  }

  async #finishPending(
    input: AcceptArtifactAmendmentInput,
    pending: PendingArtifactAmendment,
    operationDigest: string,
    signal?: AbortSignal,
    reservedApproval?: StoredArtifactApproval,
    preparedBytes?: Uint8Array,
  ): Promise<ArtifactAmendmentReceipt> {
    if (this.#store === undefined) throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Durable operator approval storage is not configured.");
    let acceptedFileWritten = false;
    try {
      let revision = this.#scopeMap.getActiveRevision(input.workspaceId);
      let current = revision.documents.find(document => document.relativePath === input.draftPath);
      if (current?.lifecycle.toLocaleLowerCase("en-US") === "accepted" && current.checksum === pending.preview.acceptedChecksum) {
        acceptedFileWritten = true;
      } else if (current?.lifecycle.toLocaleLowerCase("en-US") === "draft" && current.checksum === pending.preview.draftChecksum) {
        const bytes = preparedBytes ?? acceptedBytes((await this.#files.read(input.workspaceId, input.draftPath, signal)).content, pending.preview.baseArtifactId);
        if (digestBytes(bytes) !== pending.preview.acceptedChecksum) {
          throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Pending amendment bytes differ from the approved preview.");
        }
        await this.#files.write(input.workspaceId, input.draftPath, bytes, { ifMatch: pending.preview.draftChecksum }, signal);
        acceptedFileWritten = true;
        revision = await this.#scopeMap.scan(input.workspaceId, signal);
        current = revision.documents.find(document => document.relativePath === input.draftPath);
      } else {
        throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Pending amendment file no longer matches the approved draft or accepted revision.");
      }
      const lineage = revision.artifactLineages?.find(candidate => candidate.lineageId === pending.preview.lineageId);
      if (
        current?.artifactId !== pending.preview.artifactId ||
        lineage?.status !== "valid" ||
        lineage.headArtifactId !== pending.preview.artifactId
      ) {
        throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Accepted amendment did not become the unique lineage head.");
      }
      const approval = reservedApproval ?? this.#store.getApproval(input.approvalReceiptId);
      if (
        approval?.consumedBy !== operationDigest ||
        approval.payloadDigest !== pending.preview.approvalPayloadDigest
      ) {
        throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Pending amendment approval reservation is invalid.");
      }
      const body = {
        workspaceId: input.workspaceId,
        draftPath: input.draftPath,
        previewDigest: pending.preview.previewDigest,
        lineageId: pending.preview.lineageId,
        baseArtifactId: pending.preview.baseArtifactId,
        baseChecksum: pending.preview.baseChecksum,
        artifactId: pending.preview.artifactId,
        supersedes: pending.preview.baseArtifactId,
        draftChecksum: pending.preview.draftChecksum,
        acceptedChecksum: pending.preview.acceptedChecksum,
        approvalReceiptId: approval.receiptId,
        approvalPayloadDigest: approval.payloadDigest,
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
        previousMapRevision: pending.preview.mapRevision,
        mapRevision: revision.revision,
        acceptedAt: pending.acceptedAt,
      };
      const receiptDigest = digest(body);
      const receipt: ArtifactAmendmentReceipt = {
        receiptId: `amendment-receipt-${receiptDigest.slice(7, 31)}`,
        receiptDigest,
        ...body,
      };
      this.#store.put(receipt.receiptId, receipt.lineageId, approval.receiptId, receipt);
      return receipt;
    } catch (error) {
      if (!acceptedFileWritten) this.#store.releaseApproval(input.approvalReceiptId, operationDigest);
      throw error;
    }
  }

  async #finishIntegratedEdit(
    pending: PendingIntegratedArtifactAmendment,
    operationDigest: string,
    approvalReceiptId: string,
    signal?: AbortSignal,
  ): Promise<ArtifactAmendmentReceipt> {
    if (this.#store === undefined) throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Durable integrated amendment storage is not configured.");
    let acceptedFileWritten = false;
    try {
      let revision = this.#scopeMap.getActiveRevision(pending.workspaceId);
      let current = revision.documents.find(document => document.relativePath === pending.path);
      if (current?.artifactId === pending.artifactId && current.checksum === pending.acceptedChecksum) {
        acceptedFileWritten = true;
      } else if (
        current?.artifactId === pending.baseArtifactId &&
        current.lifecycle.toLocaleLowerCase("en-US") === "accepted" &&
        current.checksum === pending.baseChecksum
      ) {
        const content = Uint8Array.from(Buffer.from(pending.acceptedContentBase64, "base64"));
        if (digestBytes(content) !== pending.acceptedChecksum) {
          throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Stored integrated amendment bytes are corrupt.");
        }
        await this.#files.amendAcceptedArtifact(
          pending.workspaceId,
          pending.path,
          pending.archivePath,
          content,
          pending.baseChecksum,
          signal,
        );
        acceptedFileWritten = true;
        revision = await this.#scopeMap.scan(pending.workspaceId, signal);
        current = revision.documents.find(document => document.relativePath === pending.path);
      } else {
        throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Integrated amendment head no longer matches its accepted base.");
      }

      const archived = revision.documents.find(document =>
        document.relativePath === pending.archivePath &&
        document.artifactId === pending.baseArtifactId &&
        document.checksum === pending.baseChecksum
      );
      const lineage = revision.artifactLineages?.find(candidate => candidate.lineageId === pending.lineageId);
      if (
        archived === undefined ||
        current?.artifactId !== pending.artifactId ||
        current.checksum !== pending.acceptedChecksum ||
        lineage?.status !== "valid" ||
        lineage.headArtifactId !== pending.artifactId
      ) {
        throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Integrated amendment did not become the unique lineage head.");
      }
      const approval = this.#store.getApproval(approvalReceiptId);
      if (approval?.consumedBy !== operationDigest) {
        throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Integrated amendment approval reservation is invalid.");
      }
      const body = {
        workspaceId: pending.workspaceId,
        draftPath: pending.path,
        previewDigest: digest({
          sourceChecksum: pending.sourceChecksum,
          baseChecksum: pending.baseChecksum,
          previousMapRevision: pending.previousMapRevision,
        }),
        lineageId: pending.lineageId,
        baseArtifactId: pending.baseArtifactId,
        baseChecksum: pending.baseChecksum,
        artifactId: pending.artifactId,
        supersedes: pending.baseArtifactId,
        draftChecksum: pending.sourceChecksum,
        acceptedChecksum: pending.acceptedChecksum,
        approvalReceiptId,
        approvalPayloadDigest: approval.payloadDigest,
        approvedBy: pending.approvedBy,
        approvedAt: pending.approvedAt,
        previousMapRevision: pending.previousMapRevision,
        mapRevision: revision.revision,
        acceptedAt: pending.approvedAt,
      };
      const receiptDigest = digest(body);
      const receipt: ArtifactAmendmentReceipt = {
        receiptId: `amendment-receipt-${receiptDigest.slice(7, 31)}`,
        receiptDigest,
        ...body,
      };
      this.#store.put(receipt.receiptId, receipt.lineageId, approvalReceiptId, receipt);
      return receipt;
    } catch (error) {
      if (!acceptedFileWritten) this.#store.releaseApproval(approvalReceiptId, operationDigest);
      throw error;
    }
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return result;
  }

  #idempotentReceipt(receipt: ArtifactAmendmentReceipt, input: AcceptArtifactAmendmentInput): ArtifactAmendmentReceipt {
    if (
      receipt.workspaceId !== input.workspaceId ||
      receipt.draftPath !== input.draftPath ||
      receipt.draftChecksum !== input.ifMatch ||
      receipt.previousMapRevision !== input.expectedMapRevision ||
      receipt.previewDigest !== input.expectedPreviewDigest ||
      receipt.approvalReceiptId !== input.approvalReceiptId
    ) {
      throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Approval receipt is already bound to another amendment operation.");
    }
    return receipt;
  }

  #operationDigest(input: AcceptArtifactAmendmentInput): string {
    return digest({
      workspaceId: input.workspaceId,
      draftPath: input.draftPath,
      ifMatch: input.ifMatch,
      expectedMapRevision: input.expectedMapRevision,
      expectedPreviewDigest: input.expectedPreviewDigest,
      approvalReceiptId: input.approvalReceiptId,
    });
  }

  #pendingOperation(operation: StoredArtifactAmendmentOperation, input: AcceptArtifactAmendmentInput): PendingArtifactAmendment {
    if (operation.operationDigest !== this.#operationDigest(input) || operation.approvalReceiptId !== input.approvalReceiptId) {
      throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Approval receipt is already bound to another amendment operation.");
    }
    const pending = operation.payload as Partial<PendingArtifactAmendment>;
    if (
      pending.preview === undefined ||
      pending.preview.workspaceId !== input.workspaceId ||
      pending.preview.draftPath !== input.draftPath ||
      pending.preview.draftChecksum !== input.ifMatch ||
      pending.preview.mapRevision !== input.expectedMapRevision ||
      pending.preview.previewDigest !== input.expectedPreviewDigest ||
      typeof pending.acceptedAt !== "string"
    ) {
      throw new AbcmError("ARTIFACT_AMENDMENT_APPROVAL_REQUIRED", "Stored amendment operation does not match the request.");
    }
    return pending as PendingArtifactAmendment;
  }

  async #prepare(input: ArtifactAmendmentPreviewInput, signal?: AbortSignal): Promise<PreparedPreview> {
    const revision = this.#scopeMap.getActiveRevision(input.workspaceId);
    if (revision.revision !== input.expectedMapRevision) {
      throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Amendment MapRevision does not match the active revision.");
    }
    const draft = revision.documents.find(document => document.relativePath === input.draftPath);
    if (
      draft?.artifactId === undefined ||
      !["adr", "rfc"].includes(draft.kind.toLocaleLowerCase("en-US")) ||
      draft.lifecycle.toLocaleLowerCase("en-US") !== "draft" ||
      draft.lineageId === undefined ||
      draft.amends === undefined ||
      draft.baseArtifactId === undefined ||
      draft.baseChecksum === undefined ||
      draft.expectedLineageHead === undefined
    ) {
      throw new AbcmError("ARTIFACT_AMENDMENT_INVALID", "Draft must declare lineageId, amends, baseArtifactId, baseChecksum and expectedLineageHead.");
    }
    const lineage = revision.artifactLineages?.find(candidate => candidate.lineageId === draft.lineageId);
    const base = artifact(revision, draft.baseArtifactId);
    if (
      lineage?.status !== "valid" ||
      lineage.headArtifactId !== draft.expectedLineageHead ||
      draft.amends !== draft.baseArtifactId ||
      base === undefined ||
      base.checksum !== draft.baseChecksum ||
      base.artifactId !== lineage.headArtifactId ||
      base.lifecycle.toLocaleLowerCase("en-US") !== "accepted"
    ) {
      throw new AbcmError("ARTIFACT_AMENDMENT_CONFLICT", "Amendment base checksum or lineage head changed.");
    }
    const read = await this.#files.read(input.workspaceId, input.draftPath, signal);
    if (read.entry.checksum !== input.ifMatch || read.entry.checksum !== draft.checksum) {
      throw new AbcmError("FILE_CHECKSUM_MISMATCH", "Amendment draft checksum does not match If-Match.");
    }
    const accepted = acceptedBytes(read.content, base.artifactId!);
    const acceptedChecksum = digestBytes(accepted);
    const approvalBody = {
      workspaceId: input.workspaceId,
      draftPath: input.draftPath,
      artifactId: draft.artifactId,
      lineageId: draft.lineageId,
      baseArtifactId: base.artifactId!,
      baseChecksum: base.checksum,
      expectedLineageHead: lineage.headArtifactId!,
      draftChecksum: draft.checksum,
      acceptedChecksum,
      mapRevision: revision.revision,
    };
    const approvalPayloadDigest = digest(approvalBody);
    const previewBody = { ...approvalBody, approvalPayloadDigest };
    return {
      preview: { ...previewBody, previewDigest: digest(previewBody) },
      acceptedBytes: accepted,
    };
  }
}
