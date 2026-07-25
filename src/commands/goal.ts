import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packageRootFromImportMeta } from "../project.js";

export interface GoalCommandInput {
  root: string;
  command: string;
  sessionId: string;
  operationId?: string;
  expectedGoalGeneration?: string;
  objective?: string;
  reason?: string;
  turnId?: string;
  assistantText?: string;
}

export interface GoalCommandSuccess {
  schemaVersion: 1;
  ok: true;
  result: Record<string, unknown>;
}

export interface GoalCommandFailure {
  schemaVersion: 1;
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export type GoalCommandOutput = GoalCommandSuccess | GoalCommandFailure;

interface GoalRuntimeModule {
  goalCommand(input: GoalCommandInput): Promise<GoalCommandOutput>;
}

async function loadGoalRuntime(importMetaUrl: string): Promise<GoalRuntimeModule> {
  const url = pathToFileURL(
    join(packageRootFromImportMeta(importMetaUrl), "scripts", "lib", "goal-runtime.mjs"),
  ).href;
  return (await import(url)) as GoalRuntimeModule;
}

export async function runGoalCommand(
  input: GoalCommandInput,
  importMetaUrl = import.meta.url,
): Promise<GoalCommandOutput> {
  const runtime = await loadGoalRuntime(importMetaUrl);
  return runtime.goalCommand(input);
}
