import {
  ProtocolError,
  ProtocolErrorCode,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ReadResourceResult,
  type Resource,
} from "@modelcontextprotocol/server";

import { AbcmError } from "../core/errors.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type {
  AbcmPermission,
  DocumentRecord,
  MapRevision,
  ScopeMapAccess,
  ScopeNode,
  SkillDescriptor,
} from "../scope-map/types.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const TRUSTED_ACCESS: ScopeMapAccess = {
  workspacePermissions: [
    "scope.discover",
    "scope.read_metadata",
    "scope_map.read_full",
    "context.build",
    "document.read",
    "executable_resource.read",
  ],
};
const ACTIVE_LIFECYCLES = new Set(["active"]);
const TEMPLATE_DIGEST = "mcp-resource-contract-v0.1";

interface CursorPayload {
  version: 1;
  kind: "resources" | "templates";
  digest: string;
  offset: number;
}

interface CatalogResource extends Resource {
  source:
    | { type: "map"; scopeId?: string }
    | { type: "document"; document: DocumentRecord }
    | { type: "skill"; skill: SkillDescriptor };
}

export interface McpResourceCatalogOptions {
  files: WorkspaceFileService;
  scopeMap: ScopeMapService;
  workspaceId: string;
  access?: ScopeMapAccess;
  pageSize?: number;
  operationTimeoutMs?: number;
}

export type ResourcePage = ListResourcesResult;
export type ResourceTemplatePage = ListResourceTemplatesResult;

function resourceError(code: "RESOURCE_NOT_FOUND" | "RESOURCE_STALE", message: string, details?: Record<string, unknown>): never {
  throw new AbcmError(code, `${code}: ${message}`, details);
}

function resourceUri(namespace: string, id: string): string {
  return `abcm://${namespace}/${encodeURIComponent(id)}`;
}

function documentNamespace(document: DocumentRecord): "plan" | "architecture" | "artifact" {
  const kind = document.kind.toLowerCase();
  if (kind === "plan") return "plan";
  if (kind === "architecture") return "architecture";
  return "artifact";
}

function mimeTypeFor(path: string): string {
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return "application/yaml; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function checkedPageSize(value: number | undefined): number {
  const pageSize = value ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) {
    throw new AbcmError("REQUEST_INVALID", "MCP resource page size must be an integer from 1 through 500.");
  }
  return pageSize;
}

function checkedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) {
    throw new AbcmError("REQUEST_INVALID", "MCP operation timeout must be an integer from 1 through 300000 milliseconds.");
  }
  return timeout;
}

export function toMcpProtocolError(error: unknown, uri?: string): never {
  if (error instanceof AbcmError) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, error.message, {
      abcmCode: error.code,
      ...(uri === undefined ? {} : { uri }),
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "MCP_OPERATION_CANCELLED: MCP operation was cancelled.", {
      abcmCode: "MCP_OPERATION_CANCELLED",
      ...(uri === undefined ? {} : { uri }),
    });
  }
  throw error;
}

export class McpResourceCatalog {
  readonly #files: WorkspaceFileService;
  readonly #scopeMap: ScopeMapService;
  readonly #workspaceId: string;
  readonly #access: ScopeMapAccess;
  readonly #pageSize: number;
  readonly #operationTimeoutMs: number;

  constructor(options: McpResourceCatalogOptions) {
    this.#files = options.files;
    this.#scopeMap = options.scopeMap;
    this.#workspaceId = options.workspaceId;
    this.#access = options.access ?? TRUSTED_ACCESS;
    this.#pageSize = checkedPageSize(options.pageSize);
    this.#operationTimeoutMs = checkedTimeout(options.operationTimeoutMs);
  }

  async list(cursor: string | undefined, signal: AbortSignal): Promise<ResourcePage> {
    return this.#bounded(signal, async operationSignal => {
      const revision = await this.#revision(operationSignal);
      const resources = this.#resources(revision);
      const offset = this.#cursorOffset(cursor, "resources", revision.digest);
      const page = resources.slice(offset, offset + this.#pageSize).map(({ source: _source, ...resource }) => resource);
      const nextOffset = offset + page.length;
      return {
        resources: page,
        ...(nextOffset < resources.length
          ? { nextCursor: this.#encodeCursor({ version: 1, kind: "resources", digest: revision.digest, offset: nextOffset }) }
          : {}),
      };
    });
  }

