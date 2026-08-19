import { posix } from "node:path";
import { stringify } from "yaml";
import { z } from "zod/v4";

import { AbcmError } from "../core/errors.js";
import { throwIfAborted } from "../core/operation.js";
import { parseSafeYaml } from "../core/safe-yaml.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { MapDiagnostic, MapRevision, ScopeNode } from "../scope-map/types.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type { DeletePreconditions, WritePreconditions } from "../workspace/types.js";

export const BUILTIN_FILE_ARCHITECTURE = "abcm-mvp-agent-spec-v0.5" as const;
export const ARCHITECTURE_POLICY_FILE = "config/architecture.yaml" as const;

const targetIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);

export const architecturePolicyInputSchema = z.object({
  enforcement: z.literal("required").default("required"),
  architecture: z.literal(BUILTIN_FILE_ARCHITECTURE).default(BUILTIN_FILE_ARCHITECTURE),
}).strict();

export const architecturePolicyDocumentSchema = z.object({
  apiVersion: z.literal("abcm/v1"),
  kind: z.literal("ArchitecturePolicy"),
  enforcement: z.literal("required"),
  architecture: z.literal(BUILTIN_FILE_ARCHITECTURE),
}).strict();

export const architecturePolicyTargetSchema = z.object({
  workspaceId: targetIdSchema,
  projectId: targetIdSchema.optional(),
}).strict();

export type ArchitecturePolicyInput = z.input<typeof architecturePolicyInputSchema>;
export type ArchitecturePolicyTarget = z.infer<typeof architecturePolicyTargetSchema>;

const checksumSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const architecturePolicyRecordSchema = z.object({
  workspaceId: z.string(),
  projectId: z.string().optional(),
  level: z.enum(["workspace", "project"]),
  enforcement: z.literal("required"),
  architecture: z.literal(BUILTIN_FILE_ARCHITECTURE),
  sourcePath: z.string(),
  checksum: checksumSchema,
}).strict();
export const architecturePolicyResolutionSchema = z.object({
  target: architecturePolicyTargetSchema,
  configured: architecturePolicyRecordSchema.nullable(),
  effective: architecturePolicyRecordSchema.nullable(),
}).strict();
export const architectureViolationSchema = z.object({
  code: z.enum([
    "ARCHITECTURE_SCOPE_HIERARCHY_INVALID",
    "ARCHITECTURE_SCOPE_MANIFEST_INVALID",
    "ARCHITECTURE_DOMAIN_LANGUAGE_REQUIRED",
    "ARCHITECTURE_PROJECT_LANGUAGE_INVALID",
    "ARCHITECTURE_CONTENT_PLACEMENT_INVALID",
  ]),
  path: z.string(),
  scopeId: z.string().optional(),
  message: z.string(),
}).strict();
export const architectureComplianceSchema = z.object({
  target: architecturePolicyTargetSchema,
  status: z.enum(["not_configured", "compliant", "noncompliant"]),
  effectivePolicy: architecturePolicyRecordSchema.nullable(),
  mapRevision: checksumSchema,
  mapDigest: checksumSchema,
  violations: z.array(architectureViolationSchema),
}).strict();

export interface ArchitecturePolicyRecord {
  workspaceId: string;
  projectId?: string;
  level: "workspace" | "project";
  enforcement: "required";
  architecture: typeof BUILTIN_FILE_ARCHITECTURE;
  sourcePath: string;
  checksum: string;
}

export interface ArchitecturePolicyResolution {
  target: ArchitecturePolicyTarget;
  configured: ArchitecturePolicyRecord | null;
  effective: ArchitecturePolicyRecord | null;
}

export interface ArchitectureViolation {
  code:
    | "ARCHITECTURE_SCOPE_HIERARCHY_INVALID"
    | "ARCHITECTURE_SCOPE_MANIFEST_INVALID"
    | "ARCHITECTURE_DOMAIN_LANGUAGE_REQUIRED"
    | "ARCHITECTURE_PROJECT_LANGUAGE_INVALID"
    | "ARCHITECTURE_CONTENT_PLACEMENT_INVALID";
  path: string;
  scopeId?: string;
  message: string;
}

export interface ArchitectureCompliance {
  target: ArchitecturePolicyTarget;
  status: "not_configured" | "compliant" | "noncompliant";
  effectivePolicy: ArchitecturePolicyRecord | null;
  mapRevision: string;
  mapDigest: string;
  violations: readonly ArchitectureViolation[];
}

