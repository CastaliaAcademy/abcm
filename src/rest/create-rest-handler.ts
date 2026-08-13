import { z } from "zod/v4";

import { AbcmError } from "../core/errors.js";
import { ABCM_SERVER_INFO, ABCM_SPEC_VERSION } from "../core/server-info.js";
import type { DomainLanguageService } from "../domain-language/domain-language-service.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type { DirectoryDocumentationSyncService } from "../documentation/directory-documentation-sync-service.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { ScopeMapAccess } from "../scope-map/types.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";

export interface AbcmRestDependencies {
  files: WorkspaceFileService;
  scopeMap: ScopeMapService;
  scopeMapAccess?: ScopeMapAccess;
  domainLanguage?: DomainLanguageService;
  contextPrincipal?: ContextPrincipal;
  workspaces?: WorkspaceRegistrationService;
  documentation?: DirectoryDocumentationSyncService;
}

export interface WorkspaceRegistrationService {
  create(input: { id: string; name?: string }): Promise<{ id: string }>;
}

export interface AbcmRestOptions {
  maxRequestBodyBytes?: number;
}

const moveSchema = z.object({
  from: z.string(),
  to: z.string(),
  overwrite: z.boolean().optional(),
  ifMatch: z.string().optional(),
});
const directorySchema = z.object({ path: z.string() });
const documentationPreviewSchema = z.object({ sourceId: z.string().min(1) }).strict();
const domainLanguageBootstrapSchema = z.object({
  anchor: z.object({ workspaceId: z.string().min(1), projectId: z.string().min(1) }).strict(),
  roleId: z.string().min(1).optional(),
  projection: z.literal("agent").optional(),
}).strict();
const workspaceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    name: z.string().min(1).max(160).optional(),
  })
  .strict();

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, headers === undefined ? { status } : { status, headers });
}

function responseBody(content: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(content.byteLength);
  copy.set(content);
  return copy.buffer;
}

function parseEtag(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed === "*") return "*";
  if (trimmed.startsWith("W/")) throw new AbcmError("REQUEST_INVALID", "Weak ETags are not accepted for file mutations.");
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) return trimmed.slice(1, -1);
  if (trimmed.startsWith("sha256:")) return trimmed;
  throw new AbcmError("REQUEST_INVALID", "Malformed ETag header.");
}

function requiredPath(url: URL): string {
  const path = url.searchParams.get("path");
  if (path === null || path === "") throw new AbcmError("FILE_PATH_INVALID", "Query parameter 'path' is required.");
  return path;
}

async function readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes: number): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AbcmError("FILE_TOO_LARGE", "Request body exceeds the configured limit.", { maxBytes });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new AbcmError("FILE_TOO_LARGE", "Request body exceeds the configured limit.", { maxBytes });
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    throw new AbcmError("REQUEST_INVALID", "JSON request body is invalid.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AbcmError("FILE_TOO_LARGE", "Request body exceeds the configured limit.", { maxBytes });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw new AbcmError("FILE_TOO_LARGE", "Request body exceeds the configured limit.", { maxBytes });
  return bytes;
}

