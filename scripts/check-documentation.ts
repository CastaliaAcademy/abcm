import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { ABCM_AGENT_INSTRUCTIONS } from "../src/agent-instructions/agent-instructions.js";
import { validateReleaseTraceability } from "./check-traceability.js";

async function filesBelow(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), path);
      else if (entry.isFile()) result.push(path);
    }
  }
  await visit(root, "");
  return result.sort();
}

async function assertSame(left: string, right: string, label: string): Promise<void> {
  const [leftBytes, rightBytes] = await Promise.all([readFile(left), readFile(right)]);
  if (!leftBytes.equals(rightBytes)) throw new Error(`${label} differs from the generated code contract.`);
}

const documentationRoot = resolve(process.argv[2] ?? ".abcm-documentation");
const traceability = await validateReleaseTraceability(documentationRoot);
await assertSame(join(documentationRoot, "docs/api/openapi-v1.json"), ".abcm-generated/openapi-v1.json", "Exported OpenAPI snapshot");
await assertSame(join(documentationRoot, "docs/release/sbom.cdx.json"), ".abcm-generated/sbom.cdx.json", "Exported SBOM snapshot");
const exportedInstructions = await readFile(join(documentationRoot, "docs/operations/agent-instructions.md"), "utf8");
if (exportedInstructions !== ABCM_AGENT_INSTRUCTIONS) throw new Error("Exported agent instructions differ from the executable contract.");
const files = await filesBelow(documentationRoot);
if (files.length === 0) throw new Error("ABCM documentation export is empty.");
console.log(JSON.stringify({ files: files.length, traceability }));
