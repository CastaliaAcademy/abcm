import type { NormalizedTaskIntent, ResolvedScopePath } from "../domain-language/types.js";
import type { SkillConnectionStrategy } from "../scope-map/types.js";

export type SkillConnectionReason =
  | "global_workspace_baseline"
  | "scope_owner_or_descendant"
  | "explicit_skill_link"
  | "description_match"
  | "manual_request";

export interface SkillMatchEvidence {
  field: "name" | "description" | "role" | "task_type" | "domain" | "tag" | "explicit_link" | "scope" | "manual" | "global";
  value: string;
  score: number;
}

export interface ConnectedSkillRecord {
  skillId: string;
  skillDigest: string;
  sourceScopeId: string;
  strategy: SkillConnectionStrategy;
  connectionReasons: readonly SkillConnectionReason[];
  matchEvidence: readonly SkillMatchEvidence[];
  body: string;
  approvalId?: string;
}

export interface SkillContextRequirement {
  sourceSkillId: string;
  kind: "document_kind" | "tag" | "explicit_link";
  value: string;
}

export interface ResolveSkillConnectionsRequest {
  workspaceId: string;
  path: ResolvedScopePath;
  intent: NormalizedTaskIntent;
  roleId: string;
  taskType: string;
  explicitSkillLinks?: readonly string[];
  requestedSkillIds?: readonly string[];
  approvalId?: string;
}

export interface SkillConnectionResult {
  connectedSkills: readonly ConnectedSkillRecord[];
  contextRequirements: readonly SkillContextRequirement[];
  diagnostics: readonly { code: "SKILL_CONTEXT_STRATEGY_DEPRECATED" | "SKILL_CONTEXT_BASE_REMOVED"; skillId: string }[];
}
