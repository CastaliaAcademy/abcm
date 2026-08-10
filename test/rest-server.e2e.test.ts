import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];
const token = "test-token-123456789";

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("ABCM real HTTP server", () => {
  test("serves authenticated filesystem parity over a TCP listener", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-http-"));
    roots.push(root);
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
    await mkdir(join(root, "domain-language"));
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    const runtime = createAbcmRuntime({ id: "test", root }, { bearerToken: token });
    await runtime.scopeMap.scan("test");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: runtime.restHandler });
    const authorization = { authorization: `Bearer ${token}` };

    try {
      const health = await fetch(new URL("/health", server.url));
      expect(health.status).toBe(200);
      const unauthenticated = await fetch(new URL("/v1/workspaces/test/files?path=", server.url));
      expect(unauthenticated.status).toBe(401);
      const write = await fetch(new URL("/v1/workspaces/test/files/content?path=api.md", server.url), {
        method: "PUT",
        headers: { ...authorization, "if-none-match": "*" },
        body: "through-http",
      });
      expect(write.status).toBe(200);
      expect(await Bun.file(join(root, "api.md")).text()).toBe("through-http");
      const read = await fetch(new URL("/v1/workspaces/test/files/content?path=api.md", server.url), {
        headers: authorization,
      });
      expect(await read.text()).toBe("through-http");
    } finally {
      server.stop(true);
    }
  });
});
