import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2000;
const PACKAGE_NAME = "@damian87/omp";
const VERSION_OVERRIDE_ENV = "OMP_VERSION_OVERRIDE";

export function isNewer(latest, current) {
  if (!latest || !current) return false;
  const [a = 0, b = 0, c = 0] = String(latest).split(".").map((n) => Number.parseInt(n, 10));
  const [x = 0, y = 0, z = 0] = String(current).split(".").map((n) => Number.parseInt(n, 10));
  if ([a, b, c, x, y, z].some(Number.isNaN)) return false;
  if (a !== x) return a > x;
  if (b !== y) return b > y;
  return c > z;
}

export function formatUpdateNotice(current, latest) {
  return `[OMP UPDATE AVAILABLE]\n\nA new version of ${PACKAGE_NAME} is available: v${latest} (current: v${current})\nTo update, run: npm i -g ${PACKAGE_NAME}@latest`;
}

export function readCurrentVersion() {
  const overriddenVersion = process.env[VERSION_OVERRIDE_ENV]?.trim();
  if (overriddenVersion) return overriddenVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

async function fetchLatestVersion() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.version === "string" ? data.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkForUpdate({ stateDir, now = Date.now(), fetchLatest = fetchLatestVersion } = {}) {
  const current = readCurrentVersion();
  if (!current || !stateDir) return null;

  const cachePath = join(stateDir, "version-check.json");
  let latest = null;

  if (existsSync(cachePath)) {
    try {
      const cache = JSON.parse(readFileSync(cachePath, "utf8"));
      if (cache?.checkedAt && now - cache.checkedAt < CACHE_TTL_MS && typeof cache.latest === "string") {
        latest = cache.latest;
      }
    } catch {
      // ignore corrupt cache
    }
  }

  if (!latest) {
    latest = await fetchLatest();
    if (latest) {
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ checkedAt: now, latest }));
      } catch {
        // best-effort cache write
      }
    }
  }

  if (!latest || !isNewer(latest, current)) return null;
  return { current, latest };
}
