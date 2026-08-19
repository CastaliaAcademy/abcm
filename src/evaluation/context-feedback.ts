import { createHash } from "node:crypto";

import { z } from "zod/v4";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);

export const contextFeedbackSubmissionSchema = z.object({
  workspaceId: safeId,
  fingerprintId: z.string().regex(/^fingerprint-[a-f0-9]{24}$/),
  feedbackId: safeId,
  documentId: safeId,
  classification: z.enum(["useful", "noise", "required"]),
  target: z.enum(["ranking-policy", "dataset"]),
  rationaleDigest: digest,
}).strict();

export const contextFeedbackProposalSchema = contextFeedbackSubmissionSchema.extend({
  schemaVersion: z.literal("abcm.eval.context-feedback-proposal/v1"),
  proposalId: z.string().regex(/^proposal-[a-f0-9]{24}$/),
  proposalDigest: digest,
  principalId: safeId,
  bundleDigest: digest,
  mapRevision: digest,
  basePolicyVersion: z.enum(["context-selection/v2", "context-selection/v3"]),
  status: z.literal("proposed"),
  createdAt: z.string().datetime(),
}).strict();

export type ContextFeedbackSubmission = z.infer<typeof contextFeedbackSubmissionSchema>;
export type ContextFeedbackProposal = z.infer<typeof contextFeedbackProposalSchema>;
export type ContextFeedbackProposalInput = ContextFeedbackSubmission & Pick<
  ContextFeedbackProposal,
  "principalId" | "bundleDigest" | "mapRevision" | "basePolicyVersion"
>;

export interface ContextFeedbackCatalog {
  recordContextFeedback(input: ContextFeedbackProposalInput): ContextFeedbackProposal;
  listContextFeedback(workspaceId: string, fingerprintId: string): ContextFeedbackProposal[];
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export function createContextFeedbackProposal(input: ContextFeedbackProposalInput, createdAt: string): ContextFeedbackProposal {
  const submission = contextFeedbackSubmissionSchema.parse({
    workspaceId: input.workspaceId,
    fingerprintId: input.fingerprintId,
    feedbackId: input.feedbackId,
    documentId: input.documentId,
    classification: input.classification,
    target: input.target,
    rationaleDigest: input.rationaleDigest,
  });
  const identity = {
    ...submission,
    principalId: input.principalId,
    bundleDigest: input.bundleDigest,
    mapRevision: input.mapRevision,
    basePolicyVersion: input.basePolicyVersion,
  };
  const proposalDigest = `sha256:${createHash("sha256").update(stable(identity)).digest("hex")}`;
  return contextFeedbackProposalSchema.parse({
    schemaVersion: "abcm.eval.context-feedback-proposal/v1",
    ...identity,
    proposalId: `proposal-${proposalDigest.slice("sha256:".length, "sha256:".length + 24)}`,
    proposalDigest,
    status: "proposed",
    createdAt,
  });
}
