import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRestHandler } from "../src/rest/create-rest-handler.js";
import { parseRestLimitEnvironment } from "../src/rest/config.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture(authorizeMutation?: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "abcm-rest-limits-"));
  roots.push(root);
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const files = new WorkspaceFileService(registry, authorizeMutation === undefined ? {} : { authorizeMutation });
  const scopeMap = new ScopeMapService(registry);
  return { root, files, scopeMap };
}

describe("REST request boundaries", () => {
  test("rate limits protected requests while health remains available", async () => {
    const { files, scopeMap } = await fixture();
    const handler = createAbcmRestHandler({ files, scopeMap }, { maxRequestsPerMinute: 2 });
    const request = () => handler(new Request("http://localhost/v1/workspaces/test/files?path="));

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(await limited.json()).toEqual(expect.objectContaining({ code: "REST_RATE_LIMIT_EXCEEDED", status: 429 }));
    expect((await handler(new Request("http://localhost/health"))).status).toBe(200);
  });

  test("maps a cooperative deadline before a file commit", async () => {
    const { root, files, scopeMap } = await fixture(async () => Bun.sleep(25));
    const handler = createAbcmRestHandler({ files, scopeMap }, { requestTimeoutMs: 5 });
    const response = await handler(new Request("http://localhost/v1/workspaces/test/files/content?path=late.md", {
      method: "PUT",
      body: "must-not-commit",
    }));

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "REST_REQUEST_TIMEOUT", status: 504 }));
    expect(await Bun.file(join(root, "late.md")).exists()).toBe(false);
  });

  test("maps caller cancellation before a file commit", async () => {
    const { root, files, scopeMap } = await fixture(async () => Bun.sleep(25));
    const handler = createAbcmRestHandler({ files, scopeMap }, { requestTimeoutMs: 1_000 });
    const controller = new AbortController();
    const pending = handler(new Request("http://localhost/v1/workspaces/test/files/content?path=cancelled.md", {
      method: "PUT",
      body: "must-not-commit",
      signal: controller.signal,
    }));
    setTimeout(() => controller.abort(), 5);
    const response = await pending;

    expect(response.status).toBe(499);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "REST_REQUEST_CANCELLED", status: 499 }));
    expect(await Bun.file(join(root, "cancelled.md")).exists()).toBe(false);
  });

  test("stops an unbounded request stream after the configured byte limit", async () => {
    const { root, files, scopeMap } = await fixture();
    const handler = createAbcmRestHandler({ files, scopeMap }, { maxRequestBodyBytes: 4 });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcd"));
        controller.enqueue(new TextEncoder().encode("e"));
      },
      cancel() { cancelled = true; },
    });
    const request = new Request("http://localhost/v1/workspaces/test/files/content?path=large.md", {
      method: "PUT",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handler(request);

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "FILE_TOO_LARGE", status: 413 }));
    expect(cancelled).toBe(true);
    expect(await Bun.file(join(root, "large.md")).exists()).toBe(false);
  });

  test("times out and cancels a stalled request body stream", async () => {
    const { root, files, scopeMap } = await fixture();
    const handler = createAbcmRestHandler({ files, scopeMap }, { requestTimeoutMs: 5 });
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; },
    });
    const request = new Request("http://localhost/v1/workspaces/test/files/content?path=stalled.md", {
      method: "PUT",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await handler(request);

    expect(response.status).toBe(504);
    expect(await response.json()).toEqual(expect.objectContaining({ code: "REST_REQUEST_TIMEOUT", status: 504 }));
    expect(cancelled).toBe(true);
    expect(await Bun.file(join(root, "stalled.md")).exists()).toBe(false);
  });

  test("parses and validates deployment limit environment", () => {
    expect(parseRestLimitEnvironment({
      ABCM_REST_MAX_REQUEST_BODY_BYTES: "2048",
      ABCM_REST_REQUEST_TIMEOUT_MS: "1500",
      ABCM_REST_MAX_REQUESTS_PER_MINUTE: "42",
    })).toEqual({ maxRequestBodyBytes: 2048, requestTimeoutMs: 1500, maxRequestsPerMinute: 42 });
    expect(() => parseRestLimitEnvironment({ ABCM_REST_REQUEST_TIMEOUT_MS: "300001" })).toThrow("300000");
    expect(() => parseRestLimitEnvironment({ ABCM_REST_MAX_REQUESTS_PER_MINUTE: "0" })).toThrow("positive integer");
  });
});
