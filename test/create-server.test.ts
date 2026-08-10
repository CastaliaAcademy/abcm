import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import {
  ABCM_SERVER_INFO,
  ABCM_SPEC_VERSION,
  createAbcmMcpServer,
} from "../src/index.js";

describe("ABCM MCP server library", () => {
  test("exposes stable package and specification metadata", () => {
    expect(ABCM_SERVER_INFO).toEqual({
      name: "abcm-mcp-server",
      version: "0.1.0-alpha.1",
    });
    expect(ABCM_SPEC_VERSION).toBe("0.5.0");
  });

  test("creates an unconnected MCP server", () => {
    expect(createAbcmMcpServer()).toBeInstanceOf(McpServer);
  });
});
