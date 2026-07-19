import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A plugin loaded through a symlinked dir (local dev link) keeps the symlinked
// path in argv[1] while Node resolves import.meta.url to the real file. The
// entry guard must still fire main() — otherwise the hook exits silently and
// the host sees an empty SessionStart.
const here = path.dirname(fileURLToPath(import.meta.url));
const sessionStart = path.join(here, "..", "..", "scripts", "session-start.mjs");

describe("hook entry guard (is-main)", () => {
  it("runs main when executed through a symlinked script path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "omp-is-main-"));
    const link = path.join(dir, "linked-session-start.mjs");
    symlinkSync(sessionStart, link);
    const cwd = mkdtempSync(path.join(tmpdir(), "omp-is-main-cwd-"));
    const stdout = execFileSync("node", [link], {
      input: JSON.stringify({ sessionId: "t", cwd }),
      env: { ...process.env, OMP_VERSION_OVERRIDE: "999.0.0" },
      encoding: "utf8",
      timeout: 15_000,
    });
    // the guard fired: main() printed its hook output JSON
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it("still runs main when executed by its real path", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "omp-is-main-cwd-"));
    const stdout = execFileSync("node", [sessionStart], {
      input: JSON.stringify({ sessionId: "t", cwd }),
      env: { ...process.env, OMP_VERSION_OVERRIDE: "999.0.0" },
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
