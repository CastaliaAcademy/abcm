import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { parseSafeYaml } from "../src/core/safe-yaml.js";

interface LockPackageEntry extends Array<unknown> {
  0: string;
  2: { dependencies?: Record<string, string> };
  3: string;
}

interface BunLock {
  packages: Record<string, LockPackageEntry>;
}

function purl(name: string, version: string): string {
  if (!name.startsWith("@")) return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
  const [scope, packageName] = name.slice(1).split("/");
  if (scope === undefined || packageName === undefined) throw new Error(`Invalid scoped npm package '${name}'.`);
  return `pkg:npm/${encodeURIComponent(`@${scope}`)}/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`;
}

function versionOf(name: string, locator: string): string {
  const version = locator.slice(name.length + 1);
  if (version === "" || locator.slice(0, name.length) !== name) throw new Error(`Invalid Bun lock locator for '${name}'.`);
  return version;
}

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { name: string; version: string };
const lock = parseSafeYaml(await readFile("bun.lock", "utf8")) as BunLock;
const components = Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => {
  const version = versionOf(name, entry[0]);
  const integrity = entry[3];
  if (!integrity.startsWith("sha512-")) throw new Error(`Missing SHA-512 integrity for '${name}'.`);
  const componentPurl = purl(name, version);
  return {
    type: "library",
    "bom-ref": componentPurl,
    name,
    version,
    hashes: [{ alg: "SHA-512", content: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex") }],
    purl: componentPurl,
  };
});
const dependencies = Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right)).map(([name, entry]) => {
  const ref = purl(name, versionOf(name, entry[0]));
  const dependsOn = Object.keys(entry[2]?.dependencies ?? {}).sort().map(dependency => {
    const target = lock.packages[dependency];
    if (target === undefined) throw new Error(`Locked dependency '${dependency}' is missing.`);
    return purl(dependency, versionOf(dependency, target[0]));
  });
  return { ref, dependsOn };
});
const applicationRef = purl(packageJson.name, packageJson.version);
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: { type: "application", "bom-ref": applicationRef, name: packageJson.name, version: packageJson.version, purl: applicationRef },
    properties: [
      { name: "abcm:lockfile", value: "bun.lock" },
      { name: "abcm:lockfile-sha256", value: `sha256:${createHash("sha256").update(await readFile("bun.lock")).digest("hex")}` },
    ],
  },
  components,
  dependencies: [{ ref: applicationRef, dependsOn: components.map(component => component["bom-ref"]).sort() }, ...dependencies],
};
await mkdir("docs/release", { recursive: true });
await writeFile("docs/release/sbom.cdx.json", `${JSON.stringify(bom, null, 2)}\n`);
console.log(JSON.stringify({ output: "docs/release/sbom.cdx.json", components: components.length + 1 }));