const diagnosticCodes = new Map<MapDiagnostic["code"], ArchitectureViolation["code"]>([
  ["SCOPE_HIERARCHY_INVALID", "ARCHITECTURE_SCOPE_HIERARCHY_INVALID"],
  ["SCOPE_MANIFEST_INVALID", "ARCHITECTURE_SCOPE_MANIFEST_INVALID"],
  ["DOMAIN_LANGUAGE_CONFIGURATION_INVALID", "ARCHITECTURE_DOMAIN_LANGUAGE_REQUIRED"],
  ["PROJECT_LANGUAGE_CONFIGURATION_INVALID", "ARCHITECTURE_PROJECT_LANGUAGE_INVALID"],
  ["ARTIFACT_PLACEMENT_INVALID", "ARCHITECTURE_CONTENT_PLACEMENT_INVALID"],
]);

function isMissing(error: unknown): boolean {
  return error instanceof AbcmError && error.code === "FILE_NOT_FOUND";
}

function inSubtree(path: string, root: string): boolean {
  return root === "" || path === root || path.startsWith(`${root}/`);
}

export class ArchitecturePolicyService {
  readonly #files: WorkspaceFileService;
  readonly #scopeMap: ScopeMapService;

  constructor(files: WorkspaceFileService, scopeMap: ScopeMapService) {
    this.#files = files;
    this.#scopeMap = scopeMap;
  }

