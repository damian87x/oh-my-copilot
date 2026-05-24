import { describe, expect, it } from "vitest";
import { buildMcpServer, filterToolsByEnv } from "../../src/mcp/server.js";
import type { ToolDefinition } from "../../src/mcp/types.js";
import { textResult } from "../../src/mcp/types.js";

const tools: ToolDefinition[] = [
  {
    name: "greet",
    description: "Say hello.",
    category: "demo",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    handler: (args) => textResult(`hello ${args.name}`),
  },
  {
    name: "errorful",
    description: "Always throws.",
    category: "demo",
    inputSchema: { type: "object" },
    handler: () => {
      throw new Error("boom");
    },
  },
];

describe("filterToolsByEnv", () => {
  it("returns all tools when env is unset", () => {
    expect(filterToolsByEnv(tools, undefined)).toHaveLength(2);
  });
  it("filters by category when env lists categories", () => {
    expect(filterToolsByEnv(tools, "demo")).toHaveLength(0);
    expect(filterToolsByEnv(tools, "other")).toHaveLength(2);
  });
});

describe("buildMcpServer", () => {
  it("constructs a server without throwing", () => {
    const server = buildMcpServer({ tools });
    expect(server).toBeDefined();
  });
});
