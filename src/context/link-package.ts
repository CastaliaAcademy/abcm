import { createHash } from "node:crypto";

import { AbcmError } from "../core/errors.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type { LinkGraphTagPackage, MapRevision, ScopeNode } from "../scope-map/types.js";
import type { ContextLinkGraphBuilder, ContextLinkGraphScopeMap } from "./link-graph-session.js";
import type { BuildTaskContextRequest, ContextBundle } from "./types.js";

export interface ContextLinkPackageView {
  packageId: string;
  workspaceId: string;
  tag: string;
  title: string;
  documentIds: readonly string[];
  packageDigest: string;
  mapRevision: string;
  mapDigest: string;
  linkGraphDigest: string;
  selectionPolicyVersion: "context-selection/v3";
  source: "document-tags";
}

export interface ContextLinkPackageMemberDisposition {
  documentId: string;
  status: "selected" | "selector_mismatch" | "budget_omitted" | "lifecycle_omitted";
}

export interface ContextLinkPackageServiceDependencies {
  contextBuilder: ContextLinkGraphBuilder;
  scopeMap: ContextLinkGraphScopeMap;
  principal: ContextPrincipal;
}

function hasDocumentAccess(principal: ContextPrincipal, node: ScopeNode): boolean {
  if (principal.access.workspacePermissions.includes("document.read")) return true;
  if (principal.access.scopeGrants?.[node.scopeId]?.includes("document.read") === true) return true;
  return node.aliases.some(alias => principal.access.scopeGrants?.[alias]?.includes("document.read") === true);
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function publicPackageId(workspaceId: string, tag: string): string {
  return `tag-package-${digest({ workspaceId, tag }).slice(7, 31)}`;
}

/** Read-only package projections derived from tags in the active MapRevision. */
export class ContextLinkPackageService {
  readonly #contextBuilder: ContextLinkGraphBuilder;
  readonly #scopeMap: ContextLinkGraphScopeMap;
  readonly #principal: ContextPrincipal;

  constructor(dependencies: ContextLinkPackageServiceDependencies) {
    this.#contextBuilder = dependencies.contextBuilder;
    this.#scopeMap = dependencies.scopeMap;
    this.#principal = dependencies.principal;
  }

  list(workspaceId: string): ContextLinkPackageView[] {
    const revision = this.#scopeMap.getActiveRevision(workspaceId);
    return (revision.linkGraph.tagPackages ?? [])
      .map(tagPackage => this.#view(workspaceId, revision, tagPackage))
      .filter(view => view.documentIds.length > 0);
  }

  get(workspaceId: string, packageId: string): ContextLinkPackageView {
    const revision = this.#scopeMap.getActiveRevision(workspaceId);
    const tagPackage = (revision.linkGraph.tagPackages ?? []).find(candidate => publicPackageId(workspaceId, candidate.tag) === packageId);
    if (tagPackage === undefined) throw new AbcmError("CONTEXT_LINK_PACKAGE_NOT_FOUND", "Tag-derived link package was not found.");
    const view = this.#view(workspaceId, revision, tagPackage);
    if (view.documentIds.length === 0) {
      throw new AbcmError("CONTEXT_LINK_PACKAGE_NOT_FOUND", "Tag-derived link package was not found.");
    }
    return view;
  }

  async build(
    input: { workspaceId: string; packageId: string; request: BuildTaskContextRequest },
    signal?: AbortSignal,
  ): Promise<{ bundle: ContextBundle; package: ContextLinkPackageView; members: readonly ContextLinkPackageMemberDisposition[] }> {
    const selectedPackage = this.get(input.workspaceId, input.packageId);
    const request = {
      ...input.request,
      linkPackageDocuments: selectedPackage.documentIds.map(documentId => ({ documentId, mandatory: false })),
    };
    const preview = await this.#contextBuilder.preview(request, this.#principal, signal);
    if (preview.workspaceId !== input.workspaceId) {
      throw new AbcmError("CONTEXT_LINK_PACKAGE_STALE", "Link package and consumer bootstrap belong to different workspaces.");
    }
    const current = this.get(input.workspaceId, input.packageId);
    if (current.packageDigest !== selectedPackage.packageDigest || current.mapRevision !== selectedPackage.mapRevision) {
      throw new AbcmError("CONTEXT_LINK_PACKAGE_STALE", "Tag-derived link package changed during context build.");
    }
    const bundle = await this.#contextBuilder.build(request, this.#principal, signal);
    const selected = new Set(bundle.selectedDocuments.map(document => document.documentId));
    const omissions = new Map(bundle.omissions.map(omission => [omission.documentId, omission.reason]));
    const members = current.documentIds.map(documentId => {
      if (selected.has(documentId)) return { documentId, status: "selected" as const };
      const reason = omissions.get(documentId);
      if (reason === "budget_exceeded") return { documentId, status: "budget_omitted" as const };
      if (reason === "lifecycle_excluded") return { documentId, status: "lifecycle_omitted" as const };
      return { documentId, status: "selector_mismatch" as const };
    });
    return { bundle, package: current, members };
  }

  #view(workspaceId: string, revision: MapRevision, tagPackage: LinkGraphTagPackage): ContextLinkPackageView {
    const nodes = new Map(revision.nodes.map(node => [node.scopeId, node]));
    const documents = new Map(revision.documents.map(document => [document.documentId, document]));
    const documentIds = tagPackage.documentIds.filter(documentId => {
      const document = documents.get(documentId);
      const node = document === undefined ? undefined : nodes.get(document.scopeId);
      return node !== undefined && hasDocumentAccess(this.#principal, node);
    }).sort((left, right) => left.localeCompare(right));
    return {
      packageId: publicPackageId(workspaceId, tagPackage.tag),
      workspaceId,
      tag: tagPackage.tag,
      title: `#${tagPackage.tag}`,
      documentIds,
      packageDigest: digest({ workspaceId, mapRevision: revision.revision, tag: tagPackage.tag, documentIds }),
      mapRevision: revision.revision,
      mapDigest: revision.digest,
      linkGraphDigest: revision.linkGraph.digest,
      selectionPolicyVersion: "context-selection/v3",
      source: "document-tags",
    };
  }
}