  async listTemplates(cursor: string | undefined, signal: AbortSignal): Promise<ResourceTemplatePage> {
    return this.#bounded(signal, async operationSignal => {
      operationSignal.throwIfAborted();
      const templates: ListResourceTemplatesResult["resourceTemplates"] = [
        {
          name: "ABCM architecture document",
          title: "Indexed architecture document",
          description: "One active, permitted architecture document from the current ScopeMap revision.",
          uriTemplate: "abcm://architecture/{documentId}",
          mimeType: "text/markdown",
        },
        {
          name: "ABCM artifact",
          title: "Indexed context artifact",
          description: "One active, permitted non-plan context document from the current ScopeMap revision.",
          uriTemplate: "abcm://artifact/{documentId}",
          mimeType: "text/markdown",
        },
        {
          name: "ABCM scoped map",
          title: "Bounded ScopeMap projection",
          description: "Permission-filtered agent projection rooted at one scope.",
          uriTemplate: "abcm://map/{scopeId}",
          mimeType: "application/json",
        },
        {
          name: "ABCM plan",
          title: "Indexed plan document",
          description: "One active, permitted plan document from the current ScopeMap revision.",
          uriTemplate: "abcm://plan/{documentId}",
          mimeType: "text/markdown",
        },
        {
          name: "ABCM skill",
          title: "Indexed skill definition",
          description: "One active, permitted SKILL.md definition. Executable skill resources are excluded.",
          uriTemplate: "abcm://skill/{skillId}",
          mimeType: "text/markdown",
        },
      ];
      const offset = this.#cursorOffset(cursor, "templates", TEMPLATE_DIGEST);
      const page = templates.slice(offset, offset + this.#pageSize);
      const nextOffset = offset + page.length;
      return {
        resourceTemplates: page,
        ...(nextOffset < templates.length
          ? { nextCursor: this.#encodeCursor({ version: 1, kind: "templates", digest: TEMPLATE_DIGEST, offset: nextOffset }) }
          : {}),
      };
    });
  }

