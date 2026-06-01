import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  apiBroadcast,
  apiMailboxList,
  apiMailboxMarkDelivered,
  apiSendMessage,
} from "../../src/team/api.js";
import { resolveTeamPaths, ensureTeamDirs } from "../../src/team/state-paths.js";
import type { TmuxApi, TmuxResult } from "../../src/team/tmux.js";
import type { TeamConfig, Worker } from "../../src/team/types.js";

const okResult: TmuxResult = { stdout: "", stderr: "", status: 0 };

function mockTmux(): TmuxApi & { sendText: ReturnType<typeof vi.fn> } {
  const sendText = vi.fn(() => okResult);
  return {
    sendText,
    newSession: vi.fn(() => okResult),
    splitWindow: vi.fn(() => okResult),
    sendKeys: vi.fn(() => okResult),
    displayMessage: vi.fn(() => okResult),
    // capturePane returns "" so sendToWorker sees payload gone => returns true fast
    capturePane: vi.fn(() => okResult),
    killPane: vi.fn(() => okResult),
    killSession: vi.fn(() => okResult),
    paneDead: vi.fn(() => false),
    sessionExists: vi.fn(() => true),
  } as TmuxApi & { sendText: ReturnType<typeof vi.fn> };
}

function setup(workers: Worker[]): { cwd: string; teamName: string; mailboxDir: string } {
  const cwd = mkdtempSync(path.join(tmpdir(), "omc-msg-"));
  const teamName = "demo";
  const paths = resolveTeamPaths(cwd, teamName);
  ensureTeamDirs(paths);
  const config: TeamConfig = {
    name: teamName,
    task: "t",
    role: "claude",
    workerCount: workers.length,
    tmuxSession: "demo-session",
    workers,
    cwd,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(paths.configFile, JSON.stringify(config), "utf8");
  return { cwd, teamName, mailboxDir: paths.mailboxDir };
}

describe("apiSendMessage", () => {
  it("sends to a registered worker and persists in its mailbox", async () => {
    const { cwd, teamName, mailboxDir } = setup([{ name: "worker-1", role: "claude" }, { name: "worker-2", role: "claude" }]);
    const result = await apiSendMessage({ team_name: teamName, from: "worker-1", to: "worker-2", body: "hi", cwd }, mockTmux());
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(mailboxDir, "worker-2.jsonl"))).toBe(true);
  });

  it("sends to leader successfully", async () => {
    const { cwd, teamName, mailboxDir } = setup([{ name: "worker-1", role: "claude" }]);
    const result = await apiSendMessage({ team_name: teamName, from: "worker-1", to: "leader", body: "hi", cwd }, mockTmux());
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(mailboxDir, "leader.jsonl"))).toBe(true);
  });

  it("rejects unknown recipient with unknown_recipient and creates no file", async () => {
    const { cwd, teamName, mailboxDir } = setup([{ name: "worker-1", role: "claude" }]);
    const result = await apiSendMessage({ team_name: teamName, from: "worker-1", to: "ghost", body: "hi", cwd }, mockTmux());
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unknown_recipient");
    expect(existsSync(path.join(mailboxDir, "ghost.jsonl"))).toBe(false);
  });

  it("rejects path-traversal recipients with invalid_recipient_name and creates no file", async () => {
    const { cwd, teamName, mailboxDir } = setup([{ name: "worker-1", role: "claude" }]);
    for (const to of ["../escape", "worker-1/../../etc", ".", ".."]) {
      const result = await apiSendMessage({ team_name: teamName, from: "worker-1", to, body: "x", cwd }, mockTmux());
      expect(result.ok).toBe(false);
      expect(result.error).toBe("invalid_recipient_name");
    }
    expect(existsSync(path.join(mailboxDir, "..", "escape.jsonl"))).toBe(false);
  });

  it("nudges the recipient worker pane via sendToWorker", async () => {
    const { cwd, teamName } = setup([{ name: "worker-1", role: "claude" }, { name: "worker-2", role: "claude", paneId: "%2" }]);
    const tmux = mockTmux();
    const result = await apiSendMessage({ team_name: teamName, from: "worker-1", to: "worker-2", body: "hi", cwd }, tmux);
    expect(result.nudged).toBe(true);
    expect(tmux.sendText).toHaveBeenCalled();
    expect(tmux.sendText.mock.calls[0]?.[0]).toBe("%2");
  });

  it("does NOT nudge when sending to leader", async () => {
    const { cwd, teamName } = setup([{ name: "worker-1", role: "claude", paneId: "%1" }]);
    const tmux = mockTmux();
    const result = await apiSendMessage({ team_name: teamName, from: "worker-1", to: "leader", body: "hi", cwd }, tmux);
    expect(result.nudged).toBe(false);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("succeeds without a pane (worker not spawned) and reports nudged:false", async () => {
    const { cwd, teamName } = setup([{ name: "worker-1", role: "claude" }, { name: "worker-2", role: "claude" }]);
    const tmux = mockTmux();
    const result = await apiSendMessage({ team_name: teamName, from: "worker-1", to: "worker-2", body: "hi", cwd }, tmux);
    expect(result.ok).toBe(true);
    expect(result.nudged).toBe(false);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });
});

