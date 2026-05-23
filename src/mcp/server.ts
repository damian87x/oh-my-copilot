import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "./types.js";
import { textResult } from "./types.js";

export interface ServerOptions {
  name?: string;
  version?: string;
  tools: ToolDefinition[];
}

export function filterToolsByEnv(tools: ToolDefinition[], envValue = process.env.OMC_DISABLE_TOOLS): ToolDefinition[] {
  if (!envValue) return tools;
  const disabled = new Set(envValue.split(",").map((s) => s.trim()).filter(Boolean));
  if (disabled.size === 0) return tools;
  return tools.filter((t) => !disabled.has(t.category));
}

export function buildMcpServer(options: ServerOptions): Server {
  const server = new Server(
    { name: options.name ?? "oh-my-copilot", version: options.version ?? "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as never,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = options.tools.find((t) => t.name === request.params.name);
    if (!tool) return textResult(`Unknown tool: ${request.params.name}`, true) as never;
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await tool.handler(args);
      return result as never;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(`Error: ${message}`, true) as never;
    }
  });

  return server;
}

export async function runMcpServer(options: ServerOptions): Promise<void> {
  const server = buildMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`MCP server running (${options.tools.length} tools)`);
}
