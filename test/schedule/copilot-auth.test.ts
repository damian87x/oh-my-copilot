import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copilotAuthConfigured } from "../../src/schedule/copilot-auth.js";

function homeWithEnvFile(content: string | null): string {
  const home = mkdtempSync(path.join(tmpdir(), "omp-auth-home-"));
  if (content !== null) {
    mkdirSync(path.join(home, ".omp"), { recursive: true });
    writeFileSync(path.join(home, ".omp", ".env"), content, "utf8");
  }
  return home;
}

describe("copilotAuthConfigured", () => {
  it("true when a token is in the process env (no file needed)", () => {
    expect(copilotAuthConfigured({ GH_TOKEN: "x" }, homeWithEnvFile(null))).toBe(true);
    expect(copilotAuthConfigured({ COPILOT_GITHUB_TOKEN: "x" }, homeWithEnvFile(null))).toBe(true);
    expect(copilotAuthConfigured({ GITHUB_TOKEN: "x" }, homeWithEnvFile(null))).toBe(true);
  });

  it("true when a token is only in ~/.omp/.env (works with OMP_SKIP_USER_ENV callers)", () => {
    const home = homeWithEnvFile("# comment\nGH_TOKEN=ghp_abc\nOTHER=1\n");
    expect(copilotAuthConfigured({}, home)).toBe(true);
  });

  it("ignores empty token values in the file", () => {
    const home = homeWithEnvFile("GH_TOKEN=\n");
    expect(copilotAuthConfigured({}, home)).toBe(false);
  });

  it("false when neither env nor file has a token (and when the file is missing)", () => {
    expect(copilotAuthConfigured({}, homeWithEnvFile("UNRELATED=1\n"))).toBe(false);
    expect(copilotAuthConfigured({}, homeWithEnvFile(null))).toBe(false);
  });
});