  async set(
    targetInput: ArchitecturePolicyTarget,
    input: ArchitecturePolicyInput,
    preconditions: WritePreconditions = {},
    signal?: AbortSignal,
  ): Promise<ArchitecturePolicyRecord> {
    throwIfAborted(signal);
    const target = this.#target(targetInput);
    let policy: z.infer<typeof architecturePolicyInputSchema>;
    try {
      policy = architecturePolicyInputSchema.parse(input);
    } catch (error) {
      throw new AbcmError("REQUEST_INVALID", "Architecture policy is invalid.", {
        issues: error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) : [],
      });
    }
    const sourcePath = this.#sourcePath(target);
    const content = stringify({
      apiVersion: "abcm/v1",
      kind: "ArchitecturePolicy",
      enforcement: policy.enforcement,
      architecture: policy.architecture,
    });
    const entry = await this.#files.write(target.workspaceId, sourcePath, new TextEncoder().encode(content), preconditions, signal);
    return this.#record(target, sourcePath, entry.checksum, policy);
  }

  async get(targetInput: ArchitecturePolicyTarget, signal?: AbortSignal): Promise<ArchitecturePolicyRecord | null> {
    throwIfAborted(signal);
    const target = this.#target(targetInput);
    const sourcePath = this.#sourcePath(target);
    try {
      const result = await this.#files.read(target.workspaceId, sourcePath, signal);
      let policy: z.infer<typeof architecturePolicyDocumentSchema>;
      try {
        policy = architecturePolicyDocumentSchema.parse(parseSafeYaml(new TextDecoder().decode(result.content)));
      } catch (error) {
        throw new AbcmError("ARCHITECTURE_POLICY_INVALID", `Architecture policy '${sourcePath}' is invalid.`, {
          workspaceId: target.workspaceId,
          ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
          sourcePath,
          issues: error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) : [],
        });
      }
      return this.#record(target, sourcePath, result.entry.checksum, policy);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async delete(targetInput: ArchitecturePolicyTarget, preconditions: DeletePreconditions = {}, signal?: AbortSignal): Promise<void> {
    const target = this.#target(targetInput);
    await this.#files.delete(target.workspaceId, this.#sourcePath(target), preconditions, signal);
  }

  async resolve(targetInput: ArchitecturePolicyTarget, signal?: AbortSignal): Promise<ArchitecturePolicyResolution> {
    const target = this.#target(targetInput);
    const configured = await this.get(target, signal);
    if (configured !== null || target.projectId === undefined) return { target, configured, effective: configured };
    return { target, configured: null, effective: await this.get({ workspaceId: target.workspaceId }, signal) };
  }

  async list(workspaceId: string, signal?: AbortSignal): Promise<ArchitecturePolicyRecord[]> {
    const target = this.#target({ workspaceId });
    const revision = this.#scopeMap.getActiveRevision(target.workspaceId);
    const records: ArchitecturePolicyRecord[] = [];
    const workspace = await this.get(target, signal);
    if (workspace !== null) records.push(workspace);
    for (const node of revision.nodes.filter(node => node.kind === "project" && node.status === "valid").sort((left, right) => left.scopeId.localeCompare(right.scopeId))) {
      const policy = await this.get({ workspaceId: target.workspaceId, projectId: node.scopeId }, signal);
      if (policy !== null) records.push(policy);
    }
    return records.sort((left, right) => {
      if (left.level !== right.level) return left.level === "workspace" ? -1 : 1;
      return left.sourcePath.localeCompare(right.sourcePath);
    });
  }

  async check(targetInput: ArchitecturePolicyTarget, signal?: AbortSignal): Promise<ArchitectureCompliance> {
    throwIfAborted(signal);
    const resolution = await this.resolve(targetInput, signal);
    const revision = this.#scopeMap.getActiveRevision(resolution.target.workspaceId);
    if (resolution.effective === null) {
      return { target: resolution.target, status: "not_configured", effectivePolicy: null, mapRevision: revision.revision, mapDigest: revision.digest, violations: [] };
    }
    const root = resolution.target.projectId === undefined ? "" : this.#project(revision, resolution.target.projectId).relativePath;
    const violations = this.#violations(revision, root);
    return {
      target: resolution.target,
      status: violations.length === 0 ? "compliant" : "noncompliant",
      effectivePolicy: resolution.effective,
      mapRevision: revision.revision,
      mapDigest: revision.digest,
      violations,
    };
  }

  async assertProjectCompliant(workspaceId: string, projectId: string, signal?: AbortSignal): Promise<void> {
    const compliance = await this.check({ workspaceId, projectId }, signal);
    if (compliance.status !== "noncompliant") return;
    throw new AbcmError("ARCHITECTURE_POLICY_VIOLATION", `Project '${projectId}' does not comply with required file architecture.`, {
      workspaceId,
      projectId,
      architecture: compliance.effectivePolicy?.architecture,
      violations: compliance.violations,
    });
  }

  #target(input: ArchitecturePolicyTarget): ArchitecturePolicyTarget {
    let target: ArchitecturePolicyTarget;
    try {
      target = architecturePolicyTargetSchema.parse(input);
    } catch (error) {
      throw new AbcmError("REQUEST_INVALID", "Architecture policy target is invalid.", {
        issues: error instanceof z.ZodError ? error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) : [],
      });
    }
    const revision = this.#scopeMap.getActiveRevision(target.workspaceId);
    if (target.projectId !== undefined) this.#project(revision, target.projectId);
    return target;
  }

  #project(revision: MapRevision, projectId: string): ScopeNode {
    const project = revision.nodes.find(node => node.scopeId === projectId && node.kind === "project" && node.status === "valid");
    if (project === undefined) {
      throw new AbcmError("PROJECT_ANCHOR_NOT_RESOLVED", `Project '${projectId}' is not an active project scope.`, { projectId });
    }
    return project;
  }

  #sourcePath(target: ArchitecturePolicyTarget): string {
    if (target.projectId === undefined) return ARCHITECTURE_POLICY_FILE;
    const revision = this.#scopeMap.getActiveRevision(target.workspaceId);
    return posix.join(this.#project(revision, target.projectId).relativePath, ARCHITECTURE_POLICY_FILE);
  }

  #record(
    target: ArchitecturePolicyTarget,
    sourcePath: string,
    checksum: string,
    policy: { enforcement: "required"; architecture: typeof BUILTIN_FILE_ARCHITECTURE },
  ): ArchitecturePolicyRecord {
    return {
      workspaceId: target.workspaceId,
      ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
      level: target.projectId === undefined ? "workspace" : "project",
      enforcement: policy.enforcement,
      architecture: policy.architecture,
      sourcePath,
      checksum,
    };
  }

  #violations(revision: MapRevision, root: string): ArchitectureViolation[] {
    const violations: ArchitectureViolation[] = [];
    const nodes = revision.nodes.filter(node => inSubtree(node.relativePath, root));
    for (const node of nodes) {
      const conventionPath = node.relativePath === ""
        ? "domain-language/DomainLanguageConvention.md"
        : posix.join(node.relativePath, "domain-language/DomainLanguageConvention.md");
      if (!revision.files.some(file => file.relativePath === conventionPath)) {
        violations.push({
          code: "ARCHITECTURE_DOMAIN_LANGUAGE_REQUIRED",
          path: conventionPath,
          scopeId: node.scopeId,
          message: "Every valid scope requires DomainLanguageConvention.md.",
        });
      }
    }
    for (const diagnostic of revision.diagnostics) {
      const code = diagnosticCodes.get(diagnostic.code);
      if (code === undefined || !inSubtree(diagnostic.path, root)) continue;
      violations.push({
        code,
        path: diagnostic.path,
        ...(diagnostic.scopeId === undefined ? {} : { scopeId: diagnostic.scopeId }),
        message: diagnostic.message,
      });
    }
    const unique = new Map(violations.map(violation => [`${violation.code}\0${violation.path}\0${violation.scopeId ?? ""}`, violation]));
    return [...unique.values()].sort((left, right) => `${left.path}/${left.code}`.localeCompare(`${right.path}/${right.code}`));
  }
}
