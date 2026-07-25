import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

export function cleanDist(root) {
  const resolvedRoot = resolve(root);
  const distPath = join(resolvedRoot, "dist");

  if (dirname(distPath) !== resolvedRoot) {
    throw new Error(`Refusing to clean outside repository root: ${distPath}`);
  }

  rmSync(distPath, { recursive: true, force: true });
  return distPath;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  cleanDist(repositoryRoot);
}
