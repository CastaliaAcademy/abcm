import { z } from "zod/v4";

export const fileOperationChecksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const workspaceId = z.string().min(1);
const uploadId = z.string().regex(/^upl_[a-f0-9]{32}$/);
const path = z.string().min(1);

export const workspaceUploadStartInputSchema = z.object({
  workspaceId,
  size: z.number().int().nonnegative(),
  checksum: fileOperationChecksumSchema,
  contentType: z.string().min(1).max(255).optional(),
}).strict();

export const workspaceUploadStartOutputSchema = z.object({
  uploadId,
  workspaceId,
  size: z.number().int().nonnegative(),
  checksum: fileOperationChecksumSchema,
  chunkSize: z.number().int().positive(),
  expiresAt: z.string(),
}).strict();

export const workspaceUploadChunkInputSchema = z.object({
  workspaceId,
  uploadId,
  index: z.number().int().nonnegative(),
  content: z.string(),
  encoding: z.literal("base64").default("base64"),
  checksum: fileOperationChecksumSchema,
}).strict();

export const workspaceUploadChunkOutputSchema = z.object({
  uploadId,
  index: z.number().int().nonnegative(),
  accepted: z.literal(true),
  receivedBytes: z.number().int().nonnegative(),
  nextIndex: z.number().int().nonnegative(),
}).strict();

export const workspaceUploadCompleteInputSchema = z.object({ workspaceId, uploadId }).strict();
export const workspaceUploadCompleteOutputSchema = z.object({
  uploadId,
  workspaceId,
  size: z.number().int().nonnegative(),
  checksum: fileOperationChecksumSchema,
  contentType: z.string().optional(),
  expiresAt: z.string(),
  status: z.literal("completed"),
}).strict();
export const workspaceUploadAbortInputSchema = workspaceUploadCompleteInputSchema;
export const workspaceUploadAbortOutputSchema = z.object({ aborted: z.literal(true) }).strict();

const createOperationSchema = z.object({
  operation: z.literal("create"),
  path,
  uploadId,
  ifNoneMatch: z.literal("*"),
}).strict();
const updateOperationSchema = z.object({
  operation: z.literal("update"),
  path,
  uploadId,
  ifMatch: fileOperationChecksumSchema,
}).strict();
const deleteOperationSchema = z.object({
  operation: z.literal("delete"),
  path,
  ifMatch: fileOperationChecksumSchema,
}).strict();
const moveOperationSchema = z.object({
  operation: z.literal("move"),
  from: path,
  to: path,
  ifMatch: fileOperationChecksumSchema,
  overwrite: z.literal(false).default(false),
}).strict();

export const workspaceBatchOperationSchema = z.discriminatedUnion("operation", [
  createOperationSchema,
  updateOperationSchema,
  deleteOperationSchema,
  moveOperationSchema,
]);

const workspaceBatchApplyFields = {
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  expectedMapRevision: fileOperationChecksumSchema,
  dryRun: z.boolean().default(false),
  operations: z.array(workspaceBatchOperationSchema).min(1).max(100),
} as const;

function validateUniqueBatchPaths(
  input: { operations: z.infer<typeof workspaceBatchOperationSchema>[] },
  context: z.RefinementCtx,
): void {
  const paths = new Set<string>();
  for (const [index, operation] of input.operations.entries()) {
    const touched = operation.operation === "move" ? [operation.from, operation.to] : [operation.path];
    for (const touchedPath of touched) {
      if (paths.has(touchedPath)) {
        context.addIssue({ code: "custom", path: ["operations", index], message: "Batch operations must not touch the same path more than once." });
      }
      paths.add(touchedPath);
    }
  }
}

export const workspaceBatchApplyRequestSchema = z.object(workspaceBatchApplyFields).strict().superRefine(validateUniqueBatchPaths);
export const workspaceBatchApplyInputSchema = z.object({ workspaceId, ...workspaceBatchApplyFields }).strict().superRefine(validateUniqueBatchPaths);

const batchResultSchema = z.object({
  index: z.number().int().nonnegative(),
  operation: z.enum(["create", "update", "delete", "move"]),
  status: z.enum(["planned", "applied"]),
  path: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  checksum: fileOperationChecksumSchema.optional(),
}).strict();

export const workspaceBatchApplyOutputSchema = z.object({
  batchId: z.string().regex(/^batch_[a-f0-9]{32}$/),
  status: z.enum(["validated", "applied"]),
  replayed: z.boolean(),
  idempotencyKey: z.string(),
  mapRevisionBefore: fileOperationChecksumSchema,
  mapRevisionAfter: fileOperationChecksumSchema,
  results: z.array(batchResultSchema),
  warnings: z.array(z.string()),
}).strict();

export type WorkspaceUploadStartInput = z.infer<typeof workspaceUploadStartInputSchema>;
export type WorkspaceUploadChunkInput = z.infer<typeof workspaceUploadChunkInputSchema>;
export type WorkspaceBatchApplyInput = z.infer<typeof workspaceBatchApplyInputSchema>;
export type WorkspaceBatchApplyOutput = z.infer<typeof workspaceBatchApplyOutputSchema>;
export type WorkspaceBatchOperation = z.infer<typeof workspaceBatchOperationSchema>;
