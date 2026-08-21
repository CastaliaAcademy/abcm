import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactAmendmentService } from "../src/artifacts/amendment-service.js";
import {
  type ArtifactAmendmentReceiptStore,
  SqliteArtifactAmendmentReceiptStore,
  type StoredArtifactAmendmentOperation,
  type StoredArtifactApproval,
} from "../src/artifacts/amendment-store.js";
import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];
const checksum = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-amendment-"));
  roots.push(root);
  await mkdir(join(root, "project", "artifacts", "adr"), { recursive: true });
  await mkdir(join(root, "project", "config"), { recursive: true });
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "project", "domain-language"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workspace\nname: Workspace\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
  await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const basePath = "project/artifacts/adr/ADR-DECISION-V1.md";
  const baseBytes = "---\nid: ADR-DECISION-V1\nkind: adr\ntitle: Decision v1\nstatus: accepted\nlineageId: decision\n---\nOriginal accepted bytes.\n";
  await writeFile(join(root, basePath), baseBytes);
  const runtime = createAbcmRuntime({ id: "workspace", root });
  let revision = await runtime.scopeMap.scan("workspace");
  const base = revision.documents.find(document => document.artifactId === "ADR-DECISION-V1")!;
  const draft = (id: string) => `---\nid: ${id}\nkind: adr\ntitle: Decision amendment\nstatus: draft\nlineageId: decision\namends: ADR-DECISION-V1\nbaseArtifactId: ADR-DECISION-V1\nbaseChecksum: ${base.checksum}\nexpectedLineageHead: ADR-DECISION-V1\n---\nAmended normative meaning.\n`;
  const firstPath = "project/artifacts/adr/ADR-DECISION-V2.md";
  const secondPath = "project/artifacts/adr/ADR-DECISION-V2B.md";
  await writeFile(join(root, firstPath), draft("ADR-DECISION-V2"));
  await writeFile(join(root, secondPath), draft("ADR-DECISION-V2B"));
  revision = await runtime.scopeMap.scan("workspace");
  const store = new SqliteArtifactAmendmentReceiptStore(join(root, ".approval-state"));
  const service = new ArtifactAmendmentService(runtime.files, runtime.scopeMap, { store, operatorIdentity: "operator", clock: () => new Date("2026-08-20T00:00:00.000Z") });
  return { root, runtime, store, service, revision, basePath, baseBytes, firstPath, secondPath };
}

class FailOnceReceiptStore implements ArtifactAmendmentReceiptStore {
  #failed = false;
  constructor(readonly delegate: ArtifactAmendmentReceiptStore) {}
  get(receiptId: string) { return this.delegate.get(receiptId); }
  getByApproval(approvalReceiptId: string) { return this.delegate.getByApproval(approvalReceiptId); }
  put(receiptId: string, lineageId: string, approvalReceiptId: string, payload: unknown) {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("simulated receipt commit failure");
    }
    this.delegate.put(receiptId, lineageId, approvalReceiptId, payload);
  }
  issueApproval(approval: StoredArtifactApproval) { this.delegate.issueApproval(approval); }
  getApproval(receiptId: string) { return this.delegate.getApproval(receiptId); }
  reserveApproval(receiptId: string, payloadDigest: string, operation: StoredArtifactAmendmentOperation, now: string) {
    return this.delegate.reserveApproval(receiptId, payloadDigest, operation, now);
  }
  getOperationByApproval(approvalReceiptId: string) { return this.delegate.getOperationByApproval(approvalReceiptId); }
  releaseApproval(receiptId: string, operationDigest: string) { this.delegate.releaseApproval(receiptId, operationDigest); }
  close() {}
}

