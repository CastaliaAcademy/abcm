import { z } from "zod/v4";

const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PORTABLE_PATH_MAX_LENGTH = 1_024;

export const syncChecksumSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const syncCursorSchema = z.string().min(8).max(256).regex(/^[A-Za-z0-9._~-]+$/);
export const syncObjectIdSchema = z.string().regex(/^obj_[A-Za-z0-9_-]{8,124}$/);
export const syncOperationIdSchema = z.string().regex(/^op_[A-Za-z0-9_-]{8,125}$/);
export const syncDeviceIdSchema = z.string().regex(/^device_[A-Za-z0-9_-]{8,121}$/);
export const syncConflictIdSchema = z.string().regex(/^conflict_[A-Za-z0-9_-]{8,119}$/);

export function portablePathKey(path: string): string {
  return path.normalize("NFC").toLocaleLowerCase("en-US");
}

export const syncPortablePathSchema = z.string().min(1).max(PORTABLE_PATH_MAX_LENGTH).superRefine((path, context) => {
  if (path !== path.normalize("NFC")) {
    context.addIssue({ code: "custom", message: "Path must use Unicode NFC normalization." });
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || /[\u0001-\u001f\u007f]/u.test(path)) {
    context.addIssue({ code: "custom", message: "Path is not a portable relative path." });
  }
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    context.addIssue({ code: "custom", message: "Path contains an empty or traversal segment." });
  }
  for (const segment of segments) {
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      context.addIssue({ code: "custom", message: "Path segments must not end with a dot or space." });
    }
    if (WINDOWS_RESERVED_BASENAME.test(segment)) {
      context.addIssue({ code: "custom", message: "Path contains a Windows reserved name." });
    }
  }
  const root = segments[0]?.toLocaleLowerCase("en-US");
  if (root === ".obsidian" || root === "_abcm conflicts") {
    context.addIssue({ code: "custom", message: "Path belongs to an excluded plugin directory." });
  }
});

export const syncCapabilitySchema = z.enum(["read", "write"]);
export const syncDevicePlatformSchema = z.enum(["windows", "linux", "ipados"]);
export const syncDeviceSchema = z.object({
  id: syncDeviceIdSchema,
  name: z.string().min(1).max(160),
  platform: syncDevicePlatformSchema,
}).strict();

export const syncPairingCreateSchema = z.object({
  workspaceId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  projectPrefix: syncPortablePathSchema.optional(),
  capabilities: z.array(syncCapabilitySchema).min(1).max(2).refine(values => new Set(values).size === values.length)
    .refine(values => !values.includes("write") || values.includes("read"), { message: "Write synchronization capability requires read capability for pinned preview." }),
  expiresInSeconds: z.number().int().min(60).max(900).optional(),
}).strict();

