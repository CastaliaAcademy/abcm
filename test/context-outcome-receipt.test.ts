import { afterEach, describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

const principal: ContextPrincipal = {
  principalId: "agent:outcome",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};
const sha = (value: string) => `sha256:${value.padEnd(64, "0")}` as const;

describe("immutable context outcome receipts", () => {
  test("связывает несколько повторов с fingerprint, сохраняет idempotency и не перезаписывает verdict", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-context-outcome-")); roots.push(root);
    await mkdir(join(root, "project/config"), { recursive: true });
    await mkdir(join(root, "domain-language"), { recursive: true });
    await mkdir(join(root, "project/domain-language"), { recursive: true });
    await mkdir(join(root, "project/artifacts"), { recursive: true });
    await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: workflow\n");
    await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: project\n");
    await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
    await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
    await writeFile(join(root, "project/artifacts/required.md"), "---\nid: required\nkind: guide\ntitle: Required\nrequired: true\n---\nOUTCOME_BODY_SENTINEL\n");

    const runtime = createAbcmRuntime({ id: "test", root }, { sqliteDerivedStoreEnabled: true, contextPrincipal: principal });
    try {
      await runtime.scopeMap.scan("test");
      const bootstrap = await runtime.domainLanguage.createBootstrap({ anchor: { workspaceId: "test", projectId: "project" }, roleId: "agent" }, principal);
      const bundle = await runtime.contextBuilder.build({
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        roleId: "agent",
        taskType: "evaluation",
        goal: "Проверить исход задачи",
        targetHints: ["project"],
        execution: { planId: "PLAN-0031", runId: "eval-run" },
      }, principal);
      const fingerprintId = bundle.contextFingerprintLocation.split("/").at(-1)!;
      const catalog = runtime.contextOutcomeCatalog!;
      const base = {
        workspaceId: "test",
        fingerprintId,
        runId: "eval-run",
        rubricVersion: "business-rubric-v1",
        judgeIdentityClass: "automated" as const,
        modelIdentityDigest: sha("1"),
        evidenceDigest: sha("2"),
        usage: { inputTokens: 206, outputTokens: 34 },
        totalCostMicrounits: 240,
      };
      const first = catalog.recordContextOutcome({ ...base, repeatId: "repeat-1", taskSucceeded: true });
      expect(catalog.recordContextOutcome({ ...base, repeatId: "repeat-1", taskSucceeded: true })).toEqual(first);
      const second = catalog.recordContextOutcome({ ...base, repeatId: "repeat-2", taskSucceeded: false, evidenceDigest: sha("3") });

      expect(second.outcomeId).not.toBe(first.outcomeId);
      expect(catalog.listContextOutcomes("test", fingerprintId)).toEqual([first, second]);
      expect(() => catalog.recordContextOutcome({ ...base, repeatId: "repeat-1", taskSucceeded: false })).toThrow(
        expect.objectContaining({ code: "CONTEXT_OUTCOME_CONFLICT" }),
      );
      expect(() => catalog.recordContextOutcome({ ...base, fingerprintId: `fingerprint-${"0".repeat(24)}`, repeatId: "repeat-3", taskSucceeded: true })).toThrow(
        expect.objectContaining({ code: "CONTEXT_FINGERPRINT_NOT_FOUND" }),
      );
      expect(JSON.stringify(catalog.listContextOutcomes("test", fingerprintId))).not.toContain("OUTCOME_BODY_SENTINEL");

      const rest = await runtime.restHandler(new Request("http://localhost/v1/context/outcomes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...base, repeatId: "repeat-3", taskSucceeded: true, evidenceDigest: sha("4") }),
      }));
      expect(rest.status).toBe(201);

      const server = runtime.createMcpServer();
      const client = new Client({ name: "context-outcome-test", version: "0.1.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport); await client.connect(clientTransport);
      try {
        const recorded = await client.callTool({ name: "context.record_outcome", arguments: { ...base, repeatId: "repeat-4", taskSucceeded: false, evidenceDigest: sha("5") } });
        expect(recorded.isError).not.toBe(true);
        const listed = await client.callTool({ name: "context.list_outcomes", arguments: { workspaceId: "test", fingerprintId } });
        expect((listed.structuredContent as { outcomes: unknown[] }).outcomes).toHaveLength(4);
        expect(JSON.stringify(listed.structuredContent)).not.toContain("OUTCOME_BODY_SENTINEL");
      } finally {
        await client.close(); await server.close();
      }

      const bytes = Buffer.from(await readFile(join(root, ".abcm/abcm.sqlite")));
      expect(bytes.includes(Buffer.from("OUTCOME_BODY_SENTINEL"))).toBe(false);
      const database = new Database(join(root, ".abcm/abcm.sqlite"), { readonly: true });
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_outcomes").get()?.count).toBe(4);
      database.close();
    } finally {
      await runtime.close();
    }
  });
});
