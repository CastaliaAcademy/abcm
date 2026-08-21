import { z } from "zod/v4";
import { DOCUMENT_TAG_MAX_LENGTH } from "../scope-map/document-tags.js";
import { buildTaskContextSchema } from "./schema.js";

const id = z.string().min(1).max(256);
const checksum = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const packageId = z.string().regex(/^tag-package-[a-f0-9]{24}$/);

export const contextLinkPackageViewSchema = z.object({
  packageId,
  workspaceId: id,
  tag: z.string().min(1).max(DOCUMENT_TAG_MAX_LENGTH),
  title: z.string().min(2).max(DOCUMENT_TAG_MAX_LENGTH + 1),
  documentIds: z.array(id),
  packageDigest: checksum,
  mapRevision: checksum,
  mapDigest: checksum,
  linkGraphDigest: checksum,
  selectionPolicyVersion: z.literal("context-selection/v3"),
  source: z.literal("document-tags"),
}).strict();
export const contextLinkPackageListInputSchema = z.object({ workspaceId: id }).strict();
export const contextLinkPackageListOutputSchema = z.object({ packages: z.array(contextLinkPackageViewSchema) }).strict();
export const contextLinkPackageGetInputSchema = z.object({ workspaceId: id, packageId }).strict();
export const contextLinkPackageBuildInputSchema = z.object({ workspaceId: id, packageId, request: buildTaskContextSchema }).strict();
export const contextLinkPackageMemberDispositionSchema = z.object({
  documentId: id,
  status: z.enum(["selected", "selector_mismatch", "budget_omitted", "lifecycle_omitted"]),
}).strict();
