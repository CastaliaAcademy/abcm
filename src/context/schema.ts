import { z } from "zod/v4";

import type { BuildTaskContextRequest } from "./types.js";

const textList = z.array(z.string().min(1)).max(256);
const targetHints = z.union([
  textList,
  z.object({
    scopeIds: textList.optional(),
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
  const flatHints = Array.isArray(input.targetHints)
    ? input.targetHints
    : [...(objectHints?.scopeIds ?? []), ...(objectHints?.componentNames ?? [])];
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
    ...(input.explicitLinks === undefined ? {} : { explicitLinks: input.explicitLinks }),
    ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
    ...(repositoryPaths.length === 0 ? {} : { repositoryPaths }),
    ...(input.budgetProfile === undefined ? {} : { budgetProfile: input.budgetProfile }),
    ...(input.requestedSkillIds === undefined ? {} : { requestedSkillIds: input.requestedSkillIds }),
    ...(input.explicitDocumentLinks === undefined ? {} : { explicitDocumentLinks: input.explicitDocumentLinks }),
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    ...(input.execution === undefined ? {} : { execution: {
      planId: input.execution.planId,
      runId: input.execution.runId,
      ...(input.execution.assignmentId === undefined ? {} : { assignmentId: input.execution.assignmentId }),
    } }),
  };
}