  async read(uri: string, signal: AbortSignal): Promise<ReadResourceResult> {
    return this.#bounded(signal, async operationSignal => {
      const revision = await this.#revision(operationSignal);
      const resource = this.#resources(revision).find(candidate => candidate.uri === uri);
      if (resource === undefined) resourceError("RESOURCE_NOT_FOUND", "The resource is missing, inactive, or inaccessible.", { uri });
      operationSignal.throwIfAborted();
      if (resource.source.type === "map") {
        const projection = this.#scopeMap.getProjection(
          this.#workspaceId,
          { view: "agent", ...(resource.source.scopeId === undefined ? {} : { rootScopeId: resource.source.scopeId }) },
          this.#access,
        );
        return {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(projection) }],
        };
      }

      const indexed = resource.source.type === "document" ? resource.source.document : resource.source.skill;
      const read = await this.#files.read(this.#workspaceId, indexed.relativePath, operationSignal);
      operationSignal.throwIfAborted();
      if (read.entry.checksum !== indexed.checksum) {
        resourceError("RESOURCE_STALE", "The resource bytes no longer match the active ScopeMap revision.", {
          uri,
          expected: indexed.checksum,
          actual: read.entry.checksum,
          mapRevision: revision.revision,
        });
      }
      return {
        contents: [{ uri, mimeType: read.contentType, text: new TextDecoder("utf-8", { fatal: true }).decode(read.content) }],
      };
    });
  }

  async #revision(signal: AbortSignal): Promise<MapRevision> {
    signal.throwIfAborted();
    try {
      return this.#scopeMap.getActiveRevision(this.#workspaceId);
    } catch (error) {
      if (!(error instanceof AbcmError) || error.code !== "MAP_NOT_BUILT") throw error;
      const revision = await this.#scopeMap.scan(this.#workspaceId, signal);
      signal.throwIfAborted();
      return revision;
    }
  }

  #resources(revision: MapRevision): CatalogResource[] {
    const resources: CatalogResource[] = [];
    try {
      this.#scopeMap.getProjection(this.#workspaceId, { view: "agent" }, this.#access);
      resources.push({
        uri: "abcm://map",
        name: "ABCM ScopeMap",
        title: "ABCM agent ScopeMap",
        description: "Permission-filtered agent projection of the default workspace.",
        mimeType: "application/json",
        source: { type: "map" },
      });
    } catch (error) {
      if (!(error instanceof AbcmError) || error.code !== "ACCESS_DENIED") throw error;
    }

    for (const node of revision.nodes) {
      if (node.status !== "valid" || !this.#canReadScope(node)) continue;
      resources.push({
        uri: resourceUri("map", node.scopeId),
        name: `ScopeMap: ${node.name}`,
        title: `ScopeMap rooted at ${node.name}`,
        description: `Permission-filtered agent projection rooted at scope '${node.scopeId}'.`,
        mimeType: "application/json",
        source: { type: "map", scopeId: node.scopeId },
      });
    }

    for (const document of revision.documents) {
      if (!ACTIVE_LIFECYCLES.has(document.lifecycle) || !this.#canReadDocument(revision, document.scopeId)) continue;
      const namespace = documentNamespace(document);
      const file = revision.files.find(candidate => candidate.relativePath === document.relativePath);
      resources.push({
        uri: resourceUri(namespace, document.documentId),
        name: document.title,
        title: document.title,
        description: `Indexed ${document.kind} document '${document.documentId}'.`,
        mimeType: mimeTypeFor(document.relativePath),
        ...(file === undefined ? {} : { size: file.size }),
        source: { type: "document", document },
      });
    }

    const skillsById = new Map<string, SkillDescriptor[]>();
    for (const skill of revision.skills) {
      if (!ACTIVE_LIFECYCLES.has(skill.lifecycle) || !this.#canReadDocument(revision, skill.sourceScopeId)) continue;
      const sameId = skillsById.get(skill.skillId) ?? [];
      sameId.push(skill);
      skillsById.set(skill.skillId, sameId);
    }
    for (const [skillId, skills] of skillsById) {
      if (skills.length !== 1) continue;
      const skill = skills[0]!;
      const file = revision.files.find(candidate => candidate.relativePath === skill.relativePath);
      resources.push({
        uri: resourceUri("skill", skillId),
        name: skill.name,
        title: skill.name,
        description: skill.description,
        mimeType: "text/markdown; charset=utf-8",
        ...(file === undefined ? {} : { size: file.size }),
        source: { type: "skill", skill },
      });
    }
    return resources.sort((left, right) => left.uri.localeCompare(right.uri));
  }

  #canReadScope(node: ScopeNode): boolean {
    return this.#hasPermission(node, "scope.discover") && this.#hasPermission(node, "scope.read_metadata");
  }

  #canReadDocument(revision: MapRevision, scopeId: string): boolean {
    const node = revision.nodes.find(candidate => candidate.scopeId === scopeId);
    return node !== undefined && this.#canReadScope(node) && this.#hasPermission(node, "document.read");
  }

  #hasPermission(node: ScopeNode, permission: AbcmPermission): boolean {
    if (this.#access.workspacePermissions.includes(permission)) return true;
    const grants = this.#access.scopeGrants;
    if (grants?.[node.scopeId]?.includes(permission) === true) return true;
    return node.aliases.some(alias => grants?.[alias]?.includes(permission) === true);
  }

  #cursorOffset(cursor: string | undefined, kind: CursorPayload["kind"], digest: string): number {
    if (cursor === undefined) return 0;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
      if (
        parsed.version !== 1 ||
        parsed.kind !== kind ||
        parsed.digest !== digest ||
        !Number.isSafeInteger(parsed.offset) ||
        (parsed.offset ?? -1) < 0
      ) {
        throw new Error("invalid cursor payload");
      }
      return parsed.offset!;
    } catch {
      throw new AbcmError("MCP_CURSOR_INVALID", "MCP pagination cursor is invalid or stale.", { kind });
    }
  }

  #encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  async #bounded<T>(requestSignal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    requestSignal.throwIfAborted();
    const timeoutSignal = AbortSignal.timeout(this.#operationTimeoutMs);
    const signal = AbortSignal.any([requestSignal, timeoutSignal]);
    return Promise.race([
      operation(signal),
      new Promise<never>((_, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            if (timeoutSignal.aborted && !requestSignal.aborted) {
              reject(new AbcmError("MCP_OPERATION_TIMEOUT", "MCP operation exceeded its configured timeout."));
            } else {
              reject(new DOMException("MCP operation was cancelled.", "AbortError"));
            }
          },
          { once: true },
        );
      }),
    ]);
  }
}
