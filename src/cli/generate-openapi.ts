import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createAbcmOpenApiDocument } from "../rest/openapi.js";

const target = resolve(process.argv[2] ?? "docs/api/openapi-v1.json");
await writeFile(target, `${JSON.stringify(createAbcmOpenApiDocument(), null, 2)}\n`, "utf8");
console.log(target);
