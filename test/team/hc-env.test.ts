import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hcLaunchArgv,
  renderHcEnvFile,
  resolveExecutable,
  sweepHcEnvDir,
  writeHcEnvFile,
} from "../../src/team/hc-env.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "omp-hc-env-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tricky = `a'b"c$HOME\`x\`\nline2 \\ end`;

describe("hc env file", () => {
  it("round-trips tricky values through /bin/sh and deletes itself", () => {
    const dir = tmp();
    const file = writeHcEnvFile({
      env: { PATH: process.env.PATH, COPILOT_PROVIDER_API_KEY: tricky, GH_TOKEN: "ghp_secret" },
      extra: { OMP_TEAM_WORKER: "1" },
      dir,
      label: "omp-abc123-w1",
    });
    const printer = path.join(dir, "printer.sh");
    writeFileSync(printer, '#!/bin/sh\nprintf "%s|%s|%s|%s" "$COPILOT_PROVIDER_API_KEY" "$GH_TOKEN" "$OMP_TEAM_WORKER" "${COPILOT_STALE-unset}"\n');
    chmodSync(printer, 0o755);
    const [sh, ...rest] = hcLaunchArgv(file, printer);
    // COPILOT_STALE simulates a var inherited from the hc core's own start.
    const r = spawnSync(sh!, rest, { encoding: "utf8", env: { PATH: "/usr/bin:/bin", COPILOT_STALE: "old", GH_TOKEN: "stale" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${tricky}|ghp_secret|1|unset`);
    expect(existsSync(file)).toBe(false);
  });

  it("unsets fixed keys the caller lacks", () => {
    const body = renderHcEnvFile({ PATH: "/bin" });
    expect(body).toContain("unset GH_TOKEN");
    expect(body).toContain("unset GITHUB_TOKEN");
    expect(body).toContain("PATH='/bin'");
  });

  it("uses 0600 files in a 0700 dir", () => {
    const dir = path.join(tmp(), "hc-env");
    const file = writeHcEnvFile({ env: { PATH: "/bin" }, dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("argv never contains secret values and requires an absolute binary", () => {
    const dir = tmp();
    const file = writeHcEnvFile({ env: { PATH: "/bin", GH_TOKEN: "ghp_topsecret", COPILOT_X: "byok-key" }, dir });
    const argv = hcLaunchArgv(file, "/usr/bin/env", ["--madmax"]);
    expect(argv.join(" ")).not.toContain("ghp_topsecret");
    expect(argv.join(" ")).not.toContain("byok-key");
    expect(argv.slice(-2)).toEqual(["/usr/bin/env", "--madmax"]);
    expect(() => hcLaunchArgv(file, "copilot")).toThrow(/absolute/);
  });

  it("sweeps only env files older than an hour", () => {
    const dir = tmp();
    const old = path.join(dir, "old.env");
    const fresh = path.join(dir, "fresh.env");
    const other = path.join(dir, "keep.txt");
    for (const f of [old, fresh, other]) writeFileSync(f, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    utimesSync(other, twoHoursAgo, twoHoursAgo);
    expect(sweepHcEnvDir(dir)).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["fresh.env", "keep.txt"]);
  });

  it("rejects invalid env keys", () => {
    expect(() => renderHcEnvFile({}, { "BAD KEY": "1" })).toThrow(/invalid env key/);
  });

  it("resolves executables against the caller PATH", () => {
    const dir = tmp();
    const bin = path.join(dir, "omp");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    expect(resolveExecutable("omp", { PATH: `/nonexistent:${dir}` })).toBe(bin);
    expect(resolveExecutable("omp", { PATH: "/nonexistent" })).toBeUndefined();
  });
});
