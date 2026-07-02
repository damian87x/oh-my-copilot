import { describe, expect, it, vi, beforeEach } from "vitest";

// Capture the args the review subprocess is launched with, without spawning a
// real process. Locks in the security invariant: the reviewer reads untrusted
// transcript text, so it must NEVER run with tools.
const spawnMock = vi.fn(() => ({
  stdout: { on: () => {} },
  stderr: { on: () => {} },
  on: (event: string, cb: (code?: number) => void) => {
    if (event === "close") setTimeout(() => cb(0), 0);
  },
  kill: () => {},
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

beforeEach(() => {
  spawnMock.mockClear();
});

describe("createReviewSpawn", () => {
  it("launches copilot WITHOUT --allow-all-tools (no tool access for the reviewer)", async () => {
    const { createReviewSpawn } = await import("../../src/memory-review/spawn.js");
    const spawn = createReviewSpawn("copilot");
    await spawn({ model: "cheap", prompt: "review this", timeoutMs: 1000 });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).not.toContain("--allow-all-tools");
    expect(args).toContain("--model");
    expect(args).toContain("cheap");
    expect(args).toContain("-p");
  });

  it("disables memory-mode in the reviewer env (its own session must never trigger a review of itself)", async () => {
    const { createReviewSpawn } = await import("../../src/memory-review/spawn.js");
    const spawn = createReviewSpawn("copilot");
    await spawn({ model: "cheap", prompt: "review this", timeoutMs: 1000 });

    const options = spawnMock.mock.calls[0][2] as { env?: Record<string, string> };
    expect(options.env?.OMP_MEMORY_MODE).toBe("off");
  });
});
