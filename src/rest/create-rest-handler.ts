import { z } from "zod/v4";

import { getAbcmAgentInstructions } from "../agent-instructions/agent-instructions.js";

import { AbcmError } from "../core/errors.js";
import { createOperationDeadline, throwIfAborted, type OperationDeadline } from "../core/operation.js";
import { normalizeBuildTaskContextInput } from "../context/schema.js";
import type { ContextBuilder } from "../context/context-builder.js";
import { ABCM_SERVER_INFO, ABCM_SPEC_VERSION } from "../core/server-info.js";
import type { DomainLanguageService } from "../domain-language/domain-language-service.js";
import type { ContextPrincipal } from "../domain-language/types.js";
import type { DirectoryDocumentationSyncService } from "../documentation/directory-documentation-sync-service.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { ScopeMapAccess } from "../scope-map/types.js";
import type { WorkspaceBatchService } from "../workspace/batch-service.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";
import type { WorkspaceUploadService } from "../workspace/upload-service.js";
import type { ObsidianSyncService } from "../sync/obsidian-sync-service.js";
import {
  syncApplyBatchSchema,
  syncConflictResolutionSchema,
  syncPairingCreateSchema,
  syncPairingRedeemSchema,
  syncPreviewRequestSchema,
} from "../sync/contracts.js";
import { createAbcmOpenApiDocument } from "./openapi.js";
import {
  restCreateDirectoryInputSchema,
  restDocumentationPreviewInputSchema,
  restDocumentationCutoverInputSchema,
  restMoveDirectoryInputSchema,
  restMoveFileInputSchema,
  restWorkspaceBatchApplyInputSchema,
  restWorkspaceUploadStartInputSchema,
  workspaceRegistrationSchema,
} from "./schemas.js";
import { contextBuildInputSchema, domainLanguageInputSchema } from "../mcp/tool-schemas.js";
import { resolveRestLimitOptions, type AbcmRestLimitOptions } from "./config.js";

export interface AbcmRestDependencies {
  files: WorkspaceFileService;
  uploads?: WorkspaceUploadService;
  batches?: WorkspaceBatchService;
  scopeMap: ScopeMapService;
  scopeMapAccess?: ScopeMapAccess;
  domainLanguage?: DomainLanguageService;
  contextPrincipal?: ContextPrincipal;
  contextBuilder?: ContextBuilder;
  workspaces?: WorkspaceRegistrationService;
  documentation?: DirectoryDocumentationSyncService;
  obsidianSync?: ObsidianSyncService;
}

export interface WorkspaceRegistrationService {
  create(input: { id: string; name?: string; language: string }, signal?: AbortSignal): Promise<{ id: string }>;
}

export type AbcmRestOptions = AbcmRestLimitOptions;

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

