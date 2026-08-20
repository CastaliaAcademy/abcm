import { createHash } from "node:crypto";
import { posix } from "node:path";

import type {
  DocumentRecord,
  LinkGraphEdge,
  LinkGraphEdgeType,
  LinkGraphHeading,
  LinkGraphNode,
  LinkGraphReference,
  MapDiagnostic,
  TypedLinkGraph,
} from "./types.js";

export interface DocumentLinkDeclaration {
  type: Exclude<LinkGraphEdgeType, "backlink">;
  rawTarget: string;
  sourceLine: number;
  sourceKind: "body" | "frontmatter";
}

export interface DocumentLinkSource {
  documentId: string;
  scopeId: string;
  relativePath: string;
  checksum: string;
  title: string;
  aliases: readonly string[];
  headings: readonly LinkGraphHeading[];
  blocks: readonly string[];
  declarations: readonly DocumentLinkDeclaration[];
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function headingAnchor(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function markdownBodyStart(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === "---") return index + 1;
  }
  return 0;
}

export function parseDocumentLinkSource(
  document: DocumentRecord,
  aliases: readonly string[],
  frontmatterLinks: readonly string[],
  content: string,
): DocumentLinkSource {
  const lines = content.split(/\r?\n/);
  const headings: LinkGraphHeading[] = [];
  const blocks: string[] = [];
  const declarations: DocumentLinkDeclaration[] = frontmatterLinks
    .filter(rawTarget => !/^abcm:\/\/scope\//i.test(rawTarget))
    .map(rawTarget => ({
      type: "domain-relation",
      rawTarget,
      sourceLine: 0,
      sourceKind: "frontmatter",
    }));
  let fence: "```" | "~~~" | undefined;
  for (let index = markdownBodyStart(lines); index < lines.length; index++) {
    const line = lines[index] ?? "";
    const fenceMatch = /^\s*(```|~~~)/.exec(line)?.[1] as "```" | "~~~" | undefined;
    if (fenceMatch !== undefined) {
      fence = fence === undefined ? fenceMatch : fence === fenceMatch ? undefined : fence;
      continue;
    }
    if (fence !== undefined) continue;
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]?.trim();
    if (heading !== undefined && heading !== "") headings.push({ text: heading, anchor: headingAnchor(heading) });
    const block = /(?:^|\s)\^([\p{L}\p{N}-]+)\s*$/u.exec(line)?.[1];
    if (block !== undefined) blocks.push(block);
    const searchableLine = line.replace(/`[^`]*`/g, "");
    const linkPattern = /(?<!\\)(!)?\[\[([^\]\n]+)\]\]/g;
    for (const match of searchableLine.matchAll(linkPattern)) {
      const rawTarget = (match[2] ?? "").split("|", 1)[0]!.trim();
      if (rawTarget === "") continue;
      const fragment = rawTarget.includes("#") ? rawTarget.slice(rawTarget.indexOf("#") + 1) : undefined;
      const type: DocumentLinkDeclaration["type"] = match[1] === "!"
        ? "embed"
        : fragment?.startsWith("^") === true
          ? "block-reference"
          : fragment !== undefined
            ? "heading-reference"
            : "wiki-link";
      declarations.push({ type, rawTarget, sourceLine: index + 1, sourceKind: "body" });
    }
  }
  return {
    documentId: document.documentId,
    scopeId: document.scopeId,
    relativePath: document.relativePath,
    checksum: document.checksum,
    title: document.title,
    aliases: uniqueSorted(aliases),
    headings: [...new Map(headings.map(entry => [`${entry.anchor}\0${entry.text}`, entry])).values()]
      .sort((left, right) => `${left.anchor}/${left.text}`.localeCompare(`${right.anchor}/${right.text}`)),
    blocks: uniqueSorted(blocks),
    declarations,
  };
}

function lookupKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US");
}

function pathKeys(path: string): string[] {
  const normalized = posix.normalize(path).replace(/^\.\//, "");
  const withoutExtension = normalized.toLocaleLowerCase("en-US").endsWith(".md") ? normalized.slice(0, -3) : normalized;
  return uniqueSorted([
    normalized,
    withoutExtension,
    posix.basename(normalized),
    posix.basename(withoutExtension),
  ]).map(lookupKey);
}

function reference(rawTarget: string): LinkGraphReference {
  const withoutDisplay = rawTarget.split("|", 1)[0]!.trim();
  const hash = withoutDisplay.indexOf("#");
  const documentTarget = (hash === -1 ? withoutDisplay : withoutDisplay.slice(0, hash)).trim();
  const fragment = hash === -1 ? undefined : withoutDisplay.slice(hash + 1).trim();
  return {
    rawTarget,
    documentTarget,
    ...(fragment?.startsWith("^") === true
      ? { blockId: fragment.slice(1) }
      : fragment === undefined || fragment === ""
        ? {}
        : { heading: fragment }),
  };
}

function edgeId(parts: unknown): string {
  return `edge:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function addLookup(map: Map<string, Set<string>>, key: string, documentId: string): void {
  const normalized = lookupKey(key);
  if (normalized === "") return;
  const entries = map.get(normalized) ?? new Set<string>();
  entries.add(documentId);
  map.set(normalized, entries);
}

function cycleDocumentIds(edges: readonly LinkGraphEdge[]): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type === "backlink" || edge.status !== "resolved" || edge.toDocumentId === undefined) continue;
    const targets = adjacency.get(edge.fromDocumentId) ?? [];
    targets.push(edge.toDocumentId);
    adjacency.set(edge.fromDocumentId, uniqueSorted(targets));
  }
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles = new Set<string>();
  const visit = (documentId: string): void => {
    indexes.set(documentId, nextIndex);
    lowLinks.set(documentId, nextIndex);
    nextIndex++;
    stack.push(documentId);
    onStack.add(documentId);
    for (const target of adjacency.get(documentId) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(documentId, Math.min(lowLinks.get(documentId)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(documentId, Math.min(lowLinks.get(documentId)!, indexes.get(target)!));
      }
    }
    if (lowLinks.get(documentId) !== indexes.get(documentId)) return;
    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === documentId) break;
    }
    if (component.length > 1 || (adjacency.get(documentId) ?? []).includes(documentId)) {
      for (const member of component) cycles.add(member);
    }
  };
  for (const documentId of [...adjacency.keys()].sort()) if (!indexes.has(documentId)) visit(documentId);
  return cycles;
}

