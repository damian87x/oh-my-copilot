export type WorkerRole = "claude" | "codex" | "gemini" | string;

export type TaskStatus = "pending" | "in_progress" | "completed" | "failed";

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  result?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  claimToken?: string;
}

export interface Worker {
  name: string;
  role: WorkerRole;
  paneId?: string;
  taskId?: string;
}

export interface TeamConfig {
  name: string;
  task: string;
  role: WorkerRole;
  workerCount: number;
  tmuxSession: string;
  workers: Worker[];
  cwd: string;
  createdAt: string;
}

export interface Heartbeat {
  pid: number;
  workerName: string;
  teamName: string;
  lastPollAt: string;
  turnCount: number;
  alive: boolean;
}

export interface OutboxMessage {
  type: "task_complete" | "task_failed" | "progress" | string;
  taskId?: string;
  status?: TaskStatus;
  result?: string;
  detail?: string;
  timestamp: string;
}
