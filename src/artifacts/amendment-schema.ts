import { z } from "zod/v4";

const id = z.string().min(1).max(256);
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const path = z.string().min(1).max(1_024);

export const artifactAmendmentPreviewInputSchema = z.object({ workspaceId: id, draftPath: path, ifMatch: checksum, expectedMapRevision: checksum }).strict();
export const artifactAmendmentPreviewOutputSchema = z.object({
  workspaceId: id,
  draftPath: path,
  artifactId: id,
  lineageId: id,
  baseArtifactId: id,
  baseChecksum: checksum,
  expectedLineageHead: id,
  draftChecksum: checksum,
  acceptedChecksum: checksum,
  mapRevision: checksum,
  previewDigest: checksum,
  approvalPayloadDigest: checksum,
}).strict();
export const artifactAmendmentAcceptInputSchema = artifactAmendmentPreviewInputSchema.extend({
  expectedPreviewDigest: checksum,
  approvalReceiptId: z.string().regex(/^amendment-approval-[a-f0-9]{32}$/),
}).strict();
export const artifactAmendmentApprovalIssueInputSchema = artifactAmendmentPreviewInputSchema.extend({ expectedPreviewDigest: checksum }).strict();
export const artifactAmendmentApprovalReceiptSchema = z.object({
  receiptId: z.string().regex(/^amendment-approval-[a-f0-9]{32}$/),
  decision: z.literal("approved"),
  approvedBy: id,
  approvedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  payloadDigest: checksum,
}).strict();
export const artifactAmendmentReceiptSchema = z.object({
  receiptId: id,
  receiptDigest: checksum,
  workspaceId: id,
  draftPath: path,
  previewDigest: checksum,
  lineageId: id,
  baseArtifactId: id,
  baseChecksum: checksum.optional(),
  artifactId: id,
  supersedes: id,
  draftChecksum: checksum,
  acceptedChecksum: checksum,
  approvalReceiptId: id,
  approvalPayloadDigest: checksum,
  approvedBy: id,
  approvedAt: z.string().datetime(),
  previousMapRevision: checksum,
  mapRevision: checksum,
  acceptedAt: z.string(),
}).strict();
export const artifactLineageGetInputSchema = z.object({ workspaceId: id, lineageId: id }).strict();
export const artifactLineageOutputSchema = z.object({
  workspaceId: id,
  mapRevision: checksum,
  lineageId: id,
  status: z.enum(["valid", "ambiguous"]),
  headArtifactId: id.optional(),
  artifacts: z.array(z.object({ artifactId: id, checksum, lifecycle: id, supersedes: id.optional() }).strict()),
}).strict();
