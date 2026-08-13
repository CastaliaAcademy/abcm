import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseSafeYaml } from "../src/core/safe-yaml.js";
import { SqliteScopeMapStore } from "../src/derived-store/sqlite-scope-map-store.js";
import { DomainLanguageService } from "../src/domain-language/domain-language-service.js";
import { ScopePathResolver } from "../src/domain-language/scope-path-resolver.js";
import type { ContextPrincipal } from "../src/domain-language/types.js";
import { ScopeMapService } from "../src/scope-map/scope-map-service.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";

export interface LargeFixtureBenchmarkOptions {
  services?: number;
  featuresPerService?: number;
  iterations?: number;
}

export interface LargeFixtureBenchmarkResult {
  fixture: { scopes: number; documents: number; bytes: number };
  phasesMs: {
    fixtureWrite: number;
    rawHash: number;
    yamlParse: number;
    scopeMapScan: number;
    sqlitePublish: number;
    resolver: number;
    projection: number;
  };
}

const principal: ContextPrincipal = {
  principalId: "benchmark",
  access: { workspacePermissions: ["scope.discover", "scope.read_metadata", "context.build", "document.read"] },
};

function elapsed(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

async function scope(root: string, path: string, kind: string, id: string): Promise<number> {
  const directory = join(root, path);
  await mkdir(join(directory, "domain-language"), { recursive: true });
  const manifest = `apiVersion: abcm/v1\nkind: ${kind}\nid: ${id}\nname: ${id}\n`;
  const convention = "---\nmode: inherit-only\n---\n";
  await Promise.all([
    writeFile(join(directory, "scope.yaml"), manifest),
    writeFile(join(directory, "domain-language/DomainLanguageConvention.md"), convention),
  ]);
  return Buffer.byteLength(manifest) + Buffer.byteLength(convention);
}

export async function runLargeFixtureBenchmark(options: LargeFixtureBenchmarkOptions = {}): Promise<LargeFixtureBenchmarkResult> {
  const services = options.services ?? 10;
  const featuresPerService = options.featuresPerService ?? 10;
  const iterations = options.iterations ?? 100;
  if (![services, featuresPerService, iterations].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("Benchmark sizes must be positive safe integers.");
  }
  const root = await mkdtemp(join(tmpdir(), "abcm-large-fixture-"));
  try {
    const fixtureStarted = performance.now();
    let bytes = 0;
    bytes += await scope(root, "", "workflow", "workflow");
    bytes += await scope(root, "project", "project", "project");
    for (let service = 0; service < services; service++) {
      const serviceId = `service-${service}`;
      bytes += await scope(root, `project/${serviceId}`, "service", serviceId);
      for (let feature = 0; feature < featuresPerService; feature++) {
        const featureId = `feature-${service}-${feature}`;
        const path = `project/${serviceId}/${featureId}`;
        bytes += await scope(root, path, "feature", featureId);
        await mkdir(join(root, path, "artifacts"), { recursive: true });
        const document = `---\nid: DOC-${service}-${feature}\nkind: guide\ntitle: Fixture ${service}/${feature}\n---\nDeterministic benchmark content ${service}/${feature}.\n`;
        await writeFile(join(root, path, "artifacts/fixture.md"), document);
        bytes += Buffer.byteLength(document);
      }
    }
    const fixtureWrite = elapsed(fixtureStarted);

    const corpus = Buffer.alloc(Math.max(bytes, 1), 0x61);
    const hashStarted = performance.now();
    for (let index = 0; index < iterations; index++) createHash("sha256").update(corpus).digest();
    const rawHash = elapsed(hashStarted);

    const yaml = "apiVersion: abcm/v1\nkind: feature\nid: fixture\nname: Fixture\naliases: [one, two]\n";
    const parseStarted = performance.now();
    for (let index = 0; index < iterations * 10; index++) parseSafeYaml(yaml);
    const yamlParse = elapsed(parseStarted);

    const registry = new WorkspaceRegistry([{ id: "benchmark", root }]);
    const scopeMap = new ScopeMapService(registry);
    const scanStarted = performance.now();
    const revision = await scopeMap.scan("benchmark");
    const scopeMapScan = elapsed(scanStarted);

    const sqlite = new SqliteScopeMapStore(join(root, ".abcm/benchmark.sqlite"), { ownerId: "benchmark" });
    const sqliteStarted = performance.now();
    sqlite.publish(sqlite.beginScan("benchmark"), revision);
    const sqlitePublish = elapsed(sqliteStarted);
    sqlite.close();

    const language = new DomainLanguageService(registry, scopeMap);
    const resolver = new ScopePathResolver(language, scopeMap);
    const bootstrap = await language.createBootstrap({ anchor: { workspaceId: "benchmark", projectId: "project" } }, principal);
    const resolverStarted = performance.now();
    for (let index = 0; index < iterations; index++) {
      const service = index % services;
      const feature = index % featuresPerService;
      await resolver.resolve({
        domainLanguageBootstrapId: bootstrap.bootstrapId,
        goal: `Inspect feature ${service} ${feature}`,
        targetHints: [`feature-${service}-${feature}`],
      }, principal);
    }
    const resolverMs = elapsed(resolverStarted);

    const projectionStarted = performance.now();
    for (let index = 0; index < iterations; index++) scopeMap.getProjection("benchmark", "agent");
    const projection = elapsed(projectionStarted);

    return {
      fixture: { scopes: 2 + services + services * featuresPerService, documents: services * featuresPerService, bytes },
      phasesMs: { fixtureWrite, rawHash, yamlParse, scopeMapScan, sqlitePublish, resolver: resolverMs, projection },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await runLargeFixtureBenchmark({
    services: Number(process.env.ABCM_BENCH_SERVICES ?? 10),
    featuresPerService: Number(process.env.ABCM_BENCH_FEATURES_PER_SERVICE ?? 10),
    iterations: Number(process.env.ABCM_BENCH_ITERATIONS ?? 100),
  });
  console.log(JSON.stringify(result, null, 2));
}
