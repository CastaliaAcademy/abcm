import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseSafeYaml } from "../src/core/safe-yaml.js";

interface Group { ids: string[]; tests: string[] }
interface SpecificationItem { id: string; level?: string }
interface Specification { requirements?: SpecificationItem[]; acceptanceScenarios?: SpecificationItem[]; acceptance?: SpecificationItem[] | Record<string, unknown> }
interface Manifest {
  release: string;
  baseline: { specification: string; requirements: Group[]; acceptance: Group[] };
  extensions: { directory: string; requirements: Group[]; acceptance: Group[] };
}

function items(value: SpecificationItem[] | Record<string, unknown> | undefined): SpecificationItem[] {
  if (Array.isArray(value)) return value;
  return Object.keys(value ?? {}).map(id => ({ id }));
}

function assertExact(label: string, expected: readonly string[], groups: readonly Group[]): void {
  const actual = groups.flatMap(group => group.ids);
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  const missing = expected.filter(id => !actual.includes(id));
  const extra = actual.filter(id => !expected.includes(id));
  if (duplicates.length > 0 || missing.length > 0 || extra.length > 0) {
    throw new Error(`${label} mismatch: duplicates=${duplicates.join(",")} missing=${missing.join(",")} extra=${extra.join(",")}`);
  }
}

async function assertTests(groups: readonly Group[]): Promise<void> {
  for (const group of groups) {
    if (group.ids.length === 0 || group.tests.length === 0) throw new Error("Traceability groups require ids and tests.");
    for (const path of group.tests) {
      if (!/^test\/.+\.test\.ts$/.test(path)) throw new Error(`Traceability test path '${path}' is outside the Bun test contract.`);
      await access(path);
    }
  }
}

export async function validateReleaseTraceability(manifestPath = "docs/release/traceability-v0.1.0.yaml") {
  const manifest = parseSafeYaml(await readFile(manifestPath, "utf8")) as Manifest;
  const baseline = parseSafeYaml(await readFile(manifest.baseline.specification, "utf8")) as Specification;
  const requirements = baseline.requirements ?? [];
  const acceptance = baseline.acceptanceScenarios ?? [];
  const mandatory = requirements.filter(item => item.level === "MUST" || item.level === "MUST_NOT");
  const optional = requirements.filter(item => item.level === "MAY");
  if (requirements.length !== 78 || mandatory.length !== 76 || optional.length !== 2 || acceptance.length !== 22) {
    throw new Error(`Baseline contract drift: requirements=${requirements.length} mandatory=${mandatory.length} may=${optional.length} acceptance=${acceptance.length}`);
  }
  assertExact("baseline requirements", requirements.map(item => item.id), manifest.baseline.requirements);
  assertExact("baseline acceptance", acceptance.map(item => item.id), manifest.baseline.acceptance);

  const extensionFiles = (await readdir(manifest.extensions.directory)).filter(path => path.endsWith(".yaml")).sort();
  const extensionRequirements: string[] = [];
  const extensionAcceptance: string[] = [];
  for (const file of extensionFiles) {
    const specification = parseSafeYaml(await readFile(join(manifest.extensions.directory, file), "utf8")) as Specification;
    extensionRequirements.push(...items(specification.requirements).map(item => item.id));
    extensionAcceptance.push(...items(specification.acceptanceScenarios).map(item => item.id));
    extensionAcceptance.push(...items(specification.acceptance).map(item => item.id));
  }
  assertExact("extension requirements", extensionRequirements, manifest.extensions.requirements);
  assertExact("extension acceptance", extensionAcceptance, manifest.extensions.acceptance);
  await assertTests([
    ...manifest.baseline.requirements,
    ...manifest.baseline.acceptance,
    ...manifest.extensions.requirements,
    ...manifest.extensions.acceptance,
  ]);
  return {
    release: manifest.release,
    baselineRequirements: requirements.length,
    baselineMandatory: mandatory.length,
    baselineMay: optional.length,
    baselineAcceptance: acceptance.length,
    extensionSpecifications: extensionFiles.length,
    extensionRequirements: extensionRequirements.length,
    extensionAcceptance: extensionAcceptance.length,
  };
}

if (import.meta.main) console.log(JSON.stringify(await validateReleaseTraceability()));
