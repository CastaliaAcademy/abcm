import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { createAbcmMcpServer } from "../src/mcp/create-server.js";
import { indexScopeContent } from "../src/scope-map/content-indexer.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function workspace(prefix = "abcm-cancel-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: test\nname: Test\n");
  await mkdir(join(root, "domain-language"));
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  return root;
}

function aborted(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("cooperative operation cancellation", () => {
  test("prevents file commits when cancellation arrives before the mutation boundary", async () => {
    const root = await workspace();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const registry = new WorkspaceRegistry([{ id: "test", root }]);
    const files = new WorkspaceFileService(registry, {
      authorizeMutation: async () => {
        entered();
        await gate;
      },
    });
    const controller = new AbortController();
    const pending = files.write("test", "cancelled.md", new TextEncoder().encode("must not commit"), {}, controller.signal);
    await enteredPromise;
    controller.abort();
    release();
    await expect(pending).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
    await expect(Bun.file(join(root, "cancelled.md")).exists()).resolves.toBe(false);

    for (const operation of [
      files.createDirectory("test", "cancelled-dir", aborted()),
      files.delete("test", "scope.yaml", {}, aborted()),
      files.move("test", "scope.yaml", "moved.yaml", {}, aborted()),
    ]) {
      await expect(operation).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
    }
    expect(await Bun.file(join(root, "scope.yaml")).exists()).toBe(true);
    expect(await Bun.file(join(root, "moved.yaml")).exists()).toBe(false);
    expect(await Bun.file(join(root, "cancelled-dir")).exists()).toBe(false);
  });

  test("does not publish a cancelled ScopeMap revision", async () => {
    const root = await workspace("abcm-cancel-map-");
    const registry = new WorkspaceRegistry([{ id: "test", root }]);
    let block = false;
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const scopeMap = new ScopeMapService(registry, undefined, undefined, {
      contentIndexer: async (resolved, scope, signal) => {
        if (block) {
          entered();
          await gate;
          signal?.throwIfAborted();
        }
        return indexScopeContent(resolved, scope, signal);
      },
    });
    const initial = await scopeMap.scan("test");
    await writeFile(join(root, "README.md"), "new indexed bytes\n");
    block = true;
    const controller = new AbortController();
    const pending = scopeMap.scan("test", controller.signal);
    await enteredPromise;
    controller.abort();
    release();
    await expect(pending).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
    expect(scopeMap.getActiveRevision("test").digest).toBe(initial.digest);
  });

  test("rejects documentation cancellation before the non-preemptible apply phase", async () => {
    const root = await workspace("abcm-cancel-docs-");
    const source = await mkdtemp(join(tmpdir(), "abcm-cancel-doc-source-"));
    roots.push(source);
    await writeFile(join(source, "note.md"), "canonical\n");
    const runtime = createAbcmRuntime(
      { id: "test", root },
      {
        sqliteDerivedStoreEnabled: true,
        documentationSources: [{ id: "notes", workspaceId: "test", root: source, targetBasePath: "artifacts/notes" }],
      },
    );
    try {
      const preview = await runtime.documentation!.preview("test", "notes");
      await expect(runtime.documentation!.apply(preview.importId, aborted())).rejects.toEqual(
        expect.objectContaining({ name: "AbortError" }),
      );
      expect(await Bun.file(join(root, "artifacts/notes/note.md")).exists()).toBe(false);

      const originalWriteMirror = runtime.files.writeMirror.bind(runtime.files);
      let entered!: () => void;
      let release!: () => void;
      const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      (runtime.files as unknown as { writeMirror: typeof runtime.files.writeMirror }).writeMirror = async (...args) => {
        entered();
        await gate;
        return originalWriteMirror(...args);
      };
      const controller = new AbortController();
      const committed = runtime.documentation!.apply(preview.importId, controller.signal);
      await enteredPromise;
      controller.abort();
      release();
      await expect(committed).resolves.toEqual(expect.objectContaining({ created: 1, status: "succeeded" }));
      expect(await Bun.file(join(root, "artifacts/notes/note.md")).text()).toBe("canonical\n");
    } finally {
      await runtime.close();
    }
  });

  test("rejects language and context construction before creating derived state", async () => {
    const root = await workspace("abcm-cancel-context-");
    await mkdir(join(root, "project/domain-language"), { recursive: true });
    await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: Project\n");
    await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    const access = { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] as const };
    const runtime = createAbcmRuntime(
      { id: "test", root },
      { contextPrincipal: { principalId: "cancelled-principal", access }, scopeMapAccess: access },
    );
    try {
      await runtime.scopeMap.scan("test");
      await expect(runtime.domainLanguage.createBootstrap(
        { anchor: { workspaceId: "test", projectId: "project" } },
        { principalId: "cancelled-principal", access },
        aborted(),
      )).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
      await expect(runtime.contextBuilder.build(
        { domainLanguageBootstrapId: "missing", roleId: "role", taskType: "test", goal: "test" },
        { principalId: "cancelled-principal", access },
        aborted(),
      )).rejects.toEqual(expect.objectContaining({ name: "AbortError" }));
      expect(await Bun.file(join(root, ".abcm/artifacts/plans")).exists()).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  test("maps a cooperative MCP deadline to a stable timeout error", async () => {
    const root = await workspace("abcm-mcp-timeout-");
    const registry = new WorkspaceRegistry([{ id: "test", root }]);
    const files = new WorkspaceFileService(registry);
    (files as unknown as { list: (...args: unknown[]) => Promise<never> }).list = async (...args: unknown[]) => {
      const signal = args[3] as AbortSignal;
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
      throw new Error("unreachable");
    };
    const server = createAbcmMcpServer({ files, scopeMap: new ScopeMapService(registry), defaultWorkspaceId: "test", mcpOperationTimeoutMs: 5 });
    const client = new Client({ name: "timeout-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "workspace.list_files", arguments: { workspaceId: "test" } });
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(expect.objectContaining({ code: "MCP_OPERATION_TIMEOUT" }));
    } finally {
      await client.close();
      await server.close();
    }
  });

  test("forwards a client cancellation notification into the application signal", async () => {
    const root = await workspace("abcm-mcp-client-cancel-");
    const registry = new WorkspaceRegistry([{ id: "test", root }]);
    const files = new WorkspaceFileService(registry);
    let entered!: () => void;
    let observed!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const observedPromise = new Promise<void>(resolve => { observed = resolve; });
    (files as unknown as { list: (...args: unknown[]) => Promise<never> }).list = async (...args: unknown[]) => {
      const signal = args[3] as AbortSignal;
      entered();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      observed();
      signal.throwIfAborted();
      throw new Error("unreachable");
    };
    const server = createAbcmMcpServer({ files, scopeMap: new ScopeMapService(registry), defaultWorkspaceId: "test" });
    const client = new Client({ name: "cancelling-client", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const controller = new AbortController();
      const call = client.callTool(
        { name: "workspace.list_files", arguments: { workspaceId: "test" } },
        { signal: controller.signal },
      );
      await enteredPromise;
      controller.abort();
      await expect(call).rejects.toThrow("AbortError");
      await observedPromise;
    } finally {
      await client.close();
      await server.close();
    }
  });
});
