import { z } from "zod/v4";

import { parseSafeYaml } from "./safe-yaml.js";

export const projectLanguageTagSchema = z.string().trim().min(1).refine(value => {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}, "language must be a valid BCP 47 tag.");

const projectContextConfigSchema = z.object({
  apiVersion: z.literal("abcm/v1"),
  kind: z.literal("ContextConfig"),
  language: projectLanguageTagSchema,
}).passthrough();

export function parseProjectLanguageConfig(source: string): string {
  return projectContextConfigSchema.parse(parseSafeYaml(source)).language;
}
