import { describe, expect, test } from "bun:test";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

describe("current repository migration", () => {
  test("is a readable and scannable ABCM workflow", async () => {
    const runtime = createAbcmRuntime({ id: "self", root: process.cwd() });
    const revision = await runtime.scopeMap.scan("self");
    expect(revision.nodes[0]).toEqual(expect.objectContaining({ scopeId: "abcm-development", kind: "workflow", status: "valid" }));
    expect(revision.diagnostics.filter(diagnostic => diagnostic.severity !== "warning")).toEqual([]);

    const files = await runtime.files.list("self", "", false);
    expect(files.map(entry => entry.path)).toContain("scope.yaml");
    expect(files.map(entry => entry.path)).not.toContain(".git");
    const manifest = await runtime.files.read("self", "scope.yaml");
    expect(new TextDecoder().decode(manifest.content)).toContain("id: abcm-development");
  });
});
