import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod/v4";

import { parseSafeYaml } from "../core/safe-yaml.js";
import type { ResolvedWorkspace } from "../workspace/types.js";
import type { DocumentRecord, MapDiagnostic, ScopeNode, ScopeRelation } from "./types.js";

const relationSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    target: z.string().min(1).max(512),
    type: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    required: z.boolean().default(false),
  })
  .strict();

const relationsConfigurationSchema = z
  .object({
    apiVersion: z.literal("abcm/v1"),
    kind: z.literal("ScopeRelations"),
    relations: z.array(relationSchema).default([]),
  })
  .strict()
  .superRefine((configuration, context) => {
    const seen = new Set<string>();
    for (const [index, relation] of configuration.relations.entries()) {
      if (seen.has(relation.id)) {
        context.addIssue({ code: "custom", message: `Duplicate relation id '${relation.id}'.`, path: ["relations", index, "id"] });
      }
      seen.add(relation.id);
    }
  });

type SupportedNamespace = "scope" | "artifact" | "plan" | "architecture" | "lineage";
type ParsedStableUri = { namespace: SupportedNamespace; stableId: string };

const supportedUri = /^abcm:\/\/(scope|artifact|plan|architecture|lineage)\/([^/?#]+)$/;
const deferredUri = /^abcm:\/\/(role|skill)\/([^/?#]+)$/;

function parseStableUri(value: string): ParsedStableUri | "deferred" | "invalid" {
  const match = supportedUri.exec(value);
  if (match !== null) return { namespace: match[1] as SupportedNamespace, stableId: match[2]! };
  if (deferredUri.test(value)) return "deferred";
  return "invalid";
}

function documentMatchesNamespace(document: DocumentRecord, namespace: Exclude<SupportedNamespace, "scope" | "lineage">): boolean {
  if (namespace === "plan") return document.kind === "plan";
  if (namespace === "architecture") return document.kind === "architecture";
  return document.kind !== "plan" && document.kind !== "architecture";
}

export interface ExplicitRelationIndex {
  relations: readonly ScopeRelation[];
  warningScopeIds: ReadonlySet<string>;
}

export async function indexExplicitRelations(
  workspace: ResolvedWorkspace,
  nodes: readonly ScopeNode[],
  documents: readonly DocumentRecord[],
  diagnostics: MapDiagnostic[],
  sourceScopeIds?: ReadonlySet<string>,
): Promise<ExplicitRelationIndex> {
  const scopeIds = new Map<string, string>();
  for (const node of nodes.filter(node => node.status === "valid")) {
    scopeIds.set(node.scopeId, node.scopeId);
    for (const alias of node.aliases) scopeIds.set(alias, node.scopeId);
  }
  const documentsById = new Map(documents.map(document => [document.documentId, document]));
  const relations: ScopeRelation[] = [];
  const warningScopeIds = new Set<string>();

  const add = (
    fromId: string,
    target: string,
    relationType: string,
    source: string,
    required: boolean,
    diagnosticPath: string,
  ): void => {
    const parsed = parseStableUri(target);
    if (parsed === "deferred") return;
    if (parsed === "invalid") {
      diagnostics.push({
        code: "EXPLICIT_LINK_INVALID",
        severity: "warning",
        path: diagnosticPath,
        scopeId: fromId,
        message: `Explicit relation target '${target}' is not a supported stable abcm URI.`,
      });
      if (required) warningScopeIds.add(fromId);
      return;
    }

    const resolved =
      parsed.namespace === "scope"
        ? scopeIds.get(parsed.stableId)
        : parsed.namespace === "lineage"
          ? (() => {
              const heads = documents.filter(document =>
                document.lineageId === parsed.stableId &&
                document.lifecycle.toLocaleLowerCase("en-US") === "accepted"
              );
              return heads.length === 1 ? heads[0]!.documentId : undefined;
            })()
          : (() => {
            const document = documentsById.get(parsed.stableId);
            return document !== undefined && documentMatchesNamespace(document, parsed.namespace) ? document.documentId : undefined;
          })();
    const status: ScopeRelation["status"] =
      resolved !== undefined ? "resolved" : required ? "unresolved_required" : "unresolved_optional";
    relations.push({
      fromId,
      toId: resolved ?? target,
      relationType,
      source,
      status,
    });
    if (resolved === undefined) {
      diagnostics.push({
        code: "EXPLICIT_LINK_UNRESOLVED",
        severity: "warning",
        path: diagnosticPath,
        scopeId: fromId,
        message: `${required ? "Required" : "Optional"} explicit relation target '${target}' is unresolved.`,
      });
      if (required) warningScopeIds.add(fromId);
    }
  };

  for (const document of documents.filter(document => sourceScopeIds === undefined || sourceScopeIds.has(document.scopeId))) {
    for (const target of document.links) {
      add(document.scopeId, target, "explicit-link", `document:${document.documentId}`, false, `document:${document.documentId}`);
    }
  }

  for (const node of nodes.filter(
    node => node.status === "valid" && (sourceScopeIds === undefined || sourceScopeIds.has(node.scopeId)),
  )) {
    const configurationPath = join(workspace.root, node.relativePath, "config", "relations.yaml");
    let source: string;
    try {
      const metadata = await stat(configurationPath);
      if (metadata.size > workspace.maxIndexBytes) {
        diagnostics.push({
          code: "FILE_TOO_LARGE",
          severity: "warning",
          path: node.relativePath === "" ? "config/relations.yaml" : `${node.relativePath}/config/relations.yaml`,
          scopeId: node.scopeId,
          message: `Relations configuration was not parsed because it exceeds maxIndexBytes=${workspace.maxIndexBytes}.`,
        });
        continue;
      }
      source = await readFile(configurationPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let configuration: z.infer<typeof relationsConfigurationSchema>;
    try {
      configuration = relationsConfigurationSchema.parse(parseSafeYaml(source));
    } catch (error) {
      diagnostics.push({
        code: "RELATIONS_CONFIGURATION_INVALID",
        severity: "warning",
        path: node.relativePath === "" ? "config/relations.yaml" : `${node.relativePath}/config/relations.yaml`,
        scopeId: node.scopeId,
        message: error instanceof Error ? error.message : "Invalid relations configuration.",
      });
      continue;
    }
    for (const relation of configuration.relations) {
      add(
        node.scopeId,
        relation.target,
        relation.type,
        `relations:${relation.id}`,
        relation.required,
        node.relativePath === "" ? "config/relations.yaml" : `${node.relativePath}/config/relations.yaml`,
      );
    }
  }

  return { relations, warningScopeIds };
}
