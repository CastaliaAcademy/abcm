import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkspaceFileService } from "../src/workspace/file-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createService(onMutation?: (paths: readonly string[]) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "abcm-files-"));
  roots.push(root);
  const registry = new WorkspaceRegistry([{ id: "test", root }]);
  return {
    root,
    service: new WorkspaceFileService(registry, onMutation === undefined ? {} : { onMutation }),
  };
}

describe("WorkspaceFileService", () => {
  test("performs CRUD and move against canonical filesystem bytes", async () => {
    const mutations: string[][] = [];
    const { root, service } = await createService(async paths => {
      mutations.push([...paths]);
    });

    await service.createDirectory("test", "docs");
    const created = await service.write("test", "docs/a.md", new TextEncoder().encode("alpha"), {
      ifNoneMatch: "*",
    });
    expect(await readFile(join(root, "docs/a.md"), "utf8")).toBe("alpha");

    const read = await service.read("test", "docs/a.md");
    expect(new TextDecoder().decode(read.content)).toBe("alpha");
    expect(read.entry.checksum).toBe(created.checksum);

    const replaced = await service.write("test", "docs/a.md", new TextEncoder().encode("beta"), {
      ifMatch: created.checksum,
    });
    expect(replaced.checksum).not.toBe(created.checksum);

    await service.move("test", "docs/a.md", "docs/b.md", { ifMatch: replaced.checksum, overwrite: false });
    expect((await service.list("test", "docs", false)).map(entry => entry.path)).toEqual(["docs/b.md"]);

    await service.delete("test", "docs/b.md", { ifMatch: replaced.checksum });
    expect(await service.list("test", "docs", false)).toEqual([]);
    expect(mutations.length).toBe(5);
  });

  test("rejects stale writes without changing bytes", async () => {
    const { root, service } = await createService();
    const created = await service.write("test", "plan.md", new TextEncoder().encode("v1"), { ifNoneMatch: "*" });
    await writeFile(join(root, "plan.md"), "external-v2");

    expect(
      service.write("test", "plan.md", new TextEncoder().encode("client-v2"), { ifMatch: created.checksum }),
    ).rejects.toMatchObject({ code: "FILE_CHECKSUM_MISMATCH" });
    expect(await readFile(join(root, "plan.md"), "utf8")).toBe("external-v2");
  });

  test("rejects stale deletes and move collisions without changing either file", async () => {
    const { root, service } = await createService();
    const stale = await service.write("test", "stale.md", new TextEncoder().encode("v1"), { ifNoneMatch: "*" });
    await writeFile(join(root, "stale.md"), "external-v2");

    expect(service.delete("test", "stale.md", { ifMatch: stale.checksum })).rejects.toMatchObject({
      code: "FILE_CHECKSUM_MISMATCH",
    });
    expect(await readFile(join(root, "stale.md"), "utf8")).toBe("external-v2");

    await service.write("test", "source.md", new TextEncoder().encode("source"), { ifNoneMatch: "*" });
    await service.write("test", "target.md", new TextEncoder().encode("target"), { ifNoneMatch: "*" });
    expect(service.move("test", "source.md", "target.md")).rejects.toMatchObject({ code: "FILE_ALREADY_EXISTS" });
    expect(await readFile(join(root, "source.md"), "utf8")).toBe("source");
    expect(await readFile(join(root, "target.md"), "utf8")).toBe("target");
  });

  test("does not disclose reserved directories in recursive listings", async () => {
    const { root, service } = await createService();
    await writeFile(join(root, "README.md"), "visible");
    await Bun.write(join(root, ".env"), "secret");
    await Bun.write(join(root, "node_modules/pkg/index.js"), "ignored");

    const paths = (await service.list("test", "", true)).map(entry => entry.path);
    expect(paths).toEqual(["README.md"]);
  });
});
