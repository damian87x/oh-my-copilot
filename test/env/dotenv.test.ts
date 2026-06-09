import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDotEnv,
  loadOmpEnv,
  OMP_ENV_DIRNAME,
  OMP_ENV_FILENAME,
} from "../../src/env/dotenv.js";

describe("parseDotEnv", () => {
  it("parses KEY=value pairs", () => {
    expect(parseDotEnv("FOO=bar\nBAZ=qux")).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips matching outer single OR double quotes", () => {
    expect(parseDotEnv(`A="hello world"\nB='one two'`)).toEqual({
      A: "hello world",
      B: "one two",
    });
  });

  it("matches the legacy src/jira.ts loadDotEnv quote behavior", () => {
    // Legacy parser strips a leading OR trailing quote independently —
    // we preserve that so existing .env files keep producing the same map.
    expect(parseDotEnv(`A=he"llo\nB="mixed'`)).toEqual({
      A: `he"llo`,
      B: `mixed`,
    });
  });

  it("ignores comment lines and blank lines", () => {
    const text = `\n# top comment\nFOO=1\n\n# mid\nBAR=2\n`;
    expect(parseDotEnv(text)).toEqual({ FOO: "1", BAR: "2" });
  });

  it("trims surrounding whitespace from key and value", () => {
    expect(parseDotEnv("  KEY  =  value  ")).toEqual({ KEY: "value" });
  });

  it("preserves an inner equals sign in the value", () => {
    expect(parseDotEnv("DATA=a=b=c")).toEqual({ DATA: "a=b=c" });
  });

  it("skips lines without `=` and lines with an empty key", () => {
    expect(parseDotEnv("just text\n=lonely-value\nGOOD=ok")).toEqual({ GOOD: "ok" });
  });

  it("emits empty-string value for `KEY=`", () => {
    expect(parseDotEnv("EMPTY=")).toEqual({ EMPTY: "" });
  });

  it("handles CRLF line endings", () => {
    expect(parseDotEnv("FOO=1\r\nBAR=2\r\n")).toEqual({ FOO: "1", BAR: "2" });
  });
});

describe("loadOmpEnv", () => {
  let home: string;
  let logs: string[];
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "omp-env-test-"));
    logs = [];
    env = {};
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeEnvFile(content: string): string {
    const dir = join(home, OMP_ENV_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, OMP_ENV_FILENAME);
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("returns {loaded:0, path:null} when ~/.omp/.env is absent", () => {
    const r = loadOmpEnv({ homeDir: home, processEnv: env, log: (m) => logs.push(m) });
    expect(r).toEqual({ loaded: 0, path: null });
    expect(env).toEqual({});
    expect(logs).toEqual([]);
  });

  it("loads keys from ~/.omp/.env into processEnv and reports the path", () => {
    const path = writeEnvFile("SLACK_BOT_TOKEN=xoxb-x\nSLACK_APP_TOKEN=xapp-y\n");
    const r = loadOmpEnv({ homeDir: home, processEnv: env, log: (m) => logs.push(m) });
    expect(r).toEqual({ loaded: 2, path });
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-x");
    expect(env.SLACK_APP_TOKEN).toBe("xapp-y");
    expect(logs).toEqual([]);
  });

  it("does NOT overwrite values already present in processEnv (shell wins)", () => {
    writeEnvFile("SLACK_BOT_TOKEN=xoxb-from-file\nNEW_KEY=from-file\n");
    env.SLACK_BOT_TOKEN = "xoxb-from-shell";
    const r = loadOmpEnv({ homeDir: home, processEnv: env, log: (m) => logs.push(m) });
    // shell value survives; only NEW_KEY is filled in
    expect(env.SLACK_BOT_TOKEN).toBe("xoxb-from-shell");
    expect(env.NEW_KEY).toBe("from-file");
    expect(r.loaded).toBe(1);
  });

  it("skips empty values in the file (`KEY=`) so they cannot shadow shell exports", () => {
    writeEnvFile("EMPTY=\nFILLED=ok\n");
    const r = loadOmpEnv({ homeDir: home, processEnv: env, log: (m) => logs.push(m) });
    expect(env.EMPTY).toBeUndefined();
    expect(env.FILLED).toBe("ok");
    expect(r.loaded).toBe(1);
  });

  it("never throws on an unreadable file — degrades to loaded:0 + one log line", () => {
    const path = writeEnvFile("FOO=bar\n");
    // Best-effort: make the file unreadable. On some sandboxes chmod may be a
    // no-op for the owning user; treat the test as a smoke check there.
    try {
      chmodSync(path, 0o000);
    } catch {
      /* ignore */
    }
    const r = loadOmpEnv({ homeDir: home, processEnv: env, log: (m) => logs.push(m) });
    expect(r.path).toBe(path);
    expect(r.loaded === 0 || r.loaded === 1).toBe(true);
    if (r.loaded === 0) {
      expect(logs.some((l) => l.includes(path))).toBe(true);
    }
    // restore perms for cleanup
    try {
      chmodSync(path, 0o600);
    } catch {
      /* ignore */
    }
  });
});
