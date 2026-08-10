import { z } from "zod/v4";

import { AbcmError } from "../core/errors.js";
import { ABCM_SERVER_INFO, ABCM_SPEC_VERSION } from "../core/server-info.js";
import type { ScopeMapService } from "../scope-map/scope-map-service.js";
import type { WorkspaceFileService } from "../workspace/file-service.js";

export interface AbcmRestDependencies {
  files: WorkspaceFileService;
  scopeMap: ScopeMapService;
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

      const match = /^\/v1\/workspaces\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!match) return problem(new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found."));
      const workspaceId = decodeURIComponent(match[1] ?? "");
      const endpoint = match[2];

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
        return json(await dependencies.scopeMap.scan(workspaceId));
      }
      if (endpoint === "/scope-map" && request.method === "GET") {
        const view = url.searchParams.get("view") ?? "agent";
        if (view !== "agent" && view !== "admin") throw new AbcmError("REQUEST_INVALID", "ScopeMap view must be agent or admin.");
        return json(dependencies.scopeMap.getProjection(workspaceId, view));
      }
      return problem(new AbcmError("FILE_NOT_FOUND", "REST endpoint was not found."));
    } catch (error) {
      return problem(error);
    }
  };
}
