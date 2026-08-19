import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "abcm-plantuml-"));
  roots.push(root);
  await mkdir(join(root, "domain-language"), { recursive: true });
  await mkdir(join(root, "project/config"), { recursive: true });
  await mkdir(join(root, "project/domain-language"), { recursive: true });
  await mkdir(join(root, "project/architecture/plantuml/data-flows"), { recursive: true });
  await writeFile(join(root, "scope.yaml"), "apiVersion: abcm/v1\nkind: workflow\nid: workflow\nname: workflow\n");
  await writeFile(join(root, "domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  await writeFile(join(root, "project/scope.yaml"), "apiVersion: abcm/v1\nkind: project\nid: project\nname: project\n");
  await writeFile(join(root, "project/config/context.yaml"), "apiVersion: abcm/v1\nkind: ContextConfig\nlanguage: ru\n");
  await writeFile(join(root, "project/domain-language/DomainLanguageConvention.md"), "---\nmode: inherit-only\n---\n");
  return { root, service: new ScopeMapService(new WorkspaceRegistry([{ id: "test", root }])) };
}

describe("typed PlantUML ScopeMap resources", () => {
  test("indexes valid architecture sources and a checksum-pinned local include closure", async () => {
    const { root, service } = await fixture();
    const directory = join(root, "project/architecture/plantuml/data-flows");
    await writeFile(join(directory, "common.puml"), "@startuml\ncomponent Common\n@enduml\n");
    await writeFile(join(directory, "orders.puml"), "@startuml\n!include common.puml\nOrders -> Common\n@enduml\n");

    const revision = await service.scan("test");

    expect(revision.executableResources).toEqual([
      expect.objectContaining({
        relativePath: "project/architecture/plantuml/data-flows/common.puml",
        language: "plantuml",
        resourceType: "architecture-source/plantuml",
        dependencies: [],
      }),
      expect.objectContaining({
        relativePath: "project/architecture/plantuml/data-flows/orders.puml",
        language: "plantuml",
        resourceType: "architecture-source/plantuml",
        dependencies: ["project/architecture/plantuml/data-flows/common.puml"],
      }),
    ]);
    expect(service.getProjection("test", "admin").resourceSummary.executableResources).toBe(2);
    expect(revision.diagnostics).toEqual([]);
  });

  test("rejects invalid envelopes, unsafe or missing includes and dependency cycles", async () => {
    const { root, service } = await fixture();
    const directory = join(root, "project/architecture/plantuml/data-flows");
    await writeFile(join(directory, "no-envelope.puml"), "component MissingEnvelope\n");
    await writeFile(join(directory, "unsafe.puml"), "@startuml\n!include ../../../../secret.puml\n@enduml\n");
    await writeFile(join(directory, "missing.puml"), "@startuml\n!include absent.puml\n@enduml\n");
    await writeFile(join(directory, "cycle-a.puml"), "@startuml\n!include cycle-b.puml\n@enduml\n");
    await writeFile(join(directory, "cycle-b.puml"), "@startuml\n!include cycle-a.puml\n@enduml\n");

    const revision = await service.scan("test");

    expect(revision.executableResources).toEqual([]);
    expect(revision.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "PLANTUML_ENVELOPE_INVALID", path: "project/architecture/plantuml/data-flows/no-envelope.puml" }),
      expect.objectContaining({ code: "PLANTUML_INCLUDE_INVALID", path: "project/architecture/plantuml/data-flows/unsafe.puml" }),
      expect.objectContaining({ code: "PLANTUML_INCLUDE_UNRESOLVED", path: "project/architecture/plantuml/data-flows/missing.puml" }),
      expect.objectContaining({ code: "PLANTUML_INCLUDE_CYCLE", path: "project/architecture/plantuml/data-flows/cycle-a.puml" }),
      expect.objectContaining({ code: "PLANTUML_INCLUDE_CYCLE", path: "project/architecture/plantuml/data-flows/cycle-b.puml" }),
    ]));
  });
});
