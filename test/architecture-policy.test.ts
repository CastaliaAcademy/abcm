import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function scope(root: string, path: string, kind: "workflow" | "project", id: string) {
  const directory = join(root, path);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await mkdir(join(directory, "config"), { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), "---\napiVersion: abcm/v1\nkind: DomainLanguageConvention\nmode: inherit-only\n---\n");
  await writeFile(join(directory, "config/context.yaml"), `apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n`);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-architecture-policy-"));
  roots.push(root);
  await scope(root, "", "workflow", "workflow");
  await scope(root, "alpha", "project", "alpha");
  await scope(root, "beta", "project", "beta");
  const runtime = createAbcmRuntime({ id: "test", root });
  await runtime.scopeMap.scan("test");
  return { root, runtime };
}

describe("workspace/project file architecture policy", () => {
  test("stores independent workspace and project policies with project precedence", async () => {
    const { runtime } = await fixture();
    try {
      const workspace = await runtime.architecturePolicies.set({ workspaceId: "test" }, {}, { ifNoneMatch: "*" });
      const alpha = await runtime.architecturePolicies.set({ workspaceId: "test", projectId: "alpha" }, {}, { ifNoneMatch: "*" });

      expect(workspace).toEqual(expect.objectContaining({
        workspaceId: "test",
        level: "workspace",
        enforcement: "required",
        architecture: "abcm-mvp-agent-spec-v0.5",
        sourcePath: "config/architecture.yaml",
      }));
      expect(alpha).toEqual(expect.objectContaining({
        workspaceId: "test",
        projectId: "alpha",
        level: "project",
        sourcePath: "alpha/config/architecture.yaml",
      }));
      expect((await runtime.architecturePolicies.resolve({ workspaceId: "test", projectId: "alpha" })).effective?.level).toBe("project");
      expect((await runtime.architecturePolicies.resolve({ workspaceId: "test", projectId: "beta" })).effective?.level).toBe("workspace");
      expect((await runtime.architecturePolicies.list("test")).map(policy => policy.sourcePath)).toEqual([
        "config/architecture.yaml",
        "alpha/config/architecture.yaml",
      ]);

      await runtime.architecturePolicies.delete({ workspaceId: "test", projectId: "alpha" }, { ifMatch: alpha.checksum });
      expect((await runtime.architecturePolicies.resolve({ workspaceId: "test", projectId: "alpha" })).effective?.level).toBe("workspace");
    } finally {
      await runtime.close();
    }
  });

  test("exposes mutable policies through REST and keeps project targets independent", async () => {
    const { runtime } = await fixture();
    try {
      const workspacePut = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/architecture-policy", {
        method: "PUT",
        headers: { "content-type": "application/json", "if-none-match": "*" },
        body: "{}",
      }));
      expect(workspacePut.status).toBe(201);
      expect(workspacePut.headers.get("etag")).toMatch(/^"sha256:[a-f0-9]{64}"$/);

      const alphaPut = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/projects/alpha/architecture-policy", {
        method: "PUT",
        headers: { "content-type": "application/json", "if-none-match": "*" },
        body: JSON.stringify({ enforcement: "required", architecture: "abcm-mvp-agent-spec-v0.5" }),
      }));
      expect(alphaPut.status).toBe(201);

      const list = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/architecture-policies"));
      expect(list.status).toBe(200);
      expect((await list.json()).policies).toHaveLength(2);

      const beta = await runtime.restHandler(new Request("http://localhost/v1/workspaces/test/projects/beta/architecture-policy"));
      expect(beta.status).toBe(200);
      expect(await beta.json()).toEqual(expect.objectContaining({ configured: null, effective: expect.objectContaining({ level: "workspace" }) }));
    } finally {
      await runtime.close();
    }
  });

  test("applies workspace and project policies through MCP", async () => {
    const { runtime } = await fixture();
    const server = runtime.createMcpServer();
    const client = new Client({ name: "architecture-policy-test", version: "0.1.0" }, { supportedProtocolVersions: ["2025-11-25"] });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const workspace = await client.callTool({ name: "workspace.set_architecture_policy", arguments: { workspaceId: "test", ifNoneMatch: "*" } });
      expect(workspace.isError).not.toBe(true);
      expect(workspace.structuredContent).toEqual(expect.objectContaining({ level: "workspace", enforcement: "required" }));

      const project = await client.callTool({ name: "workspace.set_architecture_policy", arguments: { workspaceId: "test", projectId: "alpha", ifNoneMatch: "*" } });
      expect(project.isError).not.toBe(true);
      expect(project.structuredContent).toEqual(expect.objectContaining({ level: "project", projectId: "alpha" }));

      const beta = await client.callTool({ name: "workspace.get_architecture_policy", arguments: { workspaceId: "test", projectId: "beta" } });
      expect(beta.structuredContent).toEqual(expect.objectContaining({ configured: null, effective: expect.objectContaining({ level: "workspace" }) }));
      const listed = await client.callTool({ name: "workspace.list_architecture_policies", arguments: { workspaceId: "test" } });
      expect((listed.structuredContent as { policies: unknown[] }).policies).toHaveLength(2);
    } finally {
      await client.close();
      await server.close();
      await runtime.close();
    }
  });

  test("reports normative violations and blocks context only when required policy applies", async () => {
    const { root, runtime } = await fixture();
    try {
      await mkdir(join(root, "alpha/artifacts"), { recursive: true });
      await writeFile(join(root, "alpha/artifacts/misplaced.md"), "---\nid: ARCH-BAD\nkind: architecture\ntitle: misplaced\n---\n");
      await runtime.scopeMap.scan("test");

      const withoutPolicy = await runtime.architecturePolicies.check({ workspaceId: "test", projectId: "alpha" });
      expect(withoutPolicy.status).toBe("not_configured");

      await runtime.architecturePolicies.set({ workspaceId: "test" }, {}, { ifNoneMatch: "*" });
      const compliance = await runtime.architecturePolicies.check({ workspaceId: "test", projectId: "alpha" });
      expect(compliance.status).toBe("noncompliant");
      expect(compliance.effectivePolicy?.level).toBe("workspace");
      expect(compliance.violations).toContainEqual(expect.objectContaining({ code: "ARCHITECTURE_CONTENT_PLACEMENT_INVALID" }));
      expect((await runtime.architecturePolicies.check({ workspaceId: "test", projectId: "beta" })).status).toBe("compliant");

      const bootstrap = await runtime.domainLanguage.createBootstrap({
        anchor: { workspaceId: "test", projectId: "alpha" },
        roleId: "executor",
      }, {
        principalId: "test",
        access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
      });
      await expect(runtime.contextBuilder.build({
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        roleId: "executor",
        taskType: "implementation",
        goal: "test",
      }, {
        principalId: "test",
        access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
      })).rejects.toMatchObject({ code: "ARCHITECTURE_POLICY_VIOLATION" });
    } finally {
      await runtime.close();
    }
  });

  test("rejects unknown projects, stale writes and unknown policy values", async () => {
    const { runtime } = await fixture();
    try {
      await expect(runtime.architecturePolicies.set({ workspaceId: "test", projectId: "missing" }, {})).rejects.toMatchObject({
        code: "PROJECT_ANCHOR_NOT_RESOLVED",
      });
      await expect(runtime.architecturePolicies.set({ workspaceId: "test" }, { architecture: "unknown" } as never)).rejects.toMatchObject({
        code: "REQUEST_INVALID",
      });
      const created = await runtime.architecturePolicies.set({ workspaceId: "test" }, {}, { ifNoneMatch: "*" });
      await expect(runtime.architecturePolicies.set({ workspaceId: "test" }, {}, { ifMatch: `sha256:${"0".repeat(64)}` })).rejects.toMatchObject({
        code: "FILE_CHECKSUM_MISMATCH",
      });
      expect((await runtime.architecturePolicies.get({ workspaceId: "test" }))?.checksum).toBe(created.checksum);
    } finally {
      await runtime.close();
    }
  });
});