function problem(error: unknown): Response {
  if (error instanceof AbcmError) {
    return json(
      {
        type: `https://abcm.dev/problems/${error.code}`,
        title: error.code,
        status: error.status,
        detail: error.message,
        code: error.code,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      error.status,
      { "content-type": "application/problem+json" },
    );
  }
  return json(
    {
      type: "https://abcm.dev/problems/INTERNAL_ERROR",
      title: "INTERNAL_ERROR",
      status: 500,
      detail: "An unexpected server error occurred.",
      code: "INTERNAL_ERROR",
    },
    500,
    { "content-type": "application/problem+json" },
  );
}

export function createAbcmRestHandler(
  dependencies: AbcmRestDependencies,
  options: AbcmRestOptions = {},
): (request: Request) => Promise<Response> {
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 1_048_576;
  return async request => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", server: ABCM_SERVER_INFO, specificationVersion: ABCM_SPEC_VERSION });
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces") {
        if (dependencies.workspaces === undefined) {
          throw new AbcmError("WORKSPACE_REGISTRATION_DISABLED", "Managed workspace registration is not configured.");
        }
        const workspace = await readJson(request, workspaceSchema, maxRequestBodyBytes);
        return json(
          await dependencies.workspaces.create({
            id: workspace.id,
            ...(workspace.name === undefined ? {} : { name: workspace.name }),
          }),
          201,
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/context/domain-language") {
        if (dependencies.domainLanguage === undefined || dependencies.contextPrincipal === undefined) {
          throw new AbcmError("ACCESS_DENIED", "Domain-language context access is not configured.");
        }
        const body = await readJson(request, domainLanguageBootstrapSchema, maxRequestBodyBytes);
        return json(await dependencies.domainLanguage.createBootstrap({
          anchor: body.anchor,
          ...(body.roleId === undefined ? {} : { roleId: body.roleId }),
          ...(body.projection === undefined ? {} : { projection: body.projection }),
        }, dependencies.contextPrincipal));
      }

      const documentationApply = /^\/v1\/documentation-imports\/([^/]+)\/apply$/.exec(url.pathname);
      if (request.method === "POST" && documentationApply !== null) {
        if (dependencies.documentation === undefined) {
          throw new AbcmError("DOCUMENTATION_SYNC_DISABLED", "Documentation synchronization is not configured.");
        }
        return json(await dependencies.documentation.apply(decodeURIComponent(documentationApply[1] ?? "")));
      }

      const documentationSync = /^\/v1\/documentation-sources\/([^/]+)\/sync$/.exec(url.pathname);
      if (request.method === "POST" && documentationSync !== null) {
        if (dependencies.documentation === undefined) {
          throw new AbcmError("DOCUMENTATION_SYNC_DISABLED", "Documentation synchronization is not configured.");
        }
        return json(await dependencies.documentation.sync(decodeURIComponent(documentationSync[1] ?? "")));
      }

      const match = /^\/v1\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!match) return problem(new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found."));
      const workspaceId = decodeURIComponent(match[1] ?? "");
      const endpoint = match[2];

      if (endpoint === "/documentation-sources/preview" && request.method === "POST") {
        if (dependencies.documentation === undefined) {
          throw new AbcmError("DOCUMENTATION_SYNC_DISABLED", "Documentation synchronization is not configured.");
        }
        const body = await readJson(request, documentationPreviewSchema, maxRequestBodyBytes);
        return json(await dependencies.documentation.preview(workspaceId, body.sourceId));
      }

      if (endpoint === "/files" && request.method === "GET") {
        const recursiveValue = url.searchParams.get("recursive") ?? "false";
        if (recursiveValue !== "true" && recursiveValue !== "false") {
          throw new AbcmError("REQUEST_INVALID", "Query parameter 'recursive' must be true or false.");
        }
        return json(await dependencies.files.list(workspaceId, url.searchParams.get("path") ?? "", recursiveValue === "true"));
      }
      if (endpoint === "/files/content" && request.method === "GET") {
        const result = await dependencies.files.read(workspaceId, requiredPath(url));
        return new Response(responseBody(result.content), {
          headers: {
            "content-type": result.contentType,
            etag: `"${result.entry.checksum}"`,
            "x-abcm-path": result.entry.path,
          },
        });
      }
      if (endpoint === "/files/content" && request.method === "PUT") {
        const ifMatch = parseEtag(request.headers.get("if-match"));
        const ifNoneMatch = parseEtag(request.headers.get("if-none-match"));
        if (ifNoneMatch !== undefined && ifNoneMatch !== "*") {
          throw new AbcmError("REQUEST_INVALID", "If-None-Match only supports '*'.");
        }
        const preconditions = {
          ...(ifMatch === undefined || ifMatch === "*" ? {} : { ifMatch }),
          ...(ifNoneMatch === "*" ? { ifNoneMatch: "*" as const } : {}),
        };
        const entry = await dependencies.files.write(
          workspaceId,
          requiredPath(url),
          await readBytes(request, maxRequestBodyBytes),
          preconditions,
        );
        return json(entry, 200, { etag: `"${entry.checksum}"` });
      }
      if (endpoint === "/files" && request.method === "DELETE") {
        const ifMatch = parseEtag(request.headers.get("if-match"));
        await dependencies.files.delete(workspaceId, requiredPath(url), ifMatch === undefined || ifMatch === "*" ? {} : { ifMatch });
        return new Response(null, { status: 204 });
      }
      if (endpoint === "/files/move" && request.method === "POST") {
        const body = await readJson(request, moveSchema, maxRequestBodyBytes);
        return json(
          await dependencies.files.move(workspaceId, body.from, body.to, {
            ...(body.overwrite === undefined ? {} : { overwrite: body.overwrite }),
            ...(body.ifMatch === undefined ? {} : { ifMatch: body.ifMatch }),
          }),
        );
      }
      if (endpoint === "/directories" && request.method === "POST") {
        const body = await readJson(request, directorySchema, maxRequestBodyBytes);
        return json(await dependencies.files.createDirectory(workspaceId, body.path), 201);
      }
      if (endpoint === "/scope-map/scan" && request.method === "POST") {
        return json(dependencies.scopeMap.summarize(await dependencies.scopeMap.scan(workspaceId)));
      }
      if (endpoint === "/scope-map" && request.method === "GET") {
        const view = url.searchParams.get("view") ?? "agent";
        if (view !== "agent" && view !== "admin") throw new AbcmError("REQUEST_INVALID", "ScopeMap view must be agent or admin.");
        const depthValue = url.searchParams.get("depth");
        if (depthValue !== null && !/^(?:0|[1-9][0-9]*)$/.test(depthValue)) {
          throw new AbcmError("REQUEST_INVALID", "ScopeMap depth must be a non-negative integer.");
        }
        const includeInvalidValue = url.searchParams.get("includeInvalid");
        if (includeInvalidValue !== null && includeInvalidValue !== "true" && includeInvalidValue !== "false") {
          throw new AbcmError("REQUEST_INVALID", "ScopeMap includeInvalid must be true or false.");
        }
        const rootScopeId = url.searchParams.get("rootScopeId");
        return json(
          dependencies.scopeMap.getProjection(
            workspaceId,
            {
              view,
              ...(rootScopeId === null ? {} : { rootScopeId }),
              ...(depthValue === null ? {} : { depth: Number(depthValue) }),
              ...(includeInvalidValue === null ? {} : { includeInvalid: includeInvalidValue === "true" }),
            },
            dependencies.scopeMapAccess,
          ),
        );
      }
      return problem(new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found."));
    } catch (error) {
      return problem(error);
    }
  };
}
