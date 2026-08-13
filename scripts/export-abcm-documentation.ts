import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { posix } from "node:path";

interface DocumentationLock {
  schemaVersion: 1;
  workspaceId: string;
  projectPath: string;
  layoutPath: string;
  layoutDigest: string;
  aggregateDigest: string;
  fileCount: number;
  scopeMapDigest: string;
}

interface DocumentationLayoutEntry {
  repositoryPath: string;
  workspacePath: string;
  checksum: string;
  size: number;
}

interface DocumentationLayout {
  schemaVersion: 1;
  workspaceId: string;
  projectPath: string;
  files: DocumentationLayoutEntry[];
}

function sha256(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function assertRelativeFilePath(path: string, label: string): void {
  if (path === "" || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`${label} '${path}' is not a safe relative file path.`);
  }
}

function aggregateDigest(entries: readonly DocumentationLayoutEntry[]): string {
  const canonical = [...entries]
    .sort((left, right) => left.repositoryPath.localeCompare(right.repositoryPath))
    .map(entry => `${entry.repositoryPath}\0${entry.workspacePath}\0${entry.checksum}\0${entry.size}\n`)
    .join("");
  return sha256(new TextEncoder().encode(canonical));
}

function assertUnique(entries: readonly DocumentationLayoutEntry[], key: "repositoryPath" | "workspacePath"): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry[key])) throw new Error(`Documentation layout contains duplicate ${key} '${entry[key]}'.`);
    seen.add(entry[key]);
  }
}

const lockPath = resolve(process.argv[2] ?? "abcm-documentation.lock.json");
const outputRoot = resolve(process.argv[3] ?? ".abcm-documentation");
const outputRelative = relative(process.cwd(), outputRoot);
if (outputRelative === "" || outputRelative === ".." || outputRelative.startsWith(`..${sep}`) || isAbsolute(outputRelative)) {
  throw new Error("Documentation export directory must be a child of the current repository.");
}

const baseUrl = (process.env.ABCM_BASE_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.ABCM_API_TOKEN;
if (token === undefined || token === "") throw new Error("ABCM_API_TOKEN is required for documentation export.");

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...init?.headers },
  });
  if (!response.ok) throw new Error(`ABCM request ${init?.method ?? "GET"} ${path} failed with HTTP ${response.status}.`);
  return response;
}

const lock = JSON.parse(await readFile(lockPath, "utf8")) as DocumentationLock;
if (lock.schemaVersion !== 1) throw new Error("Unsupported ABCM documentation lock schema.");
assertRelativeFilePath(lock.projectPath, "projectPath");
assertRelativeFilePath(lock.layoutPath, "layoutPath");

const layoutWorkspacePath = posix.join(lock.projectPath, lock.layoutPath);
const layoutBytes = new Uint8Array(await (await request(`/v1/workspaces/${encodeURIComponent(lock.workspaceId)}/files/content?path=${encodeURIComponent(layoutWorkspacePath)}`)).arrayBuffer());
if (sha256(layoutBytes) !== lock.layoutDigest) throw new Error("ABCM documentation layout digest differs from the tracked lock.");

const layout = JSON.parse(new TextDecoder().decode(layoutBytes)) as DocumentationLayout;
if (layout.schemaVersion !== 1 || layout.workspaceId !== lock.workspaceId || layout.projectPath !== lock.projectPath) {
  throw new Error("ABCM documentation layout identity differs from the tracked lock.");
}
if (!Array.isArray(layout.files) || layout.files.length !== lock.fileCount) throw new Error("ABCM documentation layout file count differs from the tracked lock.");
for (const entry of layout.files) {
  assertRelativeFilePath(entry.repositoryPath, "repositoryPath");
  assertRelativeFilePath(entry.workspacePath, "workspacePath");
  if (!/^sha256:[0-9a-f]{64}$/.test(entry.checksum) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`ABCM documentation layout metadata is invalid for '${entry.repositoryPath}'.`);
  }
}
assertUnique(layout.files, "repositoryPath");
assertUnique(layout.files, "workspacePath");
if (aggregateDigest(layout.files) !== lock.aggregateDigest) throw new Error("ABCM documentation aggregate digest differs from the tracked lock.");

const temporaryRoot = resolve(`${outputRoot}.tmp-${process.pid}`);
await rm(temporaryRoot, { recursive: true, force: true });
await mkdir(temporaryRoot, { recursive: true });
try {
  await Promise.all(layout.files.map(async entry => {
    const workspacePath = posix.join(lock.projectPath, entry.workspacePath);
    const content = new Uint8Array(await (await request(`/v1/workspaces/${encodeURIComponent(lock.workspaceId)}/files/content?path=${encodeURIComponent(workspacePath)}`)).arrayBuffer());
    if (content.byteLength !== entry.size || sha256(content) !== entry.checksum) {
      throw new Error(`ABCM documentation content differs from the lock for '${entry.repositoryPath}'.`);
    }
    const target = resolve(temporaryRoot, entry.repositoryPath);
    const targetRelative = relative(temporaryRoot, target);
    if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) throw new Error(`Export path escapes the output root: '${entry.repositoryPath}'.`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }));

  const revision = await (await request(`/v1/workspaces/${encodeURIComponent(lock.workspaceId)}/scope-map/scan`, { method: "POST" })).json() as { digest?: string };
  if (revision.digest !== lock.scopeMapDigest) throw new Error("ABCM ScopeMap digest differs from the tracked lock.");
  await rm(outputRoot, { recursive: true, force: true });
  await rename(temporaryRoot, outputRoot);
  console.log(JSON.stringify({ workspaceId: lock.workspaceId, projectPath: lock.projectPath, output: outputRelative, files: layout.files.length, aggregateDigest: lock.aggregateDigest, scopeMapDigest: lock.scopeMapDigest }));
} catch (error) {
  await rm(temporaryRoot, { recursive: true, force: true });
  throw error;
}
