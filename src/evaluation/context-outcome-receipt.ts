import { createHash } from "node:crypto";

import { z } from "zod/v4";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);

export const contextOutcomeSubmissionSchema = z.object({
  workspaceId: safeId,
  fingerprintId: z.string().regex(/^fingerprint-[a-f0-9]{24}$/),
  runId: safeId,
  repeatId: safeId,
  taskSucceeded: z.boolean(),
  rubricVersion: safeId,
  judgeIdentityClass: z.enum(["automated", "human", "hybrid"]),
  modelIdentityDigest: digest,
  evidenceDigest: digest,
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }).strict(),
  totalCostMicrounits: z.number().int().nonnegative(),
}).strict();

export const contextOutcomeReceiptSchema = contextOutcomeSubmissionSchema.extend({
  schemaVersion: z.literal("abcm.eval.context-outcome/v1"),
  outcomeId: z.string().regex(/^outcome-[a-f0-9]{24}$/),
  bundleDigest: digest,
  outcomeDigest: digest,
  createdAt: z.string().datetime(),
}).strict();

export type ContextOutcomeSubmission = z.infer<typeof contextOutcomeSubmissionSchema>;
export type ContextOutcomeReceipt = z.infer<typeof contextOutcomeReceiptSchema>;

export interface ContextOutcomeCatalog {
  recordContextOutcome(input: ContextOutcomeSubmission): ContextOutcomeReceipt;
  listContextOutcomes(workspaceId: string, fingerprintId: string): ContextOutcomeReceipt[];
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

export function contextOutcomeDigest(input: ContextOutcomeSubmission, bundleDigest: string): string {
  return `sha256:${createHash("sha256").update(stable({ ...input, bundleDigest })).digest("hex")}`;
}

export function createContextOutcomeReceipt(
  input: ContextOutcomeSubmission,
  bundleDigest: string,
  createdAt: string,
): ContextOutcomeReceipt {
  const parsed = contextOutcomeSubmissionSchema.parse(input);
  const outcomeDigest = contextOutcomeDigest(parsed, bundleDigest);
  return contextOutcomeReceiptSchema.parse({
    schemaVersion: "abcm.eval.context-outcome/v1",
    ...parsed,
    outcomeId: `outcome-${outcomeDigest.slice("sha256:".length, "sha256:".length + 24)}`,
    bundleDigest,
    outcomeDigest,
    createdAt,
  });
}
