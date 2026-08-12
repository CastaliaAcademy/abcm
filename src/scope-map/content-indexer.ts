import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, posix } from "node:path";

import { z } from "zod/v4";
import { parse } from "yaml";

import type { ResolvedWorkspace } from "../workspace/types.js";
import type {
  DocumentRecord,
  ExecutableResourceRecord,
  FileClassification,
  FileRecord,
  MapDiagnostic,
  ScopeNode,
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
    links: z.array(z.string()).optional(),
    controlMode: z.string().optional(),
  })
  .passthrough();

type DocumentMetadata = z.infer<typeof documentMetadataSchema>;

export interface ScopeContentIndex {
  files: FileRecord[];
  documentCandidates: DocumentRecord[];
  executableResources: ExecutableResourceRecord[];
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
    return documentMetadataSchema.parse(parse(match[1] ?? ""));
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
    taskSelectors: [],
    links: metadata.links ?? [],
    contextPolicy: metadata.controlMode ?? "default",
    storageMode: "managed",
  };
}

export async function indexScopeContent(
  workspace: ResolvedWorkspace,
  scope: ScopeNode,
): Promise<ScopeContentIndex> {
  const scopeRoot = join(workspace.root, scope.relativePath);
  const files: FileRecord[] = [];
  const documentCandidates: DocumentRecord[] = [];
  const executableResources: ExecutableResourceRecord[] = [];

  const indexFile = async (absolutePath: string, scopeRelativePath: string): Promise<void> => {
    if (isIgnoredFile(basename(scopeRelativePath))) return;
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) return;
    const content = new Uint8Array(await readFile(absolutePath));
    const fileChecksum = checksum(content);
    const fileClassification = classification(scopeRelativePath);
    const relativePath = scope.relativePath === "" ? scopeRelativePath : posix.join(scope.relativePath, scopeRelativePath);
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
  };

  const visit = async (absoluteDirectory: string, scopeRelativeDirectory: string): Promise<void> => {
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
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
    try {
      await indexFile(join(scopeRoot, file), file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const directory of MANAGED_DIRECTORIES) {
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
  return { files, documentCandidates, executableResources };
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
