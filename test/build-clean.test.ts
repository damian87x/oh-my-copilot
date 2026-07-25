import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

it("cleans only the repository dist directory before TypeScript builds", async () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts: { build: string };
  };
  expect(packageJson.scripts.build).toBe(
    "node tools/clean-dist.mjs && tsc -p tsconfig.json && node tools/finalize-build.mjs",
  );

  const root = mkdtempSync(join(tmpdir(), "omp-build-clean-"));
  fixtures.push(root);
  mkdirSync(join(root, "dist", "src"), { recursive: true });
  writeFileSync(join(root, "dist", "src", "deleted-source.js"), "stale\n");
  writeFileSync(join(root, "keep.txt"), "keep\n");

  const scriptUrl = pathToFileURL(join(process.cwd(), "tools", "clean-dist.mjs"));
  const { cleanDist } = (await import(scriptUrl.href)) as {
    cleanDist: (repositoryRoot: string) => string;
  };

  expect(cleanDist(root)).toBe(join(root, "dist"));
  expect(existsSync(join(root, "dist"))).toBe(false);
  expect(readFileSync(join(root, "keep.txt"), "utf8")).toBe("keep\n");
});

it("restores executable permissions on the compiled CLI after a clean build", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-build-finalize-"));
  fixtures.push(root);
  const cli = join(root, "dist", "src", "cli.js");
  mkdirSync(join(root, "dist", "src"), { recursive: true });
  writeFileSync(cli, "#!/usr/bin/env node\n");
  chmodSync(cli, 0o644);

  const scriptUrl = pathToFileURL(join(process.cwd(), "tools", "finalize-build.mjs"));
  const { finalizeBuild } = (await import(scriptUrl.href)) as {
    finalizeBuild: (repositoryRoot: string) => string;
  };

  expect(finalizeBuild(root)).toBe(cli);
  expect(statSync(cli).mode & 0o111).toBe(0o111);
});
