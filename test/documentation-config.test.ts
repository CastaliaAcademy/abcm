import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";
import { parseDocumentationSources } from "../src/documentation/config.js";

describe("documentation source configuration", () => {
  test("parses a strict deployment-owned source registry", () => {
    expect(
      parseDocumentationSources(
        '[{"id":"obsidian","workspaceId":"castalia-public","root":"/vault","targetBasePath":"abcm/artifacts/notes"}]',
      ),
    ).toEqual([
      { id: "obsidian", workspaceId: "castalia-public", root: "/vault", targetBasePath: "abcm/artifacts/notes" },
    ]);
    expect(() =>
      parseDocumentationSources(
        '[{"id":"obsidian","workspaceId":"castalia-public","root":"/vault","targetBasePath":"notes","unexpected":true}]',
      ),
    ).toThrow();
    expect(
      parseDocumentationSources(
        '[{"id":"docs","workspaceId":"castalia-public","root":"/vault","targetBasePath":"fallback","include":["docs/**"],"exclude":["docs/drafts/**"],"mapping":[{"match":"docs/adr/**","target":"artifacts/adr/"}]}]',
      ),
    ).toEqual([
      {
        id: "docs",
        workspaceId: "castalia-public",
        root: "/vault",
        targetBasePath: "fallback",
        include: ["docs/**"],
        exclude: ["docs/drafts/**"],
        mapping: [{ match: "docs/adr/**", target: "artifacts/adr/" }],
      },
    ]);
  });

  test("parses fail-closed reconciliation configuration", () => {
    expect(parseDocumentationSources(
      '[{"id":"docs","workspaceId":"castalia-private-backend","root":"/source","targetBasePath":"artifacts/import","reconciliation":{"manifestPath":"config/documentation/docs.yaml","unmappedPolicy":"conflict"}}]',
    )).toEqual([expect.objectContaining({
      reconciliation: { manifestPath: "config/documentation/docs.yaml", unmappedPolicy: "conflict" },
    })]);
  });

  test("requires SQLite when a documentation source is configured", () => {
    expect(() =>
      createAbcmRuntime(
        { id: "castalia-public", root: "/tmp/not-opened" },
        {
          documentationSources: [
            { id: "obsidian", workspaceId: "castalia-public", root: "/vault", targetBasePath: "artifacts/notes" },
          ],
        },
      ),
    ).toThrow("documentationSources require sqliteDerivedStoreEnabled=true");
  });

  test("requires an operator-selected source directory outside the canonical workspace", async () => {
    const container = await mkdtemp(join(tmpdir(), "abcm-documentation-boundary-"));
    const workspaceRoot = join(container, "workspace");
    const separateSourceRoot = join(container, "selected-source");
    await mkdir(workspaceRoot);
    await mkdir(separateSourceRoot);
    const runtime = createAbcmRuntime(
      { id: "castalia-public", root: workspaceRoot },
      {
        sqliteDerivedStoreEnabled: true,
        documentationSources: [{ id: "obsidian", workspaceId: "castalia-public", root: separateSourceRoot, targetBasePath: "artifacts/notes" }],
      },
    );
    try {
      await runtime.ready;
      expect(runtime.documentation).toBeDefined();
    } finally {
      await runtime.close();
      await rm(container, { recursive: true, force: true });
    }
  });

  test("rejects equal, nested, and ancestor source directories", async () => {
    const container = await mkdtemp(join(tmpdir(), "abcm-documentation-overlap-"));
    const workspaceRoot = join(container, "workspace");
    const nestedSourceRoot = join(workspaceRoot, "external-notes");
    await mkdir(nestedSourceRoot, { recursive: true });
    try {
      for (const root of [workspaceRoot, nestedSourceRoot, container]) {
        expect(() => createAbcmRuntime(
          { id: "castalia-public", root: workspaceRoot },
          {
            sqliteDerivedStoreEnabled: true,
            documentationSources: [{ id: "obsidian", workspaceId: "castalia-public", root, targetBasePath: "artifacts/notes" }],
          },
        )).toThrow("must not overlap canonical workspace");
      }
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });
});
