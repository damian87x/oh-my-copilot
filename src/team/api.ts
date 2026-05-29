import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveTeamPaths, resolveWorkerPaths } from "./state-paths.js";
import { tryClaimTask, transitionTask, type ClaimResult, type TransitionResult } from "./task-store.js";
import { writeHeartbeat } from "./heartbeat.js";
import { appendOutbox } from "./outbox.js";
import { loadTeamConfig } from "./config.js";
import { appendMailbox, listMailbox, markDelivered, validateRecipientName } from "./mailbox.js";
import { makeTmux, sendToWorker, type TmuxApi } from "./tmux.js";
import type { MailboxMessage, MailboxMessageView, TaskStatus } from "./types.js";

/** Reserved recipient name for the team leader. */
const LEADER = "leader";

export interface ClaimInput {
  team_name: string;
  task_id: string;
  worker: string;
  cwd?: string;
}

export function apiClaimTask(input: ClaimInput): ClaimResult {
  const cwd = resolve(input.cwd ?? process.cwd());
  const team = resolveTeamPaths(cwd, input.team_name);
  const worker = resolveWorkerPaths(team, input.worker);
  const result = tryClaimTask({ tasksDir: team.tasksDir, taskId: input.task_id, worker: input.worker });
  if (result.ok) {
    writeHeartbeat(worker.heartbeatFile, {
      pid: process.pid,
      workerName: input.worker,
      teamName: input.team_name,
      lastPollAt: new Date().toISOString(),
      turnCount: 1,
      alive: true,
    });
  }
  return result;
}

export interface TransitionInput {
  team_name: string;
  task_id: string;
  worker?: string;
  from: TaskStatus;
  to: TaskStatus;
  claim_token: string;
  result?: string;
  cwd?: string;
}

export function apiTransitionTaskStatus(input: TransitionInput): TransitionResult {
  const cwd = resolve(input.cwd ?? process.cwd());
  const team = resolveTeamPaths(cwd, input.team_name);
  const transition = transitionTask({
    tasksDir: team.tasksDir,
    taskId: input.task_id,
    from: input.from,
    to: input.to,
    claimToken: input.claim_token,
    result: input.result,
  });
  if (transition.ok && input.worker) {
    const worker = resolveWorkerPaths(team, input.worker);
    const messageType =
      input.to === "completed" ? "task_complete" : input.to === "failed" ? "task_failed" : "progress";
    appendOutbox(worker.outboxFile, {
      type: messageType,
      taskId: input.task_id,
      status: input.to,
      result: input.result,
      timestamp: new Date().toISOString(),
    });
    writeHeartbeat(worker.heartbeatFile, {
      pid: process.pid,
      workerName: input.worker,
      teamName: input.team_name,
      lastPollAt: new Date().toISOString(),
      turnCount: 2,
      alive: input.to === "in_progress",
    });
  }
  return transition;
}

// ---------------------------------------------------------------------------
// Messaging (worker<->worker, worker<->leader) — file-based, no MCP
// ---------------------------------------------------------------------------

export interface SendMessageInput {
  team_name: string;
  from: string;
  to: string;
  body: string;
  cwd?: string;
}

export interface SendMessageResult {
  ok: boolean;
  messageId?: string;
  nudged?: boolean;
  error?: string;
}

/**
 * Send a message to the leader or any registered worker. Rejects path-traversal
 * and unknown recipients before any file I/O. Best-effort nudges the recipient
 * worker's tmux pane (never the leader — it has no tracked pane).
 */
