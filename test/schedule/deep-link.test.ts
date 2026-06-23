import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOpenOmpScript, resolveOpenTarget, writeOpenOmpLauncher } from "../../src/schedule/deep-link.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "omp-deeplink-"));
});
afterEach(() => {
  /* tmp dirs are reaped by the OS */
});

describe("buildOpenOmpScript", () => {
  it("cds into the (single-quoted) cwd and execs the omp bin, guarding with --", () => {
    expect(buildOpenOmpScript("/home/me/proj", "/usr/local/bin/omp")).toBe(
      "#!/bin/sh\ncd -- '/home/me/proj' && exec -- '/usr/local/bin/omp'\n",
    );
  });

  it("escapes embedded single quotes in the cwd (no shell injection)", () => {
    expect(buildOpenOmpScript("/a'b/c", "omp")).toBe("#!/bin/sh\ncd -- '/a'\\''b/c' && exec -- 'omp'\n");
  });

  it("guards dash-leading paths with -- so they are not parsed as options", () => {
    expect(buildOpenOmpScript("-rf/proj", "-omp")).toBe("#!/bin/sh\ncd -- '-rf/proj' && exec -- '-omp'\n");
  });
});

describe("writeOpenOmpLauncher", () => {
  it("writes an executable (0755) launcher and returns its path", () => {
    const p = writeOpenOmpLauncher(dir, "/proj", "/usr/local/bin/omp");
    expect(p).toBe(path.join(dir, "open-omp.command"));
    expect(readFileSync(p, "utf8")).toContain("cd -- '/proj' && exec -- '/usr/local/bin/omp'");
    expect(statSync(p).mode & 0o777).toBe(0o755);
  });
});

describe("resolveOpenTarget", () => {
  const base = { logDir: "/state/logs/dep", logPath: "/state/logs/dep/2026.log", cwd: "/proj", ompBinPath: "/bin/omp" };

  it("opens the raw log when notifyOpenOmp is off", () => {
    const t = resolveOpenTarget({ ...base, platform: "darwin", notifyOpenOmp: false });
    expect(t).toBe("file:///state/logs/dep/2026.log");
  });

  it("opens the generated launcher on macOS when notifyOpenOmp is on", () => {
    const real = mkdtempSync(path.join(tmpdir(), "omp-deeplink-real-"));
    const t = resolveOpenTarget({ ...base, logDir: real, platform: "darwin", notifyOpenOmp: true });
    expect(t).toBe(`file://${path.join(real, "open-omp.command")}`);
    expect(readFileSync(path.join(real, "open-omp.command"), "utf8")).toContain("exec -- '/bin/omp'");
  });

  it("falls back to the raw log off macOS even when notifyOpenOmp is on", () => {
    const t = resolveOpenTarget({ ...base, platform: "linux", notifyOpenOmp: true });
    expect(t).toBe("file:///state/logs/dep/2026.log");
  });

  it("percent-encodes special characters so the click target is a valid file URL", () => {
    const t = resolveOpenTarget({
      ...base,
      logPath: "/state/logs/dep/has space#1.log",
      platform: "linux",
      notifyOpenOmp: false,
    });
    expect(t).toBe("file:///state/logs/dep/has%20space%231.log");
  });
});
