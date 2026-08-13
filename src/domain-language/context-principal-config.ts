import type { ContextPrincipal } from "./types.js";
import type { AbcmPermission } from "../scope-map/types.js";

const ALL_PERMISSIONS = [
  "scope.discover",
  "scope.read_metadata",
  "scope_map.read_full",
  "context.build",
  "document.read",
  "executable_resource.read",
] as const satisfies readonly AbcmPermission[];
const PERMISSIONS = new Set<AbcmPermission>(ALL_PERMISSIONS);

export function parseContextPrincipalEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  defaultPrincipalId: string,
): ContextPrincipal {
  const principalId = environment.ABCM_CONTEXT_PRINCIPAL_ID?.trim() || defaultPrincipalId;
  const configured = environment.ABCM_CONTEXT_PERMISSIONS;
  const workspacePermissions = configured === undefined
    ? [...ALL_PERMISSIONS]
    : configured.split(",").map(value => value.trim()).filter(Boolean);
  if (workspacePermissions.length === 0 || workspacePermissions.some(permission => !PERMISSIONS.has(permission as AbcmPermission))) {
    throw new Error("ABCM_CONTEXT_PERMISSIONS must be a non-empty comma-separated list of known permissions.");
  }
  return { principalId, access: { workspacePermissions: workspacePermissions as AbcmPermission[] } };
}
