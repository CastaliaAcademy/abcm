import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod/v4";

import { parseSafeYaml } from "../core/safe-yaml.js";
import { businessEvaluationExecutionProfileSchema, type BusinessEvaluationExecutionProfile } from "./context-business-eval-profile.js";

const profileFileSchema = z.union([
  businessEvaluationExecutionProfileSchema,
  z.object({ profiles: z.array(businessEvaluationExecutionProfileSchema).min(1) }).strict(),
]);

export async function loadBusinessEvaluationProfiles(value: string | undefined): Promise<BusinessEvaluationExecutionProfile[] | undefined> {
  if (value === undefined) return undefined;
  const paths = [...new Set(value.split(",").map(path => path.trim()).filter(Boolean))];
  if (paths.length === 0) throw new Error("ABCM_BUSINESS_EVALUATION_PROFILES must contain at least one profile file when configured.");
  const profiles: BusinessEvaluationExecutionProfile[] = [];
  for (const path of paths) {
    const parsed = profileFileSchema.parse(parseSafeYaml(await readFile(resolve(path), "utf8")));
    profiles.push(...("profiles" in parsed ? parsed.profiles : [parsed]));
  }
  const ids = profiles.map(profile => profile.id);
  if (new Set(ids).size !== ids.length) throw new Error("ABCM business evaluation profile ids must be unique across configured files.");
  return profiles;
}
