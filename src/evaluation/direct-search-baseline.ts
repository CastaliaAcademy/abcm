import { createHash } from "node:crypto";

import type { WorkspaceFileService } from "../workspace/file-service.js";

export interface DirectSearchBaselineRequest {
  workspaceId: string;
  queryTerms: readonly string[];
  allowedPathPrefixes: readonly string[];
  includeExtensions?: readonly string[];
  claimChecks?: readonly { id: string; allTerms: readonly string[] }[];
  maxFiles?: number;
  maxReadBytes?: number;
  /** Server-owned authorization filter. It is deliberately excluded from the result identity. */
  authorizePath?: (path: string) => boolean;
}

export interface DirectSearchBaselineResult {
  mode: "actual-search-trace";
  workspaceId: string;
  queryTerms: readonly string[];
  allowedPathPrefixes: readonly string[];
  trace: {
    listedPath: "";
    candidateCount: number;
    reads: readonly { path: string; checksum: string; size: number; matchedTerms: readonly string[] }[];
  };
  selectedDocuments: readonly { documentId: string; path: string; checksum: string; tokenEstimate: number; matchedTerms: readonly string[] }[];
  retrievedClaimIds: readonly string[];
  totalInputTokens: number;
  resultDigest: string;
}

function normalizedPathPrefix(prefix: string): string {
  if (prefix === "" || prefix.startsWith("/") || prefix.includes("\\") || prefix.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`Direct-search prefix '${prefix}' is not a safe workspace-relative path.`);
  }
  return prefix.replace(/\/$/, "");
}

function documentId(content: string, path: string): string {
  const match = /^---\r?\n[\s\S]*?^id:\s*["']?([^\s"']+)["']?\s*$/m.exec(content);
  return match?.[1] ?? path;
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function tokens(content: Uint8Array): number {
  return Math.ceil(content.byteLength / 4);
}

export async function runDirectSearchBaseline(
  files: WorkspaceFileService,
  request: DirectSearchBaselineRequest,
  signal?: AbortSignal,
): Promise<DirectSearchBaselineResult> {
  const prefixes = [...new Set(request.allowedPathPrefixes.map(normalizedPathPrefix))].sort();
  if (prefixes.length === 0) throw new Error("Direct search requires at least one allowed path prefix.");
  const terms = [...new Set(request.queryTerms.map(term => term.trim().toLocaleLowerCase("ru-RU")).filter(Boolean))].sort();
  if (terms.length === 0) throw new Error("Direct search requires at least one query term.");
  const extensions = request.includeExtensions ?? [".md"];
  const claimChecks = (request.claimChecks ?? []).map(claim => ({
    id: claim.id.trim(),
    allTerms: [...new Set(claim.allTerms.map(term => term.trim().toLocaleLowerCase("ru-RU")).filter(Boolean))],
  }));
  if (new Set(claimChecks.map(claim => claim.id)).size !== claimChecks.length || claimChecks.some(claim => claim.id === "" || claim.allTerms.length === 0)) {
    throw new Error("Direct-search claim checks require unique non-empty ids and at least one non-empty term.");
  }
  const maxFiles = request.maxFiles ?? 10_000;
  const maxReadBytes = request.maxReadBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0 || !Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) throw new Error("Direct-search limits must be positive safe integers.");

  const listed = await files.list(request.workspaceId, "", true, signal);
  const candidates = listed
    .filter(entry => entry.kind === "file")
    .filter(entry => prefixes.some(prefix => entry.path === prefix || entry.path.startsWith(`${prefix}/`)))
    .filter(entry => request.authorizePath?.(entry.path) ?? true)
    .filter(entry => extensions.some(extension => entry.path.endsWith(extension)))
    .sort((left, right) => left.path.localeCompare(right.path));
  if (candidates.length > maxFiles) throw new Error(`Direct-search candidate count ${candidates.length} exceeds limit ${maxFiles}.`);

  let readBytes = 0;
  const reads: Array<{ path: string; checksum: string; size: number; matchedTerms: string[] }> = [];
  const selected: Array<{ documentId: string; path: string; checksum: string; tokenEstimate: number; matchedTerms: string[]; score: number }> = [];
  const selectedBodies: string[] = [];
  for (const candidate of candidates) {
    const file = await files.read(request.workspaceId, candidate.path, signal);
    readBytes += file.content.byteLength;
    if (readBytes > maxReadBytes) throw new Error(`Direct-search read bytes exceed limit ${maxReadBytes}.`);
    const content = new TextDecoder().decode(file.content);
    const searchable = `${candidate.path}\n${content}`.toLocaleLowerCase("ru-RU");
    const matchedTerms = terms.filter(term => searchable.includes(term));
    reads.push({ path: candidate.path, checksum: file.entry.checksum, size: file.content.byteLength, matchedTerms });
    if (matchedTerms.length === 0) continue;
    selectedBodies.push(searchable);
    selected.push({
      documentId: documentId(content, candidate.path),
      path: candidate.path,
      checksum: file.entry.checksum,
      tokenEstimate: tokens(file.content),
      matchedTerms,
      score: matchedTerms.length,
    });
  }
  selected.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  const selectedDocuments = selected.map(({ score: _score, ...document }) => document);
  const selectedCorpus = selectedBodies.join("\n");
  const retrievedClaimIds = claimChecks.filter(claim => claim.allTerms.every(term => selectedCorpus.includes(term))).map(claim => claim.id);
  const identity = {
    workspaceId: request.workspaceId,
    queryTerms: terms,
    allowedPathPrefixes: prefixes,
    reads,
    selectedDocuments,
    retrievedClaimIds,
  };
  return {
    mode: "actual-search-trace",
    workspaceId: request.workspaceId,
    queryTerms: terms,
    allowedPathPrefixes: prefixes,
    trace: { listedPath: "", candidateCount: candidates.length, reads },
    selectedDocuments,
    retrievedClaimIds,
    totalInputTokens: selectedDocuments.reduce((sum, document) => sum + document.tokenEstimate, 0),
    resultDigest: digest(identity),
  };
}