export const syncPairingCreateResultSchema = z.object({
  pairingCode: z.string().regex(/^pair_[A-Za-z0-9_-]{8,123}$/),
  expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export const syncPairingRedeemSchema = z.object({
  pairingCode: z.string().regex(/^pair_[A-Za-z0-9_-]{8,123}$/),
  device: syncDeviceSchema,
}).strict();

export const syncDeviceGrantSchema = z.object({
  deviceId: syncDeviceIdSchema,
  credential: z.string().min(32).max(4_096),
  workspaceId: z.string().min(1).max(128),
  projectId: z.string().min(1).max(128),
  projectPrefix: syncPortablePathSchema.nullable(),
  capabilities: z.array(syncCapabilitySchema).min(1).max(2),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const syncInventoryEntrySchema = z.object({
  path: syncPortablePathSchema,
  checksum: syncChecksumSchema,
  size: z.number().int().min(0),
  contentType: z.string().min(1).max(255).optional(),
}).strict();

export const syncPortableInventorySchema = z.array(syncInventoryEntrySchema).max(10_000).superRefine((entries, context) => {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const key = portablePathKey(entry.path);
    const previous = seen.get(key);
    if (previous !== undefined) {
      context.addIssue({
        code: "custom",
        path: [index, "path"],
        message: `Portable path collides with inventory entry ${previous}.`,
      });
    } else {
      seen.set(key, index);
    }
  });
});

export const syncPreviewRequestSchema = z.object({
  cursor: syncCursorSchema.nullable(),
  inventory: syncPortableInventorySchema,
  include: z.array(z.string().min(1).max(256)).max(64).optional(),
  exclude: z.array(z.string().min(1).max(256)).max(64).optional(),
}).strict();

export const syncPreviewActionSchema = z.enum(["create-local", "create-server", "update-local", "update-server", "delete-local", "delete-server", "move-local", "move-server", "conflict", "noop"]);
export const syncPreviewItemSchema = z.object({
  action: syncPreviewActionSchema,
  objectId: syncObjectIdSchema.nullable(),
  path: syncPortablePathSchema,
  previousPath: syncPortablePathSchema.optional(),
  localChecksum: syncChecksumSchema.nullable(),
  serverChecksum: syncChecksumSchema.nullable(),
  size: z.number().int().min(0).nullable(),
}).strict();
export const syncPreviewResultSchema = z.object({
  previewId: z.string().regex(/^preview_[A-Za-z0-9_-]{8,120}$/),
  serverRevision: z.string().min(1).max(256),
  cursor: syncCursorSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  items: z.array(syncPreviewItemSchema).max(10_000),
}).strict();

const changeBase = z.object({
  cursor: syncCursorSchema,
  objectId: syncObjectIdSchema,
  operationId: syncOperationIdSchema,
  originDeviceId: syncDeviceIdSchema.nullable(),
  path: syncPortablePathSchema,
  occurredAt: z.iso.datetime({ offset: true }),
});
const contentMetadata = {
  checksum: syncChecksumSchema,
  size: z.number().int().min(0),
  contentType: z.string().min(1).max(255),
} as const;

export const syncChangeEventSchema = z.discriminatedUnion("kind", [
  changeBase.extend({ kind: z.literal("create"), ...contentMetadata, tombstone: z.literal(false) }).strict(),
  changeBase.extend({ kind: z.literal("update"), baseChecksum: syncChecksumSchema, ...contentMetadata, tombstone: z.literal(false) }).strict(),
  changeBase.extend({ kind: z.literal("delete"), baseChecksum: syncChecksumSchema, tombstone: z.literal(true) }).strict(),
  changeBase.extend({ kind: z.literal("move"), previousPath: syncPortablePathSchema, baseChecksum: syncChecksumSchema, ...contentMetadata, tombstone: z.literal(false) }).strict(),
]);

export const syncChangesResultSchema = z.object({
  changes: z.array(syncChangeEventSchema).max(1_000),
  nextCursor: syncCursorSchema,
  hasMore: z.boolean(),
}).strict();

const operationBase = z.object({ operationId: syncOperationIdSchema, objectId: syncObjectIdSchema, path: syncPortablePathSchema });
const encodedContent = { contentBase64: z.string().base64(), contentType: z.string().min(1).max(255), size: z.number().int().min(0) } as const;
export const syncApplyOperationSchema = z.discriminatedUnion("kind", [
  operationBase.extend({ kind: z.literal("create"), checksum: syncChecksumSchema, ...encodedContent }).strict(),
  operationBase.extend({ kind: z.literal("update"), baseChecksum: syncChecksumSchema, checksum: syncChecksumSchema, ...encodedContent }).strict(),
  operationBase.extend({ kind: z.literal("delete"), baseChecksum: syncChecksumSchema }).strict(),
  operationBase.extend({ kind: z.literal("move"), previousPath: syncPortablePathSchema, baseChecksum: syncChecksumSchema, checksum: syncChecksumSchema }).strict(),
]);

export const syncApplyBatchSchema = z.object({
  cursor: syncCursorSchema,
  previewId: z.string().regex(/^preview_[A-Za-z0-9_-]{8,120}$/),
  serverRevision: z.string().min(1).max(256),
  operations: z.array(syncApplyOperationSchema).min(1).max(100),
}).strict();

const receiptBase = z.object({
  operationId: syncOperationIdSchema,
  cursor: syncCursorSchema,
  objectId: syncObjectIdSchema,
  checksum: syncChecksumSchema.nullable(),
});
export const syncOperationReceiptSchema = z.discriminatedUnion("status", [
  receiptBase.extend({ status: z.literal("applied") }).strict(),
  receiptBase.extend({ status: z.literal("duplicate") }).strict(),
  receiptBase.extend({ status: z.literal("conflict"), conflictId: syncConflictIdSchema }).strict(),
]);
export const syncApplyResultSchema = z.object({ receipts: z.array(syncOperationReceiptSchema).min(1).max(100) }).strict();

export const syncConflictSideSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("present"), checksum: syncChecksumSchema, size: z.number().int().min(0), contentType: z.string().min(1).max(255) }).strict(),
  z.object({ state: z.literal("deleted"), baseChecksum: syncChecksumSchema }).strict(),
]);
export const syncConflictSchema = z.object({
  conflictId: syncConflictIdSchema,
  objectId: syncObjectIdSchema,
  kind: z.enum(["concurrent-update", "delete-update", "move-move", "portable-path"]),
  path: syncPortablePathSchema,
  local: syncConflictSideSchema,
  server: syncConflictSideSchema,
  baseChecksum: syncChecksumSchema.nullable(),
  status: z.enum(["open", "resolved"]),
}).strict();

export const syncConflictResolutionSchema = z.discriminatedUnion("resolution", [
  z.object({ operationId: syncOperationIdSchema, resolution: z.literal("keep-local"), localChecksum: syncChecksumSchema.nullable(), serverChecksum: syncChecksumSchema.nullable() }).strict(),
  z.object({ operationId: syncOperationIdSchema, resolution: z.literal("keep-server"), localChecksum: syncChecksumSchema.nullable(), serverChecksum: syncChecksumSchema.nullable() }).strict(),
  z.object({ operationId: syncOperationIdSchema, resolution: z.literal("keep-both"), localChecksum: syncChecksumSchema.nullable(), serverChecksum: syncChecksumSchema.nullable(), keepBothPath: syncPortablePathSchema }).strict(),
]);

export type SyncApplyBatch = z.infer<typeof syncApplyBatchSchema>;
export type SyncApplyOperation = z.infer<typeof syncApplyOperationSchema>;
export type SyncChangeEvent = z.infer<typeof syncChangeEventSchema>;
export type SyncConflict = z.infer<typeof syncConflictSchema>;
export type SyncConflictResolution = z.infer<typeof syncConflictResolutionSchema>;
export type SyncDeviceGrant = z.infer<typeof syncDeviceGrantSchema>;
export type SyncPreviewRequest = z.infer<typeof syncPreviewRequestSchema>;
export type SyncPreviewResult = z.infer<typeof syncPreviewResultSchema>;
