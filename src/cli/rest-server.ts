import { resolve } from "node:path";

import { createAbcmRuntime } from "../app/create-runtime.js";

const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "default";
const workspaceRoot = resolve(process.env.ABCM_WORKSPACE_ROOT ?? process.cwd());
const hostname = process.env.ABCM_HOST ?? "127.0.0.1";
const port = Number(process.env.ABCM_PORT ?? "8787");
const bearerToken = process.env.ABCM_API_TOKEN;

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("ABCM_PORT must be an integer from 0 to 65535.");
if (bearerToken === undefined) throw new Error("ABCM_API_TOKEN is required for the REST server.");

const runtime = createAbcmRuntime({ id: workspaceId, root: workspaceRoot }, { bearerToken });
await runtime.scopeMap.scan(workspaceId);

const server = Bun.serve({ hostname, port, fetch: runtime.restHandler });
console.log(`ABCM REST server listening on ${server.url} for workspace '${workspaceId}' at ${workspaceRoot}`);
