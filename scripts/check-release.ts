import { readFile } from "node:fs/promises";

import { ABCM_SERVER_INFO } from "../src/core/server-info.js";
import { parseSafeYaml } from "../src/core/safe-yaml.js";

const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
  name: string;
  version: string;
  license: string;
  files: string[];
  packageManager: string;
};
if (packageJson.version !== ABCM_SERVER_INFO.version) throw new Error("Package and server versions differ.");
if (packageJson.license !== "MIT") throw new Error("Release license must be MIT.");
if (packageJson.packageManager !== "bun@1.3.14") throw new Error("Release package manager must be pinned.");
const expectedFiles = ["LICENSE", "dist"];
if (JSON.stringify([...packageJson.files].sort()) !== JSON.stringify(expectedFiles)) throw new Error("Package file allowlist differs from the reviewed release contract.");

const lock = parseSafeYaml(await readFile("bun.lock", "utf8")) as { packages: Record<string, unknown> };
const sbom = JSON.parse(await readFile(".abcm-generated/sbom.cdx.json", "utf8")) as {
  bomFormat: string;
  specVersion: string;
  metadata: { component: { version: string } };
  components: unknown[];
};
if (sbom.bomFormat !== "CycloneDX" || sbom.specVersion !== "1.6") throw new Error("SBOM format is invalid.");
if (sbom.metadata.component.version !== packageJson.version) throw new Error("SBOM package version differs.");
if (sbom.components.length !== Object.keys(lock.packages).length) throw new Error("SBOM does not cover every locked package.");
for (const path of ["LICENSE", "README.md", "abcm-documentation.lock.json"]) {
  if ((await readFile(path)).byteLength === 0) throw new Error(`Release artifact '${path}' is empty.`);
}
console.log(JSON.stringify({ version: packageJson.version, lockedPackages: Object.keys(lock.packages).length, packageFiles: packageJson.files.length }));
