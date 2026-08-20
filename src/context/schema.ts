import { z } from "zod/v4";

import type { BuildTaskContextRequest } from "./types.js";

const textList = z.array(z.string().min(1)).max(256);
const canonicalScopeId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const canonicalScopeUri = z.string().regex(/^abcm:\/\/scope\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const exactScopeReference = z.union([canonicalScopeId, canonicalScopeUri]);
const safeDocumentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const safeRepositoryPath = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some(part => part === "" || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "Repository selector must be a safe relative path." });
  }
});
const expectedKind = safeDocumentId.optional();
const explicitDocumentReference = z.discriminatedUnion("selector", [
  z.object({ selector: z.literal("document-id"), documentId: safeDocumentId, expectedKind }).strict(),
  z.object({ selector: z.literal("uri"), uri: z.string().regex(/^abcm:\/\/(?:artifact|document|plan|architecture|lineage)\/[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/), expectedKind }).strict(),
  z.object({ selector: z.literal("repository-file"), path: safeRepositoryPath, expectedKind }).strict(),
  z.object({ selector: z.literal("repository-directory"), path: safeRepositoryPath, recursive: z.boolean().optional(), expectedKind }).strict(),
  z.object({ selector: z.literal("repository-prefix"), prefix: safeRepositoryPath, expectedKind }).strict(),
]);

function exactScopeId(reference: string): string {
  return reference.startsWith("abcm://scope/") ? reference.slice("abcm://scope/".length) : reference;
}

const exactScopeList = z.array(exactScopeReference).min(1).max(8).superRefine((references, context) => {
  const seen = new Set<string>();
  for (const [index, reference] of references.entries()) {
    const id = exactScopeId(reference);
    if (seen.has(id)) {
      context.addIssue({ code: "custom", path: [index], message: "Exact scope references must be unique after canonicalization." });
    }
    seen.add(id);
  }
});

const targetHints = z.union([
  textList,
  z.object({
    scopeIds: exactScopeList.optional(),
    repositoryPaths: textList.optional(),
    componentNames: textList.optional(),
  }).strict(),
]);

export const buildTaskContextSchema = z.object({
  domainLanguageBootstrapId: z.string().min(1),
  roleId: z.string().min(1),
  taskType: z.string().min(1),
  goal: z.string().min(1).max(16_384),
  canonicalDomains: textList.optional(),
  canonicalTerms: textList.optional(),
  keywords: textList.optional(),
  targetHints: targetHints.optional(),
  explicitLinks: textList.optional(),
  artifacts: textList.optional(),
  repositoryPaths: textList.optional(),
  budgetProfile: z.string().min(1).max(128).optional(),
  requestedSkillIds: textList.optional(),
  explicitDocumentLinks: textList.optional(),
  explicitDocuments: z.array(explicitDocumentReference).min(1).max(64).optional(),
  approvalId: z.string().min(1).max(256).optional(),
  execution: z.object({
    planId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128),
    assignmentId: z.string().min(1).max(128).optional(),
  }).strict().optional(),
}).strict();

export type BuildTaskContextInput = z.infer<typeof buildTaskContextSchema>;

export function normalizeBuildTaskContextInput(input: BuildTaskContextInput): BuildTaskContextRequest {
  const objectHints = input.targetHints !== undefined && !Array.isArray(input.targetHints) ? input.targetHints : undefined;
  const exactScopeIds = objectHints?.scopeIds?.map(exactScopeId);
  const flatHints = Array.isArray(input.targetHints)
    ? input.targetHints
    : [...(objectHints?.componentNames ?? [])];
  const repositoryPaths = [...(input.repositoryPaths ?? []), ...(objectHints?.repositoryPaths ?? [])];
  return {
    domainLanguageBootstrapId: input.domainLanguageBootstrapId,
    roleId: input.roleId,
    taskType: input.taskType,
    goal: input.goal,
    ...(input.canonicalDomains === undefined ? {} : { canonicalDomains: input.canonicalDomains }),
    ...(input.canonicalTerms === undefined ? {} : { canonicalTerms: input.canonicalTerms }),
    ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
    ...(flatHints.length === 0 ? {} : { targetHints: flatHints }),
    ...(exactScopeIds === undefined ? {} : { exactScopeIds }),
    ...(input.explicitLinks === undefined ? {} : { explicitLinks: input.explicitLinks }),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    ...(repositoryPaths.length === 0 ? {} : { repositoryPaths }),
    ...(input.budgetProfile === undefined ? {} : { budgetProfile: input.budgetProfile }),
    ...(input.requestedSkillIds === undefined ? {} : { requestedSkillIds: input.requestedSkillIds }),
    ...(input.explicitDocumentLinks === undefined ? {} : { explicitDocumentLinks: input.explicitDocumentLinks }),
    ...(input.explicitDocuments === undefined ? {} : { explicitDocuments: input.explicitDocuments }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    ...(input.execution === undefined ? {} : { execution: {
      planId: input.execution.planId,
      runId: input.execution.runId,
      ...(input.execution.assignmentId === undefined ? {} : { assignmentId: input.execution.assignmentId }),
    } }),
  };
}
