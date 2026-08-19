import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmMcpServer } from "../src/mcp/create-server.js";
import { createAbcmRestHandler } from "../src/rest/create-rest-handler.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(onMutation?: (workspaceId: string, paths: readonly string[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "abcm-directories-"));
  roots.push(root);
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  const files = new WorkspaceFileService(registry, onMutation === undefined ? {} : { onMutation });
  const scopeMap = new ScopeMapService(registry);
  await mkdir(join(root, "source/nested"), { recursive: true });
  await writeFile(join(root, "source/a.md"), "a");
  await writeFile(join(root, "source/nested/b.md"), "b");
  return { root, files, scopeMap };
}

describe("workspace directory operations", () => {
  test("moves and recursively deletes directories while reporting every changed file", async () => {
    const mutations: string[][] = [];
    const { root, files } = await fixture(async (_workspaceId, paths) => {
      mutations.push([...paths]);
    });

    const moved = await files.moveDirectory("test", "source", "archive/source");
    expect(moved).toEqual(expect.objectContaining({
      path: "archive/source",
      name: "source",
      kind: "directory",
    }));
    expect(await readFile(join(root, "archive/source/a.md"), "utf8")).toBe("a");
    expect(await readFile(join(root, "archive/source/nested/b.md"), "utf8")).toBe("b");
    await expect(stat(join(root, "source"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(mutations).toEqual([
      ["source/a.md", "archive/source/a.md"],
      ["source/nested/b.md", "archive/source/nested/b.md"],
    ]);

    await files.deleteDirectory("test", "archive/source", { recursive: true });
    await expect(stat(join(root, "archive/source"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(mutations.at(-1)).toEqual([
      "archive/source/a.md",
      "archive/source/nested/b.md",
    ]);
  });

  test("rejects root deletion, destination collisions, self-descendant moves, and implicit recursion", async () => {
    const { root, files } = await fixture();
    await mkdir(join(root, "target"));

    await expect(files.deleteDirectory("test", "source", { recursive: false })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
    await expect(files.deleteDirectory("test", "", { recursive: true })).rejects.toMatchObject({
      code: "FILE_PATH_INVALID",
    });
    await expect(files.moveDirectory("test", "source", "target")).rejects.toMatchObject({
      code: "FILE_ALREADY_EXISTS",
    });
    await expect(files.moveDirectory("test", "source", "source/nested/moved")).rejects.toMatchObject({
      code: "FILE_PATH_INVALID",
    });
    expect(await readFile(join(root, "source/a.md"), "utf8")).toBe("a");
  });

  test("rejects recursive mutations that would include reserved descendants", async () => {
    const { root, files } = await fixture();
    await mkdir(join(root, "source/.git"));
    await writeFile(join(root, "source/.git/config"), "reserved");

    await expect(files.deleteDirectory("test", "source", { recursive: true })).rejects.toMatchObject({
      code: "FILE_PATH_FORBIDDEN",
    });
    expect(await readFile(join(root, "source/.git/config"), "utf8")).toBe("reserved");
  });

  test("exposes explicit REST directory move and recursive delete routes", async () => {
    const { root, files, scopeMap } = await fixture();
    const handler = createAbcmRestHandler({ files, scopeMap });
    const call = (path: string, init?: RequestInit) => handler(new Request(`http://localhost${path}`, init));

    const moved = await call("/v1/workspaces/test/directories/move", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: "source", to: "archive/source" }),
    });
    expect(moved.status).toBe(200);
    expect(await moved.json()).toEqual(expect.objectContaining({ path: "archive/source", kind: "directory" }));

    const missingConfirmation = await call("/v1/workspaces/test/directories?path=archive%2Fsource", { method: "DELETE" });
    expect(missingConfirmation.status).toBe(400);
    expect(await missingConfirmation.json()).toEqual(expect.objectContaining({ code: "REQUEST_INVALID" }));

    const deleted = await call("/v1/workspaces/test/directories?path=archive%2Fsource&recursive=true", { method: "DELETE" });
    expect(deleted.status).toBe(204);
    await expect(stat(join(root, "archive/source"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("exposes directory move and delete through MCP with strict schemas", async () => {
    const { root, files, scopeMap } = await fixture();
    const server = createAbcmMcpServer({ files, scopeMap, defaultWorkspaceId: "test" });
    const client = new Client({ name: "directory-test-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
        "workspace.move_directory",
        "workspace.delete_directory",
      ]));

      const moved = await client.callTool({
        name: "workspace.move_directory",
        arguments: { workspaceId: "test", from: "source", to: "archive/source" },
      });
      expect(moved.isError).not.toBe(true);
      expect(moved.structuredContent).toEqual({
        entry: expect.objectContaining({ path: "archive/source", kind: "directory" }),
      });

      const rejected = await client.callTool({
        name: "workspace.delete_directory",
        arguments: { workspaceId: "test", path: "archive/source", recursive: false },
      });
      expect(rejected.isError).toBe(true);
      expect((rejected.content[0] as { text: string }).text).toContain("Input validation error");

      const deleted = await client.callTool({
        name: "workspace.delete_directory",
        arguments: { workspaceId: "test", path: "archive/source", recursive: true },
      });
      expect(deleted.isError).not.toBe(true);
      expect(deleted.structuredContent).toEqual({ deleted: true });
      await expect(stat(join(root, "archive/source"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
