import { describe, expect, test } from "bun:test";

import { WorkspaceRegistry } from "../src/workspace/registry.js";

describe("WorkspaceRegistry", () => {
  test("registers a new workspace and rejects duplicate ids without replacing the first root", () => {
    const registry = new WorkspaceRegistry([{ id: "initial", root: "/tmp/initial" }]);

    expect(registry.register({ id: "castalia-public", root: "/tmp/castalia-public" })).toEqual(
      expect.objectContaining({ id: "castalia-public", root: "/tmp/castalia-public" }),
    );

    expect(() => registry.register({ id: "castalia-public", root: "/tmp/replacement" })).toThrow(
      expect.objectContaining({ code: "WORKSPACE_ALREADY_EXISTS" }),
    );
    expect(registry.get("castalia-public").root).toBe("/tmp/castalia-public");
  });
});
