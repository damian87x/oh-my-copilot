import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { copilotAuthConfigured, findCopilotAuthToken, validateCopilotToken } from "../../src/schedule/copilot-auth.js";

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

describe("findCopilotAuthToken", () => {
  it("returns the env token value, honoring key precedence", () => {
    expect(findCopilotAuthToken({ GH_TOKEN: "gh-tok" }, homeWithEnvFile(null))).toBe("gh-tok");
    expect(findCopilotAuthToken({ COPILOT_GITHUB_TOKEN: "cp-tok", GH_TOKEN: "gh-tok" }, homeWithEnvFile(null))).toBe(
      "cp-tok",
    );
  });

  it("returns the file token when env has none", () => {
    const home = homeWithEnvFile("GH_TOKEN=ghp_from_file\n");
    expect(findCopilotAuthToken({}, home)).toBe("ghp_from_file");
  });

  it("env wins over the file", () => {
    const home = homeWithEnvFile("GH_TOKEN=from-file\n");
    expect(findCopilotAuthToken({ GH_TOKEN: "from-env" }, home)).toBe("from-env");
  });

  it("undefined when no token is configured anywhere", () => {
    expect(findCopilotAuthToken({}, homeWithEnvFile("UNRELATED=1\n"))).toBeUndefined();
    expect(findCopilotAuthToken({}, homeWithEnvFile(null))).toBeUndefined();
  });
});

describe("validateCopilotToken", () => {
  const fetchWith = (impl: (url: unknown, init?: RequestInit) => Promise<unknown>): typeof fetch =>
    vi.fn(impl) as unknown as typeof fetch;

  it("valid on a 2xx response, sending the bearer token + GitHub accept header", async () => {
    const f = fetchWith(async () => ({ status: 200 }));
    expect(await validateCopilotToken("tok", f)).toBe("valid");
    const [url, init] = vi.mocked(f).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/user");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect((init.headers as Record<string, string>).Accept).toContain("application/vnd.github");
  });

  it("invalid on 401 and 403", async () => {
    expect(await validateCopilotToken("tok", fetchWith(async () => ({ status: 401 })))).toBe("invalid");
    expect(await validateCopilotToken("tok", fetchWith(async () => ({ status: 403 })))).toBe("invalid");
  });

  it("unknown on other statuses and on network failure", async () => {
    expect(await validateCopilotToken("tok", fetchWith(async () => ({ status: 500 })))).toBe("unknown");
    expect(
      await validateCopilotToken(
        "tok",
        fetchWith(async () => {
          throw new Error("offline");
        }),
      ),
    ).toBe("unknown");
  });

  it("unknown when the request times out (abort)", async () => {
    const slow = fetchWith(
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    expect(await validateCopilotToken("tok", slow, 10)).toBe("unknown");
  });
});
