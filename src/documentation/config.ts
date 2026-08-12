import { z } from "zod/v4";

import type { DirectoryDocumentationSourceDefinition } from "./types.js";

const sourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    workspaceId: z.string().min(1),
    root: z.string().min(1),
    targetBasePath: z.string().min(1),
  })
  .strict();

const sourcesSchema = z.array(sourceSchema).min(1);

export function parseDocumentationSources(value: string | undefined): readonly DirectoryDocumentationSourceDefinition[] | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`ABCM_DOCUMENTATION_SOURCES must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return sourcesSchema.parse(parsed);
}
