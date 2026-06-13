import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatVersionInfo, getVersionInfo } from "../../src/copilot/version.js";

function tempProject(version = "9.9.9") {
  const root = mkdtempSync(path.join(tmpdir(), "omc-copilot-version-"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "tmp", version }));
  return root;
}

const originalVersionOverride = process.env.OMP_VERSION_OVERRIDE;

afterEach(() => {
  if (originalVersionOverride === undefined) delete process.env.OMP_VERSION_OVERRIDE;
  else process.env.OMP_VERSION_OVERRIDE = originalVersionOverride;
});

describe("getVersionInfo", () => {
  it("reads the package version from package.json", () => {
    const root = tempProject("4.2.0");
    const info = getVersionInfo({ cwd: root });
    expect(info.package).toBe("4.2.0");
    expect(info.node).toBe(process.version);
    expect(info.platform).toContain(process.platform);
    expect(info.packageRoot).toBe(root);
  });

  it("returns 'unknown' when package.json lacks a version", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omc-copilot-version-no-ver-"));
    writeFileSync(path.join(root, "package.json"), '{"name":"tmp"}');
    const info = getVersionInfo({ cwd: root });
    expect(info.package).toBe("unknown");
  });

  it("prefers OMP_VERSION_OVERRIDE when set", () => {
    process.env.OMP_VERSION_OVERRIDE = "0.0.0-test";
    const root = tempProject("4.2.0");
    const info = getVersionInfo({ cwd: root });
    expect(info.package).toBe("0.0.0-test");
  });
});

describe("formatVersionInfo", () => {
  it("prints a 4-line summary", () => {
    const text = formatVersionInfo({
      package: "1.2.3",
      node: "v22.0.0",
      platform: "darwin-arm64",
      packageRoot: "/tmp/foo",
    });
    expect(text.split("\n")).toHaveLength(4);
    expect(text).toContain("oh-my-copilot 1.2.3");
    expect(text).toContain("node v22.0.0");
    expect(text).toContain("/tmp/foo");
  });
});
