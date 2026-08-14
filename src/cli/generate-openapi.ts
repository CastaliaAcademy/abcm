import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createAbcmOpenApiDocument } from "../rest/openapi.js";

const target = resolve(process.argv[2] ?? ".abcm-generated/openapi-v1.json");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(createAbcmOpenApiDocument(), null, 2)}\n`, "utf8");
console.log(target);
