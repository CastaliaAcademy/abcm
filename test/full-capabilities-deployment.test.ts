import { describe, expect, test } from "bun:test";

import { parseSafeYaml } from "../src/core/safe-yaml.js";
import { businessEvaluationExecutionProfileSchema } from "../src/evaluation/context-business-eval-profile.js";

describe("full-capabilities deployment", () => {
  test("publishes operator-owned profiles and every conditional MCP contour", async () => {
    const profileFile = parseSafeYaml(await Bun.file("deploy/castalia-public-evaluation-profiles.yaml").text()) as {
      profiles: unknown[];
    };
    const profiles = profileFile.profiles.map(profile => businessEvaluationExecutionProfileSchema.parse(profile));
    expect(profiles.map(profile => profile.phase)).toEqual(["retrieval", "task-success"]);
    expect(profiles.every(profile => profile.workspaceId === "castalia-public")).toBe(true);

    const compose = await Bun.file("deploy/compose.full-capabilities.yaml").text();
    expect(compose).toContain("ABCM_CONTEXT_LINK_GRAPH_STATE_ROOT: /state/link-graph");
    expect(compose).toContain("ABCM_BUSINESS_EVALUATION_PROFILES: /config/business-evaluation-profiles.yaml");
    expect(compose).toContain("ABCM_BUSINESS_EVALUATION_WORKER_TOKEN:");
    expect(compose).toContain("ABCM_BUSINESS_EVALUATION_TASK_STATE_ROOT: /state/task-success");
    expect(compose).toContain("ABCM_DOCUMENTATION_SOURCES:");
    expect(compose).toContain("ABCM_DOCUMENTATION_SOURCE_PATH");
    expect(compose).toContain("read_only: true");
  });
});
