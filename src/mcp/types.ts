export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema | { type: string; description?: string; enum?: readonly string[] }>;
  required?: string[];
  description?: string;
  items?: JsonSchema;
  additionalProperties?: boolean;
}

export interface ToolContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  category: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
}

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

export function jsonResult(value: unknown, isError = false): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError };
}
