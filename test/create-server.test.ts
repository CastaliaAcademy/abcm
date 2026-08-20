import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import {
  ABCM_SERVER_INFO,
  ABCM_AGENT_INSTRUCTIONS_VERSION,
  ABCM_MCP_CONTRACT_VERSION,
  ABCM_SPEC_VERSION,
  ABCM_MCP_TOOL_SCHEMAS,
  createAbcmMcpServer,
} from "../src/index.js";

describe("ABCM MCP server library", () => {
  test("exposes stable package and specification metadata", () => {
    expect(ABCM_SERVER_INFO).toEqual({
      name: "abcm-mcp-server",
      version: "0.1.3",
    });
    expect(ABCM_AGENT_INSTRUCTIONS_VERSION).toBe("1.20.0");
    expect(ABCM_MCP_CONTRACT_VERSION).toBe("0.8.0");
    expect(ABCM_SPEC_VERSION).toBe("0.5.0");
    expect(Object.keys(ABCM_MCP_TOOL_SCHEMAS)).toHaveLength(34);
  });

  test("creates an unconnected MCP server", () => {
    expect(createAbcmMcpServer()).toBeInstanceOf(McpServer);
  });
});
