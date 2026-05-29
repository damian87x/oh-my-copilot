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

/**
 * A team mailbox message (worker<->worker or worker<->leader).
 * Mailbox files are append-only JSONL; delivery is tracked via separate
 * append-only DeliveryReceipt lines, never by rewriting the message line.
 */
export interface MailboxMessage {
  type: "message"; // discriminator
  id: string; // crypto.randomUUID()
  from: string; // worker name or "leader"
  to: string; // worker name or "leader"
  body: string;
  timestamp: string; // ISO-8601
}

/** Append-only delivery acknowledgement for a MailboxMessage. */
export interface DeliveryReceipt {
  type: "delivery-receipt";
  messageId: string;
  deliveredAt: string; // ISO-8601
}

/** A single line in a mailbox JSONL file. */
export type MailboxLine = MailboxMessage | DeliveryReceipt;

/** Merged view returned by listMailbox: a message with optional delivery info. */
export interface MailboxMessageView extends MailboxMessage {
  deliveredAt?: string;
}
