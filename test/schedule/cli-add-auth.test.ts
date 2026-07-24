import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the OS installer so no real launchctl/crontab runs, and mock the auth
// module so neither the developer machine's ~/.omp/.env nor the network is
// touched. Keep the real constants/parsers via importActual.
vi.mock("../../src/schedule/installer.js", () => ({
  installJob: vi.fn(() => ({ backend: "crontab", installed: true })),
  uninstallJob: vi.fn(),
  getInstalledStatus: vi.fn(() => false),
}));
vi.mock("../../src/schedule/copilot-auth.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/schedule/copilot-auth.js")>()),
  copilotAuthConfigured: vi.fn(() => true),
  findCopilotAuthToken: vi.fn(() => "tok"),
  validateCopilotToken: vi.fn(async () => "valid" as const),
}));

import { runCli } from "../../src/cli.js";
import { findCopilotAuthToken, validateCopilotToken } from "../../src/schedule/copilot-auth.js";

let root: string;
const savedSkipUserEnv = process.env.OMP_SKIP_USER_ENV;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omp-cli-add-auth-"));
  // test/setup.ts sets this globally (hermetic suite); the live validation is
  // skipped under the flag, so these tests must lift it explicitly.
  delete process.env.OMP_SKIP_USER_ENV;
  vi.clearAllMocks();
  vi.mocked(findCopilotAuthToken).mockReturnValue("tok");
  vi.mocked(validateCopilotToken).mockResolvedValue("valid");
});

afterEach(() => {
  if (savedSkipUserEnv === undefined) delete process.env.OMP_SKIP_USER_ENV;
  else process.env.OMP_SKIP_USER_ENV = savedSkipUserEnv;
  rmSync(root, { recursive: true, force: true });
});

const addArgs = (...extra: string[]) => [
  "schedule",
  "add",
  "--id",
  "pr",
  "--cron",
  "*/15 * * * *",
  "--prompt",
  "check PR",
  "--root",
  root,
  ...extra,
];

describe("schedule add: live token validity check", () => {
  it("warns that re-auth is needed when the stored token is invalid/expired", async () => {
    vi.mocked(validateCopilotToken).mockResolvedValue("invalid");
    const r = await runCli(addArgs());
    expect(r.ok).toBe(true);
    expect(r.message ?? "").toMatch(/WARNING.*invalid or expired/);
    expect(r.message ?? "").toContain("gh auth login");
  });

  it("invalid warning rides inside --json output.messages (JSON stays well-formed)", async () => {
    vi.mocked(validateCopilotToken).mockResolvedValue("invalid");
    const r = await runCli(addArgs("--json"));
    expect(r.ok).toBe(true);
    expect(r.message).toBeUndefined(); // json mode: no prose message
    const out = r.output as { messages: string[] };
    expect(out.messages.join(" ")).toMatch(/invalid or expired/);
  });

  it("stays silent when the token is valid", async () => {
    const r = await runCli(addArgs());
    expect(r.ok).toBe(true);
    expect(r.message ?? "").not.toMatch(/invalid or expired/);
  });

  it("stays silent when the verdict is unknown (offline/timeout)", async () => {
    vi.mocked(validateCopilotToken).mockResolvedValue("unknown");
    const r = await runCli(addArgs());
    expect(r.ok).toBe(true);
    expect(r.message ?? "").not.toMatch(/invalid or expired/);
  });

  it("skips the live check when no token is configured", async () => {
    vi.mocked(findCopilotAuthToken).mockReturnValue(undefined);
    const r = await runCli(addArgs());
    expect(r.ok).toBe(true);
    expect(validateCopilotToken).not.toHaveBeenCalled();
    expect(r.message ?? "").not.toMatch(/invalid or expired/);
  });

  it("skips the live check for non-copilot bins", async () => {
    const r = await runCli(addArgs("--bin", "my-other-agent"));
    expect(r.ok).toBe(true);
    expect(validateCopilotToken).not.toHaveBeenCalled();
  });

  it("skips the live check on --dry-run", async () => {
    const r = await runCli(addArgs("--dry-run"));
    expect(r.ok).toBe(true);
    expect(validateCopilotToken).not.toHaveBeenCalled();
  });

  it("skips the live check under OMP_SKIP_USER_ENV (hermetic runs)", async () => {
    process.env.OMP_SKIP_USER_ENV = "1";
    const r = await runCli(addArgs());
    expect(r.ok).toBe(true);
    expect(validateCopilotToken).not.toHaveBeenCalled();
  });
});
