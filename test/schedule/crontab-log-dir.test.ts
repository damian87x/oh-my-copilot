import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// execSync is used only for crontab -l / crontab -; keep installs hermetic.
vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string) => {
    if (String(cmd).includes("crontab -l")) return "";
    return "";
  }),
}));

import { installCrontab } from "../../src/schedule/installers/crontab.js";
import type { ScheduleJob } from "../../src/schedule/types.js";

function job(): ScheduleJob {
  return {
    id: "fresh",
    cron: "0 0 * * *",
    prompt: "x",
    bin: "copilot",
    cwd: "/tmp",
    timeoutMs: 1000,
    allowAllTools: false,
    createdAt: new Date(0).toISOString(),
    runCount: 0,
    backend: "crontab",
    ompBinPath: "/bin/true",
    active: true,
  };
}

describe("installCrontab log dir", () => {
  let root: string;
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates logs/<id> so the first cron tick's >> redirect has a parent dir", () => {
    root = mkdtempSync(join(tmpdir(), "omp-cron-log-"));
    const logsDir = join(root, "logs");
    mkdirSync(logsDir); // parent only — mirrors ensureScheduleDirs
    expect(existsSync(join(logsDir, "fresh"))).toBe(false);

    installCrontab(job(), logsDir, root);

    expect(existsSync(join(logsDir, "fresh"))).toBe(true);
  });
});
