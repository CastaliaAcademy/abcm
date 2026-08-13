import { resolve } from "node:path";

import { createAbcmRuntime } from "abcm-mcp-server";

const workspaceId = process.env.ABCM_WORKSPACE_ID ?? "example";
const root = resolve(process.env.ABCM_WORKSPACE_ROOT ?? process.cwd());
const runtime = createAbcmRuntime({ id: workspaceId, root });
try {
  const revision = await runtime.scopeMap.scan(workspaceId);
  console.log(JSON.stringify({ workspaceId, revision: revision.revision, scopes: revision.nodes.length, documents: revision.documents.length }));
} finally {
  await runtime.close();
}
