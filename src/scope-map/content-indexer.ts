import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";

import { z } from "zod/v4";
import { throwIfAborted } from "../core/operation.js";
import { parseSafeYaml } from "../core/safe-yaml.js";
import type { ResolvedWorkspace } from "../workspace/types.js";
import type {
  DocumentRecord,
  ExecutableResourceRecord,
  FileClassification,
  FileRecord,
  MapDiagnostic,
  ScopeNode,
  SkillDescriptor,
} from "./types.js";

const MANAGED_DIRECTORIES = ["config", "domain-language", "agents", "artifacts", "architecture"] as const;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".svn",
  ".abcm",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
  "tmp",
]);
const EXECUTABLE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".py", ".sh", ".bash", ".rb", ".pl"]);

const documentMetadataSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    status: z.string().optional(),
    required: z.boolean().optional(),
    requiredFor: z.array(z.string()).optional(),
    audiences: z.array(z.string()).optional(),
    taskTypes: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    domain: z.string().min(1).optional(),
    links: z.array(z.string()).optional(),
    controlMode: z.string().optional(),
    projection: z.enum(["full", "section", "summary", "metadata", "reference"]).optional(),
  })
  .passthrough();

type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

export interface ScopeContentIndex {
  files: FileRecord[];
  documentCandidates: DocumentRecord[];
  executableResources: ExecutableResourceRecord[];
  skills: SkillDescriptor[];
  diagnostics?: MapDiagnostic[];
}

const skillMetadataSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  compatibility: z.string().default(""),
  metadata: z.record(z.string(), z.string()).default({}),
}).passthrough();

function csv(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map(entry => entry.trim()).filter(Boolean))].sort();
}

function skillDescriptor(scope: ScopeNode, scopeRelativePath: string, relativePath: string, fileChecksum: string, content: Uint8Array): SkillDescriptor | undefined {
  if (!/^agents\/skills\/[^/]+\/SKILL\.md$/.test(scopeRelativePath)) return undefined;
  const directoryName = scopeRelativePath.split("/")[2]!;
  const text = new TextDecoder().decode(content);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return undefined;
  const parsed = skillMetadataSchema.parse(parseSafeYaml(match[1] ?? ""));
  if (parsed.name !== directoryName) return undefined;
  const metadata = parsed.metadata;
  const current = metadata["abcm-skill-strategy"];
  const legacy = metadata["abcm-context-strategy"];
  const strategy = current ?? legacy;
  if (!(["global", "scope", "by-link", "by-description", "manual"] as const).includes(strategy as never)) return undefined;
  const warnings: SkillDescriptor["warnings"][number][] = [];
  if (current === undefined && legacy !== undefined) warnings.push("SKILL_CONTEXT_STRATEGY_DEPRECATED");
  if (metadata["abcm-context-base"] !== undefined) warnings.push("SKILL_CONTEXT_BASE_REMOVED");
  return {
    skillId: parsed.name,
    name: parsed.name,
    description: parsed.description,
    sourceScopeId: scope.scopeId,
    relativePath,
    checksum: fileChecksum,
    compatibility: parsed.compatibility,
    strategy: strategy as SkillDescriptor["strategy"],
    lifecycle: metadata["abcm-lifecycle"] ?? "active",
    roles: csv(metadata["abcm-roles"]),
    taskTypes: csv(metadata["abcm-task-types"]),
    domains: csv(metadata["abcm-domains"]),
    tags: csv(metadata["abcm-tags"]),
    requiredKinds: csv(metadata["abcm-required-kinds"]),
    requiredTags: csv(metadata["abcm-required-tags"]),
    requiredLinks: csv(metadata["abcm-required-links"]),
    warnings,
  };
}

