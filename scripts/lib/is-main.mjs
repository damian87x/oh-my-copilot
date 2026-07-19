import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** True when this module is the directly executed entry point. Symlink-tolerant:
 *  a plugin loaded through a symlinked dir (e.g. a local dev link) keeps the
 *  symlinked path in argv[1] while Node resolves import.meta.url to the real
 *  file — the naive `import.meta.url === pathToFileURL(argv[1]).href` check then
 *  never matches and the hook exits silently with no output. */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  let real = argv1;
  try {
    real = realpathSync(argv1);
  } catch {
    // keep the original path when it can't be resolved
  }
  return metaUrl === pathToFileURL(real).href;
}
