import { describe, expect, test } from "bun:test";

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
});
