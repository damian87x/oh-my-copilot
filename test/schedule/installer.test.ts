import { describe, expect, it, vi } from "vitest";
import type { ScheduleJob } from "../../src/schedule/types.js";

// Mock only the side-effecting install/uninstall/status fns; keep the pure
// helpers (cron translation, template generation) real via importActual.
vi.mock("../../src/schedule/installers/launchd.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/schedule/installers/launchd.js")>()),
  installLaunchd: vi.fn(),
  uninstallLaunchd: vi.fn(),
  statusLaunchd: vi.fn(),
}));
vi.mock("../../src/schedule/installers/systemd.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/schedule/installers/systemd.js")>()),
  installSystemd: vi.fn(),
  uninstallSystemd: vi.fn(),
  statusSystemd: vi.fn(),
}));
vi.mock("../../src/schedule/installers/crontab.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/schedule/installers/crontab.js")>()),
  installCrontab: vi.fn(() => "crontab"),
  uninstallCrontab: vi.fn(),
  statusCrontab: vi.fn(),
}));

import { applyCrontabBlock, crontabEntryLine, hasCrontabEntry, removeCrontabEntry } from "../../src/schedule/installers/crontab.js";
import { cronToLaunchdInterval, generatePlist } from "../../src/schedule/installers/launchd.js";
import { cronToSystemdCalendar, generateService, generateTimer } from "../../src/schedule/installers/systemd.js";
import { detectOsBackend, installJob } from "../../src/schedule/installer.js";

function job(overrides: Partial<ScheduleJob> = {}): ScheduleJob {
  return {
    id: "pr",
    cron: "*/15 * * * *",
    prompt: "check PR",
    bin: "copilot",
    cwd: "/work/proj",
    timeoutMs: 300_000,
    allowAllTools: false,
    createdAt: "2026-06-01T00:00:00.000Z",
    runCount: 0,
    backend: "crontab",
    ompBinPath: "/usr/local/bin/omp",
    active: true,
    ...overrides,
  };
}

describe("cron translation", () => {
  it("launchd: */15 * * * * -> startInterval 900", () => {
    expect(cronToLaunchdInterval("*/15 * * * *")).toEqual({ startInterval: 900 });
  });
  it("launchd: 0 9 * * * -> daily calendar interval", () => {
    expect(cronToLaunchdInterval("0 9 * * *")).toEqual({ startCalendarInterval: { Minute: 0, Hour: 9 } });
  });
  it("launchd: complex 0 9,12 * * 1-5 -> null (fallback)", () => {
    expect(cronToLaunchdInterval("0 9,12 * * 1-5")).toBeNull();
  });
  it("systemd: */15 * * * * -> *:0/15", () => {
    expect(cronToSystemdCalendar("*/15 * * * *")).toBe("*:0/15");
  });
});

describe("template generation", () => {
  it("plist has ProgramArguments with omp bin + schedule run + --root, and NO KeepAlive", () => {
    const xml = generatePlist(job(), { startInterval: 900 }, "/work/proj/.omp/state/schedule/logs", "/work/proj");
    expect(xml).toContain("<string>/usr/local/bin/omp</string>");
    expect(xml).toContain("<string>schedule</string>");
    expect(xml).toContain("<string>--id</string>");
    expect(xml).toContain("<string>--root</string>");
    expect(xml).toContain("<integer>900</integer>");
    expect(xml).not.toContain("KeepAlive");
  });
  it("plist XML-escapes interpolated paths", () => {
    const xml = generatePlist(job({ ompBinPath: "/x & y/omp" }), { startInterval: 900 }, "/logs", "/state");
    expect(xml).toContain("/x &amp; y/omp");
    expect(xml).not.toContain("/x & y/omp");
  });
  it("systemd service/timer contain quoted ExecStart with --root and OnCalendar", () => {
    const svc = generateService(job(), "/work/state");
    expect(svc).toContain('ExecStart="/usr/local/bin/omp" schedule run --id pr --root "/work/state"');
    expect(generateTimer(job())).toContain("OnCalendar=*:0/15");
  });
  it("systemd OnCalendar keeps the day-of-week constraint", () => {
    expect(cronToSystemdCalendar("0 9 * * 1")).toBe("Mon *-*-* 09:00:00");
    expect(cronToSystemdCalendar("30 8 * * 1-5")).toBe("Mon..Fri *-*-* 08:30:00");
  });
  it("crontab entry shell-quotes paths and passes --root", () => {
    const line = crontabEntryLine(job({ cwd: "/a b/proj" }), "/logs", "/a b/state");
    expect(line).toContain("--root '/a b/state'");
    expect(line).toContain("'/usr/local/bin/omp' schedule run --id pr");
  });
});

describe("crontab managed block", () => {
  it("adds, replaces, and removes entries by id", () => {
    let ct = "MAILTO=me\n";
    ct = applyCrontabBlock(ct, "a", "*/15 * * * * echo a");
    ct = applyCrontabBlock(ct, "b", "0 9 * * * echo b");
    expect(hasCrontabEntry(ct, "a")).toBe(true);
    expect(hasCrontabEntry(ct, "b")).toBe(true);
    expect(ct).toContain("MAILTO=me"); // preserves outside content
    // replace a
    ct = applyCrontabBlock(ct, "a", "*/30 * * * * echo a2");
    expect(ct).toContain("echo a2");
    expect(ct).not.toContain("echo a\n");
    // remove b
    ct = removeCrontabEntry(ct, "b");
    expect(hasCrontabEntry(ct, "b")).toBe(false);
    expect(hasCrontabEntry(ct, "a")).toBe(true);
    // remove last -> block markers gone
    ct = removeCrontabEntry(ct, "a");
    expect(ct).not.toContain("# BEGIN omp-schedule");
    expect(ct).toContain("MAILTO=me");
  });
});

describe("installJob backend selection", () => {
  it("detectOsBackend honors injected platform/systemctl", () => {
    expect(detectOsBackend({ platform: "darwin" })).toBe("launchd");
    expect(detectOsBackend({ platform: "linux", hasSystemctl: true })).toBe("systemd");
    expect(detectOsBackend({ platform: "linux", hasSystemctl: false })).toBe("crontab");
  });
  it("launchd simple cron installs launchd", () => {
    const r = installJob(job({ cron: "*/15 * * * *" }), "/logs", "/state", { platform: "darwin" });
    expect(r.backend).toBe("launchd");
  });
  it("launchd + complex cron falls back to crontab", () => {
    const r = installJob(job({ cron: "0 9,12 * * 1-5" }), "/logs", "/state", { platform: "darwin" });
    expect(r.backend).toBe("crontab");
  });
});