describe("apiBroadcast", () => {
  it("fans out to all workers (except sender) AND leader", async () => {
    const { cwd, teamName, mailboxDir } = setup([
      { name: "worker-1", role: "claude" },
      { name: "worker-2", role: "claude" },
    ]);
    const result = await apiBroadcast({ team_name: teamName, from: "worker-1", body: "standup", cwd }, mockTmux());
    expect(result.ok).toBe(true);
    expect(result.recipients).toContain("worker-2");
    expect(result.recipients).toContain("leader");
    expect(result.recipients).not.toContain("worker-1");
    expect(existsSync(path.join(mailboxDir, "worker-2.jsonl"))).toBe(true);
    expect(existsSync(path.join(mailboxDir, "leader.jsonl"))).toBe(true);
    expect(existsSync(path.join(mailboxDir, "worker-1.jsonl"))).toBe(false);
  });

  it("excludes the sender even when sender is leader", async () => {
    const { cwd, teamName, mailboxDir } = setup([
      { name: "worker-1", role: "claude" },
      { name: "worker-2", role: "claude" },
    ]);
    const result = await apiBroadcast({ team_name: teamName, from: "leader", body: "all hands", cwd }, mockTmux());
    expect(result.recipients).toEqual(expect.arrayContaining(["worker-1", "worker-2"]));
    expect(result.recipients).not.toContain("leader");
    expect(existsSync(path.join(mailboxDir, "leader.jsonl"))).toBe(false);
  });
});

describe("apiMailboxList / apiMailboxMarkDelivered", () => {
  it("lists messages with merged deliveredAt and supports undelivered_only", async () => {
    const { cwd, teamName } = setup([{ name: "worker-1", role: "claude" }, { name: "worker-2", role: "claude" }]);
    const m1 = await apiSendMessage({ team_name: teamName, from: "worker-1", to: "worker-2", body: "a", cwd }, mockTmux());
    await apiSendMessage({ team_name: teamName, from: "worker-1", to: "worker-2", body: "b", cwd }, mockTmux());

    const mark = apiMailboxMarkDelivered({ team_name: teamName, worker: "worker-2", message_id: m1.messageId!, cwd });
    expect(mark.ok).toBe(true);

    const all = apiMailboxList({ team_name: teamName, worker: "worker-2", cwd });
    expect(all.messages).toHaveLength(2);
    expect(all.messages.find((m) => m.id === m1.messageId)?.deliveredAt).toBeTruthy();

    const undelivered = apiMailboxList({ team_name: teamName, worker: "worker-2", undelivered_only: true, cwd });
    expect(undelivered.messages).toHaveLength(1);
  });

  it("mark-delivered returns message_not_found for unknown id", async () => {
    const { cwd, teamName } = setup([{ name: "worker-1", role: "claude" }]);
    const result = apiMailboxMarkDelivered({ team_name: teamName, worker: "worker-1", message_id: "nope", cwd });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("message_not_found");
  });
});
