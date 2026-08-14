import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function addScope(root: string, path: string, kind: string, id: string): Promise<void> {
  const directory = join(root, path);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  await writeFile(join(directory, "scope.yaml"), `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`);
  if (kind === "project") {
    await mkdir(join(directory, "config"), { recursive: true });
    await writeFile(join(directory, "config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  }
  await writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
}

const principal: ContextPrincipal = {
  principalId: "agent:catalog",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};

describe("context fingerprint SQLite catalog", () => {
  test("catalogues one body-free bundle/fingerprint idempotently and fails closed on identity reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "abcm-context-catalog-"));
    roots.push(root);
    await addScope(root, "", "workflow", "workflow");
    await addScope(root, "project", "project", "commerce");
    await addScope(root, "project/catalog", "service", "catalog");
    await addScope(root, "project/catalog/search", "feature", "search");
    await mkdir(join(root, "project/catalog/search/artifacts"), { recursive: true });
    await writeFile(
      join(root, "project/catalog/search/artifacts/required.md"),
      "---\nid: required\nkind: guide\ntitle: Required\nrequired: true\n---\nCATALOG_BODY_SENTINEL\n",
    );

    const runtime = createAbcmRuntime({ id: "test", root }, {
      sqliteDerivedStoreEnabled: true,
      contextPrincipal: principal,
    });
    try {
      await runtime.scopeMap.scan("test");
      const bootstrap = await runtime.domainLanguage.createBootstrap({
        anchor: { workspaceId: "test", projectId: "commerce" },
        roleId: "executor-agent",
      }, principal);
      const request = {
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        roleId: "executor-agent",
        taskType: "implementation",
        goal: "Implement search",
        targetHints: ["search"],
        execution: { planId: "PLAN-0025", runId: "run-1" },
      } as const;
      const first = await runtime.contextBuilder.build(request, principal);
      const second = await runtime.contextBuilder.build(request, principal);
      expect(second.bundleDigest).toBe(first.bundleDigest);
      expect(second.contextFingerprintLocation).toBe(first.contextFingerprintLocation);

      const catalog = runtime.contextFingerprintCatalog!;
      const bundles = catalog.listContextBundles("test");
      expect(bundles).toEqual([expect.objectContaining({
        workspaceId: "test",
        bundleDigest: first.bundleDigest,
        mapRevision: first.mapRevision,
        tokenEstimate: first.tokenEstimate,
        selectedDocumentCount: 1,
      })]);
      const fingerprintId = first.contextFingerprintLocation.split("/").at(-1)!;
      const record = catalog.getContextFingerprint("test", fingerprintId)!;
      expect(record).toEqual(expect.objectContaining({
        workspaceId: "test",
        fingerprintId,
        bundleDigest: first.bundleDigest,
        principalId: principal.principalId,
        location: first.contextFingerprintLocation,
      }));
      expect(record.fingerprint.selectedDocuments).toHaveLength(1);
      expect(JSON.stringify(record)).not.toContain("CATALOG_BODY_SENTINEL");
      expect(() => catalog.recordContextFingerprint("test", `${record.location}-conflict`, record.fingerprint)).toThrow(
        expect.objectContaining({ code: "CONTEXT_FINGERPRINT_CONFLICT" }),
      );

      const databasePath = join(root, ".abcm/abcm.sqlite");
      const bytes = Buffer.from(await readFile(databasePath));
      expect(bytes.includes(Buffer.from("CATALOG_BODY_SENTINEL"))).toBe(false);
      const database = new Database(databasePath, { readonly: true });
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_bundles").get()?.count).toBe(1);
      expect(database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM context_fingerprints").get()?.count).toBe(1);
      database.close();
    } finally {
      await runtime.close();
    }
  });
});