function checksum(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function isIgnoredFile(name: string): boolean {
  return (
    name === ".DS_Store" ||
    name === "Thumbs.db" ||
    name.endsWith(".lock") ||
    name.endsWith(".log") ||
    name.endsWith(".tmp") ||
    name.endsWith(".map") ||
    name.endsWith(".min.js")
  );
}

function isExecutableResource(scopeRelativePath: string): boolean {
  const path = `/${scopeRelativePath}`;
  if (/\/agents\/skills\/[^/]+\/scripts\//.test(path)) return true;
  if (!EXECUTABLE_EXTENSIONS.has(extname(scopeRelativePath).toLowerCase())) return false;
  return /\/artifacts\/(?:evals|reports\/statistics)\//.test(path);
}

function classification(scopeRelativePath: string): FileClassification {
  if (scopeRelativePath === "scope.yaml") return "scope_manifest";
  if (scopeRelativePath.startsWith("config/")) return "configuration";
  if (scopeRelativePath.startsWith("domain-language/")) return "domain_language";
  if (isExecutableResource(scopeRelativePath)) return "executable_resource";
  if (scopeRelativePath.startsWith("agents/")) return "agent_definition";
  return "context_document";
}

function languageFor(path: string): string {
  const extension = extname(path).toLowerCase();
  return (
    {
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".ts": "typescript",
      ".py": "python",
      ".sh": "shell",
      ".bash": "shell",
      ".rb": "ruby",
      ".pl": "perl",
    } as Record<string, string>
  )[extension] ?? "unknown";
}

function frontmatter(content: Uint8Array): DocumentMetadata | undefined {
  const text = new TextDecoder().decode(content);
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return undefined;
  try {
    return documentMetadataSchema.parse(parseSafeYaml(match[1] ?? ""));
  } catch {
    return undefined;
  }
}

function documentFrom(
  scope: ScopeNode,
  relativePath: string,
  fileChecksum: string,
  metadata: DocumentMetadata,
): DocumentRecord {
  return {
    documentId: metadata.id,
    kind: metadata.kind,
    title: metadata.title,
    scopeId: scope.scopeId,
    relativePath,
    checksum: fileChecksum,
    lifecycle: metadata.status ?? "active",
    requiredSelectors: [
      ...(metadata.required === true ? ["always"] : []),
      ...(metadata.requiredFor ?? []),
    ],
    roleSelectors: metadata.audiences ?? [],
    taskSelectors: metadata.taskTypes ?? [],
    tags: metadata.tags ?? [],
    ...(metadata.domain === undefined ? {} : { domain: metadata.domain }),
    links: metadata.links ?? [],
    contextPolicy: metadata.controlMode ?? "default",
    ...(metadata.projection === undefined ? {} : { projectionPolicy: metadata.projection }),
    storageMode: "managed",
  };
}

export async function indexScopeContent(
  workspace: ResolvedWorkspace,
  scope: ScopeNode,
  signal?: AbortSignal,
): Promise<ScopeContentIndex> {
  throwIfAborted(signal);
  const scopeRoot = join(workspace.root, scope.relativePath);
  const files: FileRecord[] = [];
  const documentCandidates: DocumentRecord[] = [];
  const executableResources: ExecutableResourceRecord[] = [];
  const skills: SkillDescriptor[] = [];
  const diagnostics: MapDiagnostic[] = [];

  const indexFile = async (absolutePath: string, scopeRelativePath: string): Promise<void> => {
    throwIfAborted(signal);
    if (isIgnoredFile(basename(scopeRelativePath))) return;
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) return;
    const relativePath = scope.relativePath === "" ? scopeRelativePath : posix.join(scope.relativePath, scopeRelativePath);
    if (metadata.size > workspace.maxIndexBytes) {
      diagnostics.push({
        code: "FILE_TOO_LARGE",
        severity: "warning",
        path: relativePath,
        scopeId: scope.scopeId,
        message: `File was not indexed because it exceeds maxIndexBytes=${workspace.maxIndexBytes}.`,
      });
      return;
    }
    const content = new Uint8Array(await readFile(absolutePath));
    throwIfAborted(signal);
    const fileChecksum = checksum(content);
    const fileClassification = classification(scopeRelativePath);
    const parsedMetadata = fileClassification === "context_document" ? frontmatter(content) : undefined;
    files.push({
      scopeId: scope.scopeId,
      relativePath,
      size: metadata.size,
      mtime: Math.trunc(metadata.mtimeMs),
      checksum: fileChecksum,
      parseStatus: parsedMetadata === undefined ? "not_applicable" : "parsed",
      classification: fileClassification,
      storageMode: "managed",
    });
    if (parsedMetadata !== undefined) {
      documentCandidates.push(documentFrom(scope, relativePath, fileChecksum, parsedMetadata));
    }
    if (fileClassification === "executable_resource") {
      executableResources.push({
        resourceId: `resource:${scope.scopeId}:${scopeRelativePath}`,
        scopeId: scope.scopeId,
        relativePath,
        language: languageFor(relativePath),
        checksum: fileChecksum,
        activationStatus: "required",
        permissionsProfile: "executable_resource.read",
      });
    }
    if (fileClassification === "agent_definition") {
      const descriptor = skillDescriptor(scope, scopeRelativePath, relativePath, fileChecksum, content);
      if (descriptor !== undefined) skills.push(descriptor);
    }
  };

  const visit = async (absoluteDirectory: string, scopeRelativeDirectory: string): Promise<void> => {
    throwIfAborted(signal);
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      throwIfAborted(signal);
      if (child.isSymbolicLink() || workspace.deniedDirectories.has(child.name)) continue;
      if (child.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(child.name)) continue;
        const childRelative = posix.join(scopeRelativeDirectory, child.name);
        if (childRelative === "architecture/rendered") continue;
        await visit(join(absoluteDirectory, child.name), childRelative);
      } else if (child.isFile()) {
        await indexFile(join(absoluteDirectory, child.name), posix.join(scopeRelativeDirectory, child.name));
      }
    }
  };

  for (const file of ["scope.yaml", "README.md"] as const) {
    throwIfAborted(signal);
    try {
      await indexFile(join(scopeRoot, file), file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const directory of MANAGED_DIRECTORIES) {
    throwIfAborted(signal);
    try {
      const metadata = await stat(join(scopeRoot, directory));
      if (metadata.isDirectory()) await visit(join(scopeRoot, directory), directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  documentCandidates.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  executableResources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  skills.sort((left, right) => `${left.skillId}/${left.sourceScopeId}`.localeCompare(`${right.skillId}/${right.sourceScopeId}`));
  return { files, documentCandidates, executableResources, skills, diagnostics };
}

export function resolveDocumentCandidates(
  candidates: readonly DocumentRecord[],
  diagnostics: MapDiagnostic[],
): DocumentRecord[] {
  const byId = new Map<string, DocumentRecord[]>();
  for (const candidate of candidates) {
    const current = byId.get(candidate.documentId) ?? [];
    current.push(candidate);
    byId.set(candidate.documentId, current);
  }
  const documents: DocumentRecord[] = [];
  for (const [documentId, entries] of [...byId.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (entries.length === 1) {
      documents.push(entries[0]!);
      continue;
    }
    const first = entries[0]!;
    diagnostics.push({
      code: "DOCUMENT_ID_DUPLICATE",
      severity: "scope_error",
      path: first.relativePath,
      scopeId: first.scopeId,
      message: `Document id '${documentId}' is duplicated at ${entries.map(entry => entry.relativePath).join(", ")}.`,
    });
  }
  return documents.sort((left, right) => left.documentId.localeCompare(right.documentId));
}
