import type { ToolDefinition } from "../types.js";
import { stateTools } from "./state.js";
import { notepadTools } from "./notepad.js";
import { projectMemoryTools } from "./project-memory.js";
import { dailyLogTools } from "./daily-log.js";
import { sharedMemoryTools } from "./shared-memory.js";
import { traceTools } from "./trace.js";

export const allTools: ToolDefinition[] = [
  ...stateTools,
  ...notepadTools,
  ...projectMemoryTools,
  ...dailyLogTools,
  ...sharedMemoryTools,
  ...traceTools,
];

export { stateTools, notepadTools, projectMemoryTools, dailyLogTools, sharedMemoryTools, traceTools };
export { appendTraceEntry } from "./trace.js";