export function buildTypedLinkGraph(
  inputSources: readonly DocumentLinkSource[],
  documents: readonly DocumentRecord[],
  diagnostics: MapDiagnostic[],
): TypedLinkGraph {
  const validDocuments = new Map(documents.map(document => [document.documentId, document]));
  const sources = inputSources
    .filter(source => validDocuments.get(source.documentId)?.relativePath === source.relativePath)
    .sort((left, right) => left.documentId.localeCompare(right.documentId));
  const nodes: LinkGraphNode[] = sources.map(source => ({
    nodeId: `document:${source.documentId}`,
    documentId: source.documentId,
    scopeId: source.scopeId,
    relativePath: source.relativePath,
    checksum: source.checksum,
    title: source.title,
    aliases: source.aliases,
    headings: source.headings,
    blocks: source.blocks,
  }));
  const nodeByDocumentId = new Map(nodes.map(node => [node.documentId, node]));
  const lookup = new Map<string, Set<string>>();
  for (const node of nodes) {
    addLookup(lookup, node.documentId, node.documentId);
    addLookup(lookup, node.title, node.documentId);
    for (const alias of node.aliases) addLookup(lookup, alias, node.documentId);
    for (const key of pathKeys(node.relativePath)) addLookup(lookup, key, node.documentId);
  }
  const edges: LinkGraphEdge[] = [];
  for (const source of sources) {
    for (const declaration of source.declarations) {
      const parsedReference = reference(declaration.rawTarget);
      const uriDocumentId = /^abcm:\/\/(?:artifact|plan|architecture)\/([^/?#]+)$/i.exec(parsedReference.documentTarget)?.[1];
      const candidateKeys = uriDocumentId === undefined
        ? [parsedReference.documentTarget]
        : [uriDocumentId];
      if (uriDocumentId === undefined && (parsedReference.documentTarget.includes("/") || parsedReference.documentTarget.startsWith("."))) {
        candidateKeys.push(posix.normalize(posix.join(posix.dirname(source.relativePath), parsedReference.documentTarget)));
      }
      const targetIds = uniqueSorted(candidateKeys.flatMap(key => [...(lookup.get(lookupKey(key)) ?? [])]));
      let status: LinkGraphEdge["status"] = targetIds.length === 0 ? "broken" : targetIds.length > 1 ? "ambiguous" : "resolved";
      const target = targetIds.length === 1 ? nodeByDocumentId.get(targetIds[0]!) : undefined;
      if (status === "resolved" && target !== undefined && parsedReference.heading !== undefined) {
        const expectedHeading = headingAnchor(parsedReference.heading);
        if (!target.headings.some(heading => heading.anchor === expectedHeading)) status = "broken";
      }
      if (status === "resolved" && target !== undefined && parsedReference.blockId !== undefined) {
        if (!target.blocks.includes(parsedReference.blockId)) status = "broken";
      }
      const id = edgeId([source.documentId, declaration.type, declaration.rawTarget, declaration.sourceLine, declaration.sourceKind]);
      const edge: LinkGraphEdge = {
        edgeId: id,
        type: declaration.type,
        fromNodeId: `document:${source.documentId}`,
        fromDocumentId: source.documentId,
        ...(target === undefined ? {} : { toNodeId: target.nodeId, toDocumentId: target.documentId }),
        sourcePath: source.relativePath,
        sourceLine: declaration.sourceLine,
        sourceKind: declaration.sourceKind,
        reference: parsedReference,
        status,
      };
      edges.push(edge);
      if (status === "broken" && declaration.sourceKind === "body") {
        diagnostics.push({
          code: "LINK_GRAPH_BROKEN",
          severity: "warning",
          path: source.relativePath,
          scopeId: source.scopeId,
          message: `Link '${declaration.rawTarget}' from '${source.documentId}' does not resolve to an indexed document target.`,
        });
      } else if (status === "ambiguous" && declaration.sourceKind === "body") {
        diagnostics.push({
          code: "LINK_GRAPH_AMBIGUOUS",
          severity: "warning",
          path: source.relativePath,
          scopeId: source.scopeId,
          message: `Link '${declaration.rawTarget}' from '${source.documentId}' resolves ambiguously to ${targetIds.join(", ")}.`,
        });
      }
    }
  }
  for (const forward of [...edges]) {
    if (forward.status !== "resolved" || forward.toDocumentId === undefined || forward.toNodeId === undefined) continue;
    edges.push({
      edgeId: edgeId(["backlink", forward.edgeId]),
      type: "backlink",
      fromNodeId: forward.toNodeId,
      fromDocumentId: forward.toDocumentId,
      toNodeId: forward.fromNodeId,
      toDocumentId: forward.fromDocumentId,
      sourcePath: forward.sourcePath,
      sourceLine: forward.sourceLine,
      sourceKind: "derived",
      reference: forward.reference,
      status: "resolved",
      derivedFromEdgeId: forward.edgeId,
    });
  }
  edges.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  for (const documentId of [...cycleDocumentIds(edges)].sort()) {
    const source = sources.find(candidate => candidate.documentId === documentId)!;
    diagnostics.push({
      code: "LINK_GRAPH_CYCLE",
      severity: "warning",
      path: source.relativePath,
      scopeId: source.scopeId,
      message: `Document '${documentId}' participates in a resolved link cycle.`,
    });
  }
  const normalized = { apiVersion: "abcm/link-graph/v1" as const, policyVersion: "v1" as const, nodes, edges };
  return { ...normalized, digest: sha256(normalized) };
}

export function linkSourcesFromGraph(graph: TypedLinkGraph | undefined): DocumentLinkSource[] {
  if (graph === undefined) return [];
  return graph.nodes.map(node => ({
    documentId: node.documentId,
    scopeId: node.scopeId,
    relativePath: node.relativePath,
    checksum: node.checksum,
    title: node.title,
    aliases: node.aliases,
    headings: node.headings,
    blocks: node.blocks,
    declarations: graph.edges
      .filter(edge => edge.type !== "backlink" && edge.fromDocumentId === node.documentId)
      .map(edge => ({
        type: edge.type as Exclude<LinkGraphEdgeType, "backlink">,
        rawTarget: edge.reference.rawTarget,
        sourceLine: edge.sourceLine,
        sourceKind: edge.sourceKind === "frontmatter" ? "frontmatter" as const : "body" as const,
      })),
  }));
}
