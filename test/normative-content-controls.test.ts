import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAbcmRuntime } from "../src/app/create-runtime.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

const artifact = (id: string, kind: string, status: string, body: string) =>
  `---\nid: ${id}\nkind: ${kind}\ntitle: ${id}\nstatus: ${status}\n---\n${body}\n`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-normative-content-"));
  roots.push(root);
  for (const directory of ["domain-language", "artifacts/adr", "artifacts/rfc", "architecture", "agents/roles"]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: Workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "artifacts/adr/ADR-0001.md"), artifact("ADR-0001", "adr", "accepted", "accepted bytes"));
  await writeFile(join(root, "artifacts/rfc/RFC-DRAFT.md"), artifact("RFC-DRAFT", "rfc", "draft", "draft bytes"));
  await writeFile(join(root, "architecture/misplaced-adr.md"), artifact("ADR-BAD", "adr", "draft", "misplaced"));
  await writeFile(join(root, "artifacts/misplaced-architecture.md"), artifact("ARCH-BAD", "architecture", "active", "misplaced"));
  await writeFile(join(root, "artifacts/diagram.puml"), "@startuml\nA -> B\n@enduml\n");
  await writeFile(join(root, "agents/misplaced-role.md"), "---\napiVersion: abcm/v1\nkind: AgentRole\nid: misplaced\ndisplayName: Misplaced\n---\n");
  await writeFile(join(root, "agents/roles/executor.md"), "---\napiVersion: abcm/v1\nkind: AgentRole\nid: executor\ndisplayName: Executor\n---\n");
  const runtime = createAbcmRuntime({ id: "test", root });
  const revision = await runtime.scopeMap.scan("test");
  return { root, runtime, revision };
}

describe("normative content controls", () => {
  test("excludes misplaced roles/artifacts/architecture while retaining valid siblings", async () => {
    const { runtime, revision } = await fixture();
    try {
      expect(revision.documents.map(document => document.documentId)).toEqual(["ADR-0001", "RFC-DRAFT"]);
      expect(revision.diagnostics.filter(diagnostic => diagnostic.code === "ARTIFACT_PLACEMENT_INVALID")).toEqual([
        expect.objectContaining({ path: "agents/misplaced-role.md", scopeId: "workflow" }),
        expect.objectContaining({ path: "architecture/misplaced-adr.md", scopeId: "workflow" }),
        expect.objectContaining({ path: "artifacts/diagram.puml", scopeId: "workflow" }),
        expect.objectContaining({ path: "artifacts/misplaced-architecture.md", scopeId: "workflow" }),
      ]);
      expect(revision.files).toContainEqual(expect.objectContaining({
        relativePath: "agents/roles/executor.md",
        classification: "agent_definition",
      }));
    } finally {
      await runtime.close();
    }
  });

  test("protects accepted ADR/RFC bytes but permits draft edits and checksum-preserving rename", async () => {
    const { root, runtime } = await fixture();
    try {
      const acceptedPath = "artifacts/adr/ADR-0001.md";
      const accepted = await runtime.files.read("test", acceptedPath);
      const rest = await runtime.restHandler(new Request(`http://localhost/v1/workspaces/test/files/content?path=${encodeURIComponent(acceptedPath)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream", "if-match": `"${accepted.entry.checksum}"` },
        body: "changed",
      }));
      expect(rest.status).toBe(409);
      expect(await rest.json()).toEqual(expect.objectContaining({ code: "ACCEPTED_ARTIFACT_IMMUTABLE" }));
      await expect(runtime.files.delete("test", acceptedPath, { ifMatch: accepted.entry.checksum })).rejects.toMatchObject({
        code: "ACCEPTED_ARTIFACT_IMMUTABLE",
      });

      await runtime.files.write("test", "artifacts/adr/replacement.md", new TextEncoder().encode("replacement"), { ifNoneMatch: "*" });
      await expect(runtime.files.move("test", "artifacts/adr/replacement.md", acceptedPath, { overwrite: true })).rejects.toMatchObject({
        code: "ACCEPTED_ARTIFACT_IMMUTABLE",
      });
      expect([...await readFile(join(root, acceptedPath))]).toEqual([...accepted.content]);
      expect(await readFile(join(root, "artifacts/adr/replacement.md"), "utf8")).toBe("replacement");

      const draftPath = "artifacts/rfc/RFC-DRAFT.md";
      const draft = await runtime.files.read("test", draftPath);
      await runtime.files.write("test", draftPath, new TextEncoder().encode(artifact("RFC-DRAFT", "rfc", "draft", "edited")), {
        ifMatch: draft.entry.checksum,
      });
      expect(await readFile(join(root, draftPath), "utf8")).toContain("edited");

      const renamedPath = "artifacts/adr/ADR-0001--renamed.md";
      const moved = await runtime.files.move("test", acceptedPath, renamedPath, { ifMatch: accepted.entry.checksum });
      expect(moved.checksum).toBe(accepted.entry.checksum);
      expect(runtime.scopeMap.getActiveRevision("test").documents).toContainEqual(expect.objectContaining({
        documentId: "ADR-0001",
        relativePath: renamedPath,
        checksum: accepted.entry.checksum,
      }));
    } finally {
      await runtime.close();
    }
  });
});
