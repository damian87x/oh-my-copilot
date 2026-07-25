import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  openSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

export function finalizeBuild(root) {
  const cliPath = join(resolve(root), "dist", "src", "cli.js");
  const descriptor = openSync(
    cliPath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error(`Compiled CLI is not a regular file: ${cliPath}`);
    }
    fchmodSync(descriptor, stat.mode | 0o111);
  } finally {
    closeSync(descriptor);
  }
  return cliPath;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  finalizeBuild(repositoryRoot);
}
