import { describe, expect, test } from "bun:test";

describe("deployment capability configuration", () => {
  test("enables durable capabilities by default", async () => {
    const compose = await Bun.file("deploy/compose.config.yaml").text();
    expect(compose).toContain("ABCM_DERIVED_STORE_ENABLED: ${ABCM_DERIVED_STORE_ENABLED:-true}");
  });

  test("registers documentation only from an operator-selected read-only directory", async () => {
    const compose = await Bun.file("deploy/compose.obsidian.yaml").text();
    expect(compose).toContain("ABCM_DOCUMENTATION_SOURCE_PATH:?required");
    expect(compose).toContain("target: /documentation-sources/obsidian");
    expect(compose).toContain("read_only: true");
    expect(compose).toContain("ABCM_DOCUMENTATION_SOURCES:");
    expect(compose).not.toContain("${ABCM_WORKSPACE_ROOT}:/documentation-sources");
  });
});
