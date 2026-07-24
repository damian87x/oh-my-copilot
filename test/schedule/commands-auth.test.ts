import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the OS installer so no real launchctl/crontab runs, and mock the auth
// pre-flight so the result does not depend on the developer machine's real
// ~/.omp/.env.
vi.mock("../../src/schedule/installer.js", () => ({
  installJob: vi.fn(() => ({ backend: "crontab", installed: true })),
  uninstallJob: vi.fn(),
  getInstalledStatus: vi.fn(() => false),
}));
vi.mock("../../src/schedule/copilot-auth.js", () => ({
  copilotAuthConfigured: vi.fn(() => false),
}));

import { copilotAuthConfigured } from "../../src/schedule/copilot-auth.js";
import { addScheduleJob } from "../../src/schedule/commands.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "omp-sched-auth-"));
  writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  vi.clearAllMocks();
});

describe("addScheduleJob copilot auth warning", () => {
  it("warns when a copilot job has no token in env or ~/.omp/.env", () => {
    vi.mocked(copilotAuthConfigured).mockReturnValue(false);
    const r = addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "x" });
    expect(r.ok).toBe(true);
    expect(r.messages.join(" ")).toMatch(/WARNING.*no keychain access/);
    expect(r.messages.join(" ")).toContain("COPILOT_GITHUB_TOKEN");
    expect(r.messages.join(" ")).toContain("GH_TOKEN");
  });

  it("warns on --dry-run too, before anything is installed", () => {
    vi.mocked(copilotAuthConfigured).mockReturnValue(false);
    const r = addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "x", dryRun: true });
    expect(r.messages.join(" ")).toMatch(/WARNING.*no keychain access/);
  });

  it("does not warn when a token is configured", () => {
    vi.mocked(copilotAuthConfigured).mockReturnValue(true);
    const r = addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "x" });
    expect(r.messages.join(" ")).not.toMatch(/no keychain access/);
  });

  it("does not warn for non-copilot bins", () => {
    vi.mocked(copilotAuthConfigured).mockReturnValue(false);
    const r = addScheduleJob(root, { id: "pr", cron: "*/15 * * * *", prompt: "x", bin: "my-other-agent" });
    expect(r.messages.join(" ")).not.toMatch(/no keychain access/);
    expect(copilotAuthConfigured).not.toHaveBeenCalled();
  });
});