export async function apiSendMessage(input: SendMessageInput, tmux?: TmuxApi): Promise<SendMessageResult> {
  const cwd = resolve(input.cwd ?? process.cwd());

  // Path-traversal guard BEFORE config lookup — hard gate regardless of config.
  if (!validateRecipientName(input.to)) {
    return { ok: false, error: "invalid_recipient_name" };
  }
  if (!input.from || !input.body) {
    return { ok: false, error: "invalid_input" };
  }

  const team = resolveTeamPaths(cwd, input.team_name);
  const config = loadTeamConfig(team);

  const isLeader = input.to === LEADER;
  const recipient = config?.workers.find((w) => w.name === input.to);
  if (!isLeader && !recipient) {
    return { ok: false, error: "unknown_recipient" };
  }

  const message: MailboxMessage = {
    type: "message",
    id: randomUUID(),
    from: input.from,
    to: input.to,
    body: input.body,
    timestamp: new Date().toISOString(),
  };
  appendMailbox(team.mailboxDir, message);

  // Best-effort nudge: only workers have a tracked pane; never nudge the leader.
  let nudged = false;
  const paneId = recipient?.paneId;
  if (!isLeader && paneId) {
    const undelivered = listMailbox(team.mailboxDir, input.to).filter((m) => !m.deliveredAt).length;
    const trigger = `You have ${undelivered} new message(s). Read your mailbox: omp team api mailbox-list --input '{"team_name":"${input.team_name}","worker":"${input.to}"}' --json`;
    try {
      const api = tmux ?? makeTmux();
      nudged = await sendToWorker(api, paneId, trigger, { rounds: 4, delayMs: 100 });
    } catch {
      nudged = false; // nudge is best-effort; persistence already succeeded
    }
  }

  return { ok: true, messageId: message.id, nudged };
}

export interface BroadcastInput {
  team_name: string;
  from: string;
  body: string;
  cwd?: string;
}

export interface BroadcastResult {
  ok: boolean;
  recipients: string[];
  messageIds: string[];
  errors?: string[];
}

/** Broadcast to every worker (except the sender) AND the leader. */
export async function apiBroadcast(input: BroadcastInput, tmux?: TmuxApi): Promise<BroadcastResult> {
  const cwd = resolve(input.cwd ?? process.cwd());
  const team = resolveTeamPaths(cwd, input.team_name);
  const config = loadTeamConfig(team);

  const recipientNames = [
    ...(config?.workers.map((w) => w.name) ?? []),
    LEADER,
  ].filter((name) => name !== input.from);

  const recipients: string[] = [];
  const messageIds: string[] = [];
  const errors: string[] = [];

  for (const to of recipientNames) {
    const result = await apiSendMessage({ team_name: input.team_name, from: input.from, to, body: input.body, cwd }, tmux);
    if (result.ok && result.messageId) {
      recipients.push(to);
      messageIds.push(result.messageId);
    } else {
      errors.push(`${to}: ${result.error ?? "unknown_error"}`);
    }
  }

  return errors.length > 0
    ? { ok: true, recipients, messageIds, errors }
    : { ok: true, recipients, messageIds };
}

export interface MailboxListInput {
  team_name: string;
  worker: string;
  undelivered_only?: boolean;
  cwd?: string;
}

export interface MailboxListResult {
  ok: boolean;
  messages: MailboxMessageView[];
  error?: string;
}

/** List a recipient's mailbox (merged with delivery receipts). */
export function apiMailboxList(input: MailboxListInput): MailboxListResult {
  const cwd = resolve(input.cwd ?? process.cwd());
  if (!validateRecipientName(input.worker)) {
    return { ok: false, messages: [], error: "invalid_recipient_name" };
  }
  const team = resolveTeamPaths(cwd, input.team_name);
  let messages = listMailbox(team.mailboxDir, input.worker);
  if (input.undelivered_only) {
    messages = messages.filter((m) => !m.deliveredAt);
  }
  return { ok: true, messages };
}

export interface MailboxMarkDeliveredInput {
  team_name: string;
  worker: string;
  message_id: string;
  cwd?: string;
}

export interface MailboxMarkDeliveredResult {
  ok: boolean;
  error?: string;
}

/** Mark a mailbox message delivered (appends a delivery receipt). */
export function apiMailboxMarkDelivered(input: MailboxMarkDeliveredInput): MailboxMarkDeliveredResult {
  const cwd = resolve(input.cwd ?? process.cwd());
  if (!validateRecipientName(input.worker)) {
    return { ok: false, error: "invalid_recipient_name" };
  }
  const team = resolveTeamPaths(cwd, input.team_name);
  const ok = markDelivered(team.mailboxDir, input.worker, input.message_id);
  return ok ? { ok: true } : { ok: false, error: "message_not_found" };
}
