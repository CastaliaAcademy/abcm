export interface WorkspaceDefinition {
  id: string;
  root: string;
  deniedDirectories?: readonly string[];
  maxReadBytes?: number;
  maxWriteBytes?: number;
  maxListEntries?: number;
  maxIndexBytes?: number;
}

export interface ResolvedWorkspace extends Required<Omit<WorkspaceDefinition, "deniedDirectories">> {
  deniedDirectories: ReadonlySet<string>;
}

export interface FileEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
  checksum?: string;
}

export interface ReadFileResult {
  entry: FileEntry & { checksum: string };
  content: Uint8Array;
  contentType: string;
}

export interface WritePreconditions {
  ifMatch?: string;
  ifNoneMatch?: "*";
}

export interface DeletePreconditions {
  ifMatch?: string;
}

export interface MoveOptions extends DeletePreconditions {
  overwrite?: boolean;
}

export interface DeleteDirectoryOptions {
  recursive: boolean;
}

export type MutationReconciler = (workspaceId: string, changedPaths: readonly string[]) => Promise<void>;
export type FileMutationOperation = "write" | "delete" | "move" | "amend";
export type MutationAuthorizer = (
  workspaceId: string,
  changedPaths: readonly string[],
  operation: FileMutationOperation,
) => Promise<void>;