describe("ArtifactAmendmentService", () => {
  test("keeps accepted bytes immutable and allows only one concurrent lineage head", async () => {
    const { root, runtime, store, service, revision, basePath, baseBytes, firstPath, secondPath } = await fixture();
    try {
      const firstDocument = revision.documents.find(document => document.relativePath === firstPath)!;
      const secondDocument = revision.documents.find(document => document.relativePath === secondPath)!;
      const first = await service.preview({ workspaceId: "workspace", draftPath: firstPath, ifMatch: firstDocument.checksum, expectedMapRevision: revision.revision });
      const second = await service.preview({ workspaceId: "workspace", draftPath: secondPath, ifMatch: secondDocument.checksum, expectedMapRevision: revision.revision });
      await expect(service.accept({
        workspaceId: "workspace",
        draftPath: firstPath,
        ifMatch: firstDocument.checksum,
        expectedMapRevision: revision.revision,
        expectedPreviewDigest: first.previewDigest,
        approvalReceiptId: `amendment-approval-${"0".repeat(32)}`,
      })).rejects.toMatchObject({ code: "ARTIFACT_AMENDMENT_APPROVAL_REQUIRED" });

      const firstApproval = await service.issueApproval({ workspaceId: "workspace", draftPath: firstPath, ifMatch: firstDocument.checksum, expectedMapRevision: revision.revision, expectedPreviewDigest: first.previewDigest });
      const secondApproval = await service.issueApproval({ workspaceId: "workspace", draftPath: secondPath, ifMatch: secondDocument.checksum, expectedMapRevision: revision.revision, expectedPreviewDigest: second.previewDigest });
      const results = await Promise.allSettled([
        service.accept({ workspaceId: "workspace", draftPath: firstPath, ifMatch: firstDocument.checksum, expectedMapRevision: revision.revision, expectedPreviewDigest: first.previewDigest, approvalReceiptId: firstApproval.receiptId }),
        service.accept({ workspaceId: "workspace", draftPath: secondPath, ifMatch: secondDocument.checksum, expectedMapRevision: revision.revision, expectedPreviewDigest: second.previewDigest, approvalReceiptId: secondApproval.receiptId }),
      ]);
      const accepted = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.accept>>> => result.status === "fulfilled");
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toEqual(expect.objectContaining({ code: "ARTIFACT_AMENDMENT_CONFLICT" }));
      expect(await readFile(join(root, basePath), "utf8")).toBe(baseBytes);
      const lineage = service.getLineage("workspace", "decision");
      expect(lineage).toEqual(expect.objectContaining({ status: "valid", headArtifactId: accepted[0]!.value.artifactId }));
      expect(lineage.artifacts).toContainEqual(expect.objectContaining({ artifactId: "ADR-DECISION-V1", lifecycle: "superseded" }));
      expect(lineage.artifacts).toContainEqual(expect.objectContaining({ artifactId: accepted[0]!.value.artifactId, lifecycle: "accepted", supersedes: "ADR-DECISION-V1" }));
      expect(accepted[0]!.value).toEqual(expect.objectContaining({ approvedBy: "operator", approvedAt: "2026-08-20T00:00:00.000Z" }));
    } finally {
      await runtime.close();
      store.close();
    }
  });

  test("recovers the same receipt after accepted bytes were written before receipt commit", async () => {
    const { root, runtime, store, revision, firstPath } = await fixture();
    try {
      const draft = revision.documents.find(document => document.relativePath === firstPath)!;
      const failing = new ArtifactAmendmentService(runtime.files, runtime.scopeMap, {
        store: new FailOnceReceiptStore(store),
        operatorIdentity: "operator",
        clock: () => new Date("2026-08-20T00:00:00.000Z"),
      });
      const preview = await failing.preview({ workspaceId: "workspace", draftPath: firstPath, ifMatch: draft.checksum, expectedMapRevision: revision.revision });
      const approval = await failing.issueApproval({ workspaceId: "workspace", draftPath: firstPath, ifMatch: draft.checksum, expectedMapRevision: revision.revision, expectedPreviewDigest: preview.previewDigest });
      const input = {
        workspaceId: "workspace",
        draftPath: firstPath,
        ifMatch: draft.checksum,
        expectedMapRevision: revision.revision,
        expectedPreviewDigest: preview.previewDigest,
        approvalReceiptId: approval.receiptId,
      };
      await expect(failing.accept(input)).rejects.toThrow("simulated receipt commit failure");
      expect(await readFile(join(root, firstPath), "utf8")).toContain("status: accepted");

      const recoveredService = new ArtifactAmendmentService(runtime.files, runtime.scopeMap, {
        store,
        operatorIdentity: "operator",
        clock: () => new Date("2026-08-20T00:05:00.000Z"),
      });
      const recovered = await recoveredService.accept(input);
      expect(recovered).toEqual(expect.objectContaining({ artifactId: "ADR-DECISION-V2", acceptedAt: "2026-08-20T00:00:00.000Z" }));
      expect(await recoveredService.accept(input)).toEqual(recovered);
      expect(recoveredService.getLineage("workspace", "decision").artifacts.filter(artifact => artifact.artifactId === "ADR-DECISION-V2")).toHaveLength(1);
    } finally {
      await runtime.close();
      store.close();
    }
  });

  test("recovers an integration-approved stable-path amendment after receipt commit failure", async () => {
    const { root, runtime, store, revision, basePath, baseBytes } = await fixture();
    try {
      const base = revision.documents.find(document => document.relativePath === basePath)!;
      const content = new TextEncoder().encode(
        "---\nid: ADR-DECISION-V1\nkind: adr\ntitle: Decision from Obsidian\nstatus: accepted\nlineageId: decision\ntags: [operator-edit]\n---\nIntegrated edit.\n",
      );
      const input = {
        workspaceId: "workspace",
        path: basePath,
        baseChecksum: base.checksum,
        content,
        operationId: "op_integrated_amendment_0001",
        integrationIdentity: "device_operator_0001",
      };
      const failing = new ArtifactAmendmentService(runtime.files, runtime.scopeMap, {
        store: new FailOnceReceiptStore(store),
        operatorIdentity: "operator",
        clock: () => new Date("2026-08-20T00:00:00.000Z"),
      });
      await expect(failing.acceptIntegratedEdit(input)).rejects.toThrow("simulated receipt commit failure");
      expect(await readFile(join(root, "project/artifacts/adr/revisions/ADR-DECISION-V1.md"), "utf8")).toBe(baseBytes);

      const recoveredService = new ArtifactAmendmentService(runtime.files, runtime.scopeMap, {
        store,
        operatorIdentity: "operator",
        clock: () => new Date("2026-08-20T00:05:00.000Z"),
      });
      const recovered = await recoveredService.acceptIntegratedEdit(input);
      expect(recovered).toEqual(expect.objectContaining({
        baseArtifactId: "ADR-DECISION-V1",
        supersedes: "ADR-DECISION-V1",
        approvedBy: "operator/obsidian/device_operator_0001",
        acceptedAt: "2026-08-20T00:00:00.000Z",
      }));
      expect(await recoveredService.acceptIntegratedEdit(input)).toEqual(recovered);
      expect(recoveredService.getLineage("workspace", "decision").artifacts.filter(artifact => artifact.artifactId === recovered?.artifactId)).toHaveLength(1);
    } finally {
      await runtime.close();
      store.close();
    }
  });

  test("recovers the stable head after an interrupted archive rename", async () => {
    const { root, runtime, store, revision, basePath, baseBytes } = await fixture();
    try {
      const base = revision.documents.find(document => document.relativePath === basePath)!;
      const archivePath = "project/artifacts/adr/revisions/ADR-DECISION-V1.md";
      await mkdir(join(root, "project/artifacts/adr/revisions"), { recursive: true });
      await rename(join(root, basePath), join(root, archivePath));
      const accepted = new TextEncoder().encode(
        "---\nid: ADR-DECISION-V2\nkind: adr\ntitle: Recovered decision\nstatus: accepted\nlineageId: decision\nsupersedes: ADR-DECISION-V1\n---\nRecovered head.\n",
      );

      const result = await runtime.files.amendAcceptedArtifact(
        "workspace",
        basePath,
        archivePath,
        accepted,
        base.checksum,
      );

      expect(result.head.checksum).toBe(checksum(accepted));
      expect(await readFile(join(root, archivePath), "utf8")).toBe(baseBytes);
      expect(new Uint8Array(await readFile(join(root, basePath)))).toEqual(accepted);
    } finally {
      await runtime.close();
      store.close();
    }
  });
});
