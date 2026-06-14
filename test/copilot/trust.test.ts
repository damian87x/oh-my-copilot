import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFolderTrusted } from "../../src/copilot/trust.js";

describe("ensureFolderTrusted", () => {
  let dir: string;
  let configPath: string;
  const savedDisable = process.env.OMP_NO_AUTO_TRUST;

  beforeEach(() => {
    delete process.env.OMP_NO_AUTO_TRUST;
    dir = mkdtempSync(join(tmpdir(), "omp-trust-"));
    configPath = join(dir, "config.json");
  });

  afterEach(() => {
    if (savedDisable === undefined) delete process.env.OMP_NO_AUTO_TRUST;
    else process.env.OMP_NO_AUTO_TRUST = savedDisable;
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds the folder to trustedFolders (JSONC header tolerated)", () => {
    writeFileSync(
      configPath,
      '// managed automatically\n{\n  "trustedFolders": ["/already/here"]\n}\n',
    );
    const res = ensureFolderTrusted("/work/proj", configPath);
    expect(res).toMatchObject({ ok: true, added: true, folder: "/work/proj" });
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.trustedFolders).toEqual(["/already/here", "/work/proj"]);
  });

  it("is idempotent when the folder is already trusted", () => {
    writeFileSync(configPath, '{\n  "trustedFolders": ["/work/proj"]\n}\n');
    const res = ensureFolderTrusted("/work/proj", configPath);
    expect(res).toMatchObject({ ok: true, added: false });
  });

  it("initializes trustedFolders when missing, preserving other keys", () => {
    writeFileSync(configPath, '{\n  "login": "x"\n}\n');
    ensureFolderTrusted("/work/proj", configPath);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    expect(cfg.login).toBe("x");
    expect(cfg.trustedFolders).toEqual(["/work/proj"]);
  });

  it("no-ops (no throw) when the config file is absent", () => {
    const res = ensureFolderTrusted("/work/proj", join(dir, "missing.json"));
    expect(res).toMatchObject({ ok: false, added: false, reason: "no-config" });
  });

  it("respects the OMP_NO_AUTO_TRUST escape hatch", () => {
    writeFileSync(configPath, '{\n  "trustedFolders": []\n}\n');
    process.env.OMP_NO_AUTO_TRUST = "1";
    const res = ensureFolderTrusted("/work/proj", configPath);
    expect(res).toMatchObject({ ok: false, added: false, reason: "disabled" });
  });
});
