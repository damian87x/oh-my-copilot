import type { Task } from "./types.js";

export interface InboxOptions {
  teamName: string;
  workerName: string;
  task: Task;
  cwd: string;
}

export function buildInboxMarkdown(opts: InboxOptions): string {
  const claimInput = JSON.stringify({
    team_name: opts.teamName,
    task_id: opts.task.id,
    worker: opts.workerName,
    cwd: opts.cwd,
  });
  const completeInputTemplate = JSON.stringify({
    team_name: opts.teamName,
    task_id: opts.task.id,
    worker: opts.workerName,
    cwd: opts.cwd,
    from: "in_progress",
    to: "completed",
    claim_token: "<claim_token>",
    result: "Summary: ...",
  });
  const failInputTemplate = JSON.stringify({
    team_name: opts.teamName,
    task_id: opts.task.id,
    worker: opts.workerName,
    cwd: opts.cwd,
    from: "in_progress",
    to: "failed",
    claim_token: "<claim_token>",
  });
  return [
    "## REQUIRED: Task Lifecycle Commands",
    "You MUST run these commands. Do NOT skip any step.",
    "",
    "1. Claim your task:",
    `   omp team api claim-task --input '${claimInput}' --json`,
    "   Save the claim_token from the response.",
    "",
    "2. Do the work described below.",
    "",
    "3. On completion (use claim_token from step 1):",
    `   omp team api transition-task-status --input '${completeInputTemplate}' --json`,
    "",
    "4. On failure:",
    `   omp team api transition-task-status --input '${failInputTemplate}' --json`,
    "",
    "## Task Assignment",
    `Task ID: ${opts.task.id}`,
    `Worker: ${opts.workerName}`,
    "",
    "## Description",
    opts.task.description,
    "",
  ].join("\n");
}
