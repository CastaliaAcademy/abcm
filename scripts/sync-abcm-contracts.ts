import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ABCM_AGENT_INSTRUCTIONS } from "../src/agent-instructions/agent-instructions.js";
import { CANONICAL_PLAN_0033_PATHS, CANONICAL_REMOTE_EVIDENCE_PATHS } from "./documentation-contract-paths.js";

const baseUrl = (process.env.ABCM_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.ABCM_API_TOKEN;
if (!token) throw new Error("ABCM_API_TOKEN is required.");

const workspaceId = "castalia-public";
const projectPath = "abcm";
const root = process.cwd();
const encoder = new TextEncoder();

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function request(path: string, init: RequestInit = {}, allowNotFound = false): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init.headers },
  });
  if (allowNotFound && response.status === 404) return response;
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path}: HTTP ${response.status}.`);
  return response;
}

async function readRemote(path: string): Promise<{ bytes: Uint8Array; etag: string | null } | undefined> {
  const requestPath = `/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(`${projectPath}/${path}`)}`;
  const response = await request(requestPath, {}, true);
  if (response.status === 404) return undefined;
  return { bytes: new Uint8Array(await response.arrayBuffer()), etag: response.headers.get("etag") };
}

async function putRemote(path: string, bytes: Uint8Array): Promise<void> {
  const current = await readRemote(path);
  if (current && sha256(current.bytes) === sha256(bytes)) return;
  await request(`/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(`${projectPath}/${path}`)}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...(current?.etag ? { "if-match": current.etag } : {}) },
    body: Uint8Array.from(bytes).buffer,
  });
}

async function localBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(resolve(root, path)));
}

const files = new Map<string, Uint8Array>([
  ["docs/api/openapi-v1.json", await localBytes(".abcm-generated/openapi-v1.json")],
  ["docs/release/sbom.cdx.json", await localBytes(".abcm-generated/sbom.cdx.json")],
  ["docs/operations/agent-instructions.md", encoder.encode(ABCM_AGENT_INSTRUCTIONS)],
  ["docs/security/threat-model.md", await localBytes(".abcm-documentation/docs/security/threat-model.md")],
  ["artifacts/plans/ABCM-MVP/development-plan.md", await localBytes(".abcm-documentation/artifacts/plans/ABCM-MVP/development-plan.md")],
  ["docs/release/known-gaps-v0.1.0.md", await localBytes(".abcm-documentation/docs/release/known-gaps-v0.1.0.md")],
  ["docs/release/traceability-v0.1.0.yaml", await localBytes(".abcm-documentation/docs/release/traceability-v0.1.0.yaml")],
  ["artifacts/plans/PLAN-0028/plan.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0028/plan.md")],
  ["artifacts/plans/PLAN-0028/traceability.yaml", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0028/traceability.yaml")],
  ["artifacts/plans/PLAN-0028/features/obsidian-bidirectional-sync.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0028/features/obsidian-bidirectional-sync.md")],
  ["artifacts/plans/PLAN-0028/evidence/WU-09-github-draft-pr.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0028/evidence/WU-09-github-draft-pr.md")],
  ["artifacts/plans/PLAN-0031/plan.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0031/plan.md")],
  ["artifacts/plans/PLAN-0031/verification-plan.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0031/verification-plan.md")],
  ["artifacts/plans/PLAN-0031/traceability.yaml", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0031/traceability.yaml")],
  ["docs/spec/extensions/context-efficiency-evaluation-v0.1.yaml", await localBytes(".abcm-documentation/docs/spec/extensions/context-efficiency-evaluation-v0.1.yaml")],
  ["artifacts/plans/PLAN-0031/evidence/implementation.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0031/evidence/implementation.md")],
  ["artifacts/plans/PLAN-0031/evidence/server-owned-business-eval-2026-08-19.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0031/evidence/server-owned-business-eval-2026-08-19.md")],
  ["docs/spec/extensions/file-architecture-policy-v0.1.yaml", await localBytes(".abcm-documentation/docs/spec/extensions/file-architecture-policy-v0.1.yaml")],
  ["artifacts/plans/PLAN-0032/plan.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0032/plan.md")],
  ["artifacts/plans/PLAN-0032/verification-plan.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0032/verification-plan.md")],
  ["artifacts/plans/PLAN-0032/traceability.yaml", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0032/traceability.yaml")],
  ["artifacts/plans/PLAN-0032/evidence/implementation.md", await localBytes(".abcm-documentation/artifacts/plans/PLAN-0032/evidence/implementation.md")],
]);

for (const path of CANONICAL_PLAN_0033_PATHS) files.set(path, await localBytes(`.abcm-documentation/${path}`));

for (const [path, bytes] of files) await putRemote(path, bytes);

const remoteEvidence = new Map<string, Uint8Array>();
for (const path of CANONICAL_REMOTE_EVIDENCE_PATHS) {
  const current = await readRemote(path);
  if (current === undefined) throw new Error(`Canonical remote evidence '${path}' is missing.`);
  remoteEvidence.set(path, current.bytes);
}

const layoutPath = "config/documentation-layout.json";
const layoutRemote = await readRemote(layoutPath);
if (!layoutRemote) throw new Error("Documentation layout is missing.");
const layout = JSON.parse(new TextDecoder().decode(layoutRemote.bytes)) as {
  schemaVersion: 1;
  workspaceId: string;
  projectPath: string;
  files: Array<{ repositoryPath: string; workspacePath: string; checksum: string; size: number }>;
};
if (layout.schemaVersion !== 1 || layout.workspaceId !== workspaceId || layout.projectPath !== projectPath) {
  throw new Error("Documentation layout identity differs from the configured target.");
}
for (const [path, bytes] of files) {
  const entry = { repositoryPath: path, workspacePath: path, checksum: sha256(bytes), size: bytes.byteLength };
  const index = layout.files.findIndex(candidate => candidate.repositoryPath === path);
  if (index === -1) layout.files.push(entry);
  else layout.files[index] = entry;
}
for (const [path, bytes] of remoteEvidence) {
  const entry = { repositoryPath: path, workspacePath: path, checksum: sha256(bytes), size: bytes.byteLength };
  const index = layout.files.findIndex(candidate => candidate.repositoryPath === path);
  if (index === -1) layout.files.push(entry);
  else layout.files[index] = entry;
}
layout.files.sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath));
const layoutBytes = encoder.encode(`${JSON.stringify(layout, null, 2)}\n`);
await request(`/v1/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(`${projectPath}/${layoutPath}`)}`, {
  method: "PUT",
  headers: { "content-type": "application/json", ...(layoutRemote.etag ? { "if-match": layoutRemote.etag } : {}) },
  body: Uint8Array.from(layoutBytes).buffer,
});

const aggregate = layout.files.map(entry => `${entry.repositoryPath}\0${entry.workspacePath}\0${entry.checksum}\0${entry.size}\n`).join("");
const revision = await (await request(`/v1/workspaces/${workspaceId}/scope-map/scan`, { method: "POST" })).json() as { digest: string };
console.log(JSON.stringify({
  layoutDigest: sha256(layoutBytes),
  aggregateDigest: sha256(encoder.encode(aggregate)),
  fileCount: layout.files.length,
  scopeMapDigest: revision.digest,
}));