async function readBoundedBytes(request: Request, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AbcmError("FILE_TOO_LARGE", "Request body exceeds the configured limit.", { maxBytes });
  }
  throwIfAborted(signal);
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    throwIfAborted(signal);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException("REST request was cancelled.", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const next = await Promise.race([reader.read(), aborted])
      .catch(error => {
        void reader.cancel(signal.reason).catch(() => undefined);
        throw error;
      })
      .finally(() => {
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      });
    const { done, value } = next;
    throwIfAborted(signal);
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AbcmError("FILE_TOO_LARGE", "Request body exceeds the configured limit.", { maxBytes });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes: number, signal: AbortSignal): Promise<T> {
  const bytes = await readBoundedBytes(request, maxBytes, signal);
  try {
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    throw new AbcmError("REQUEST_INVALID", "JSON request body is invalid.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function problem(error: unknown): Response {
  if (error instanceof AbcmError) {
    const retryAfter = error.code === "REST_RATE_LIMIT_EXCEEDED" ? error.details?.retryAfterSeconds : undefined;
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
      {
        "content-type": "application/problem+json",
        ...(typeof retryAfter === "number" ? { "retry-after": String(retryAfter) } : {}),
        ...(error.code === "AUTHENTICATION_REQUIRED" ? { "www-authenticate": "Bearer", "cache-control": "no-store" } : {}),
      },
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
  const { maxRequestBodyBytes, requestTimeoutMs, maxRequestsPerMinute } = resolveRestLimitOptions(options);
  let rateWindowStartedAt = Date.now();
  let requestsInWindow = 0;
  return async request => {
    let deadline: OperationDeadline | undefined;
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ status: "ok", server: ABCM_SERVER_INFO, specificationVersion: ABCM_SPEC_VERSION });
      }
      const now = Date.now();
      if (now - rateWindowStartedAt >= 60_000) {
        rateWindowStartedAt = now;
        requestsInWindow = 0;
      }
      if (requestsInWindow >= maxRequestsPerMinute) {
        const retryAfterSeconds = Math.max(1, Math.ceil((rateWindowStartedAt + 60_000 - now) / 1_000));
        throw new AbcmError("REST_RATE_LIMIT_EXCEEDED", "REST request rate exceeds the configured limit.", {
          maxRequestsPerMinute,
          retryAfterSeconds,
        });
      }
      requestsInWindow += 1;
      deadline = createOperationDeadline(request.signal, requestTimeoutMs, {
        label: "REST request",
        timeoutCode: "REST_REQUEST_TIMEOUT",
        cancelledCode: "REST_REQUEST_CANCELLED",
      });
      const signal = deadline.signal;
      throwIfAborted(signal);
      if (request.method === "GET" && url.pathname === "/openapi.json") {
        return json(createAbcmOpenApiDocument());
      }
      if (request.method === "GET" && url.pathname === "/v1/agent-instructions") {
        const instructions = getAbcmAgentInstructions();
        return new Response(instructions.content, {
          headers: {
            "content-type": instructions.contentType,
            etag: `"${instructions.checksum}"`,
            "x-abcm-agent-instructions-version": instructions.version,
          },
        });
      }

      if (request.method === "POST" && url.pathname === "/v1/obsidian/pairings") {
        if (dependencies.obsidianSync === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        return json(dependencies.obsidianSync.createPairing(await readJson(request, syncPairingCreateSchema, maxRequestBodyBytes, signal)), 201);
      }
      if (request.method === "POST" && url.pathname === "/v1/obsidian/pairings/redeem") {
        if (dependencies.obsidianSync === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        return json(dependencies.obsidianSync.redeemPairing(await readJson(request, syncPairingRedeemSchema, maxRequestBodyBytes, signal)));
      }
      const obsidianDevice = /^\/v1\/obsidian\/devices\/([^/]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && obsidianDevice !== null) {
        if (dependencies.obsidianSync === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        dependencies.obsidianSync.revokeDevice(decodeURIComponent(obsidianDevice[1] ?? ""));
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && url.pathname === "/v1/workspaces") {
        if (dependencies.workspaces === undefined) {
          throw new AbcmError("WORKSPACE_REGISTRATION_DISABLED", "Managed workspace registration is not configured.");
        }
        const workspace = await readJson(request, workspaceRegistrationSchema, maxRequestBodyBytes, signal);
        return json(
          await dependencies.workspaces.create({
            id: workspace.id,
            ...(workspace.name === undefined ? {} : { name: workspace.name }),
            language: workspace.language,
          }, signal),
          201,
        );
      }

      if (request.method === "POST" && url.pathname === "/v1/context/domain-language") {
        if (dependencies.domainLanguage === undefined || dependencies.contextPrincipal === undefined) {
          throw new AbcmError("ACCESS_DENIED", "Domain-language context access is not configured.");
        }
        const body = await readJson(request, domainLanguageInputSchema, maxRequestBodyBytes, signal);
        return json(await dependencies.domainLanguage.createBootstrap({
          anchor: body.anchor,
          ...(body.roleId === undefined ? {} : { roleId: body.roleId }),
          ...(body.projection === undefined ? {} : { projection: body.projection }),
        }, dependencies.contextPrincipal, signal));
      }

      if (request.method === "POST" && url.pathname === "/v1/context/build-task-context") {
        if (dependencies.contextBuilder === undefined || dependencies.contextPrincipal === undefined) {
          throw new AbcmError("ACCESS_DENIED", "Context build access is not configured.");
        }
        const body = await readJson(request, contextBuildInputSchema, maxRequestBodyBytes, signal);
        return json(await dependencies.contextBuilder.build(normalizeBuildTaskContextInput(body), dependencies.contextPrincipal, signal));
      }

      const documentationApply = /^\/v1\/documentation-imports\/([^/]+)\/apply$/.exec(url.pathname);
      if (request.method === "POST" && documentationApply !== null) {
        if (dependencies.documentation === undefined) {
          throw new AbcmError("DOCUMENTATION_SYNC_DISABLED", "Documentation synchronization is not configured.");
        }
        return json(await dependencies.documentation.apply(decodeURIComponent(documentationApply[1] ?? ""), signal));
      }

      const documentationSync = /^\/v1\/documentation-sources\/([^/]+)\/sync$/.exec(url.pathname);
      if (request.method === "POST" && documentationSync !== null) {
        if (dependencies.documentation === undefined) {
          throw new AbcmError("DOCUMENTATION_SYNC_DISABLED", "Documentation synchronization is not configured.");
        }
        return json(await dependencies.documentation.sync(decodeURIComponent(documentationSync[1] ?? ""), signal));
      }

      const documentationCutover = /^\/v1\/documentation-sources\/([^/]+)\/cutover$/.exec(url.pathname);
      if (request.method === "POST" && documentationCutover !== null) {
        if (dependencies.documentation === undefined) {
          throw new AbcmError("DOCUMENTATION_SYNC_DISABLED", "Documentation synchronization is not configured.");
        }
        const body = await readJson(request, restDocumentationCutoverInputSchema, maxRequestBodyBytes, signal);
        return json(await dependencies.documentation.cutover(
          decodeURIComponent(documentationCutover[1] ?? ""),
          body,
          signal,
        ));
      }

      const match = /^\/v1\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!match) return problem(new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found."));
      const workspaceId = decodeURIComponent(match[1] ?? "");
      const endpoint = match[2]!;

      if (request.method === "POST" && endpoint === "/uploads") {
        if (dependencies.uploads === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        const body = await readJson(request, restWorkspaceUploadStartInputSchema, maxRequestBodyBytes, signal);
        return json(await dependencies.uploads.start({ workspaceId, ...body }, signal), 201);
      }

      const uploadChunk = /^\/uploads\/(upl_[a-f0-9]{32})\/chunks\/([0-9]+)$/.exec(endpoint);
      if (request.method === "PUT" && uploadChunk !== null) {
        if (dependencies.uploads === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        const index = Number(uploadChunk[2]);
        if (!Number.isSafeInteger(index)) throw new AbcmError("REQUEST_INVALID", "Upload chunk index is invalid.");
        const checksum = request.headers.get("x-content-sha256")?.trim();
        if (checksum === undefined || !/^sha256:[a-f0-9]{64}$/.test(checksum)) {
          throw new AbcmError("REQUEST_INVALID", "X-Content-Sha256 must contain the decoded chunk checksum.");
        }
        const content = await readBoundedBytes(request, maxRequestBodyBytes, signal);
        return json(await dependencies.uploads.append({
          workspaceId,
          uploadId: uploadChunk[1]!,
          index,
          content: "",
          encoding: "base64",
          checksum,
        }, content, signal));
      }

      const uploadComplete = /^\/uploads\/(upl_[a-f0-9]{32})\/complete$/.exec(endpoint);
      if (request.method === "POST" && uploadComplete !== null) {
        if (dependencies.uploads === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        return json(await dependencies.uploads.complete(workspaceId, uploadComplete[1]!, signal));
      }

      const uploadAbort = /^\/uploads\/(upl_[a-f0-9]{32})$/.exec(endpoint);
      if (request.method === "DELETE" && uploadAbort !== null) {
        if (dependencies.uploads === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        await dependencies.uploads.abort(workspaceId, uploadAbort[1]!, signal);
        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && endpoint === "/files/batch:apply") {
        if (dependencies.batches === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        const body = await readJson(request, restWorkspaceBatchApplyInputSchema, maxRequestBodyBytes, signal);
        return json(await dependencies.batches.apply({ workspaceId, ...body }, signal));
      }

      const projectSync = /^\/projects\/([^/]+)\/sync(\/.*)$/.exec(endpoint);
      if (projectSync !== null) {
        if (dependencies.obsidianSync === undefined) throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
        const projectId = decodeURIComponent(projectSync[1] ?? "");
        const syncEndpoint = projectSync[2] ?? "";
        if (request.method === "POST" && syncEndpoint === "/preview") {
          return json(await dependencies.obsidianSync.preview(request, workspaceId, projectId, await readJson(request, syncPreviewRequestSchema, maxRequestBodyBytes, signal), signal));
        }
        if (request.method === "POST" && syncEndpoint === "/apply") {
          return json(await dependencies.obsidianSync.apply(request, workspaceId, projectId, await readJson(request, syncApplyBatchSchema, maxRequestBodyBytes, signal), signal));
        }
        if (request.method === "GET" && syncEndpoint === "/content") {
          const result = await dependencies.obsidianSync.readContent(request, workspaceId, projectId, requiredPath(url), signal);
          return new Response(responseBody(result.content), { headers: { "content-type": result.contentType, etag: `"` + result.entry.checksum + `"`, "x-abcm-path": result.entry.path, "x-abcm-object-id": result.objectId } });
        }
        if (request.method === "GET" && syncEndpoint === "/changes") {
          const cursor = url.searchParams.get("cursor");
          if (cursor === null) throw new AbcmError("REQUEST_INVALID", "Synchronization cursor is required.");
          const limitText = url.searchParams.get("limit") ?? "100";
          if (!/^(?:[1-9][0-9]{0,2}|1000)$/.test(limitText)) throw new AbcmError("REQUEST_INVALID", "Synchronization change limit must be between 1 and 1000.");
          return json(dependencies.obsidianSync.changes(request, workspaceId, projectId, cursor, Number(limitText)));
        }
        const conflict = /^\/conflicts\/([^/]+)$/.exec(syncEndpoint);
        if (request.method === "GET" && conflict !== null) {
          return json(dependencies.obsidianSync.getConflict(request, workspaceId, projectId, decodeURIComponent(conflict[1] ?? "")));
        }
        const resolution = /^\/conflicts\/([^/]+)\/resolve$/.exec(syncEndpoint);
        if (request.method === "POST" && resolution !== null) {
          return json(await dependencies.obsidianSync.resolveConflict(request, workspaceId, projectId, decodeURIComponent(resolution[1] ?? ""), await readJson(request, syncConflictResolutionSchema, maxRequestBodyBytes, signal), signal));
        }
        throw new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found.");
      }

      if (endpoint === "/documentation-sources/preview" && request.method === "POST") {
        if (dependencies.documentation === undefined) {
          throw new AbcmError("DOCUMENTATION_SYNC_DISABLED", "Documentation synchronization is not configured.");
        }
        const body = await readJson(request, restDocumentationPreviewInputSchema, maxRequestBodyBytes, signal);
        return json(await dependencies.documentation.preview(workspaceId, body.sourceId, signal));
      }

      if (endpoint === "/files" && request.method === "GET") {
        const recursiveValue = url.searchParams.get("recursive") ?? "false";
        if (recursiveValue !== "true" && recursiveValue !== "false") {
          throw new AbcmError("REQUEST_INVALID", "Query parameter 'recursive' must be true or false.");
        }
        return json(await dependencies.files.list(workspaceId, url.searchParams.get("path") ?? "", recursiveValue === "true", signal));
      }
      if (endpoint === "/files/content" && request.method === "GET") {
        const result = await dependencies.files.read(workspaceId, requiredPath(url), signal);
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
          await readBoundedBytes(request, maxRequestBodyBytes, signal),
          preconditions,
          signal,
        );
        return json(entry, 200, { etag: `"${entry.checksum}"` });
      }
      if (endpoint === "/files" && request.method === "DELETE") {
        const ifMatch = parseEtag(request.headers.get("if-match"));
        await dependencies.files.delete(workspaceId, requiredPath(url), ifMatch === undefined || ifMatch === "*" ? {} : { ifMatch }, signal);
        return new Response(null, { status: 204 });
      }
      if (endpoint === "/files/move" && request.method === "POST") {
        const body = await readJson(request, restMoveFileInputSchema, maxRequestBodyBytes, signal);
        return json(
          await dependencies.files.move(workspaceId, body.from, body.to, {
            ...(body.overwrite === undefined ? {} : { overwrite: body.overwrite }),
            ...(body.ifMatch === undefined ? {} : { ifMatch: body.ifMatch }),
          }, signal),
        );
      }
      if (endpoint === "/directories" && request.method === "POST") {
        const body = await readJson(request, restCreateDirectoryInputSchema, maxRequestBodyBytes, signal);
        return json(await dependencies.files.createDirectory(workspaceId, body.path, signal), 201);
      }
      if (endpoint === "/directories" && request.method === "DELETE") {
        if (url.searchParams.get("recursive") !== "true") {
          throw new AbcmError("REQUEST_INVALID", "Recursive directory deletion requires recursive=true.");
        }
        await dependencies.files.deleteDirectory(workspaceId, requiredPath(url), { recursive: true }, signal);
        return new Response(null, { status: 204 });
      }
      if (endpoint === "/directories/move" && request.method === "POST") {
        const body = await readJson(request, restMoveDirectoryInputSchema, maxRequestBodyBytes, signal);
        return json(await dependencies.files.moveDirectory(workspaceId, body.from, body.to, signal));
      }
      if (endpoint === "/scope-map/scan" && request.method === "POST") {
        return json(dependencies.scopeMap.summarize(await dependencies.scopeMap.scan(workspaceId, signal)));
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
      if (deadline !== undefined) {
        try {
          deadline.mapAbort(error);
        } catch (mappedError) {
          return problem(mappedError);
        }
      }
      return problem(error);
    } finally {
      deadline?.finish();
    }
  };
}
