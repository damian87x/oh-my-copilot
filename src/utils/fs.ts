import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path, { dirname } from "node:path";

const NOFOLLOW_OPEN_FLAG = constants.O_NOFOLLOW ?? 0;
const NONBLOCK_OPEN_FLAG = constants.O_NONBLOCK ?? 0;

export type OpenRegularFileFailureReason =
  | "missing"
  | "exists"
  | "symlink"
  | "symlink-ancestor"
  | "not-regular"
  | "hardlink"
  | "outside-root"
  | "changed"
  | "unavailable";

export interface OpenRegularFileOptions {
  rejectHardlinks?: boolean;
  trustedRoot?: string;
}

export type OpenRegularFileResult =
  | {
      ok: true;
      fd: number;
      stat: ReturnType<typeof fstatSync>;
    }
  | {
      ok: false;
      reason: OpenRegularFileFailureReason;
    };

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error))
    return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

type TrustedRootSnapshot = {
  path: string;
  realPath: string;
  dev: number;
  ino: number;
};

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function inspectTrustedPath(
  filePath: string,
  trustedRoot: string,
  expectedRoot?: TrustedRootSnapshot,
  expectedFile?: ReturnType<typeof fstatSync>,
):
  | { ok: true; root: TrustedRootSnapshot }
  | { ok: false; reason: OpenRegularFileFailureReason } {
  const absoluteRoot = path.resolve(trustedRoot);
  const absoluteFile = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return { ok: false, reason: "outside-root" };
  }

  let rootStat: ReturnType<typeof lstatSync>;
  let realRoot: string;
  try {
    rootStat = lstatSync(absoluteRoot);
    if (rootStat.isSymbolicLink())
      return { ok: false, reason: "symlink-ancestor" };
    if (!rootStat.isDirectory())
      return { ok: false, reason: "unavailable" };
    realRoot = realpathSync(absoluteRoot);
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  const root: TrustedRootSnapshot = {
    path: absoluteRoot,
    realPath: realRoot,
    dev: rootStat.dev,
    ino: rootStat.ino,
  };
  if (
    expectedRoot &&
    (expectedRoot.path !== root.path ||
      expectedRoot.realPath !== root.realPath ||
      expectedRoot.dev !== root.dev ||
      expectedRoot.ino !== root.ino)
  ) {
    return { ok: false, reason: "changed" };
  }

  let current = absoluteRoot;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const leaf = index === segments.length - 1;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (leaf && !expectedFile && errorCode(error) === "ENOENT")
        return { ok: true, root };
      return { ok: false, reason: "unavailable" };
    }
    if (stat.isSymbolicLink())
      return { ok: false, reason: leaf ? "symlink" : "symlink-ancestor" };
    if (!leaf && !stat.isDirectory())
      return { ok: false, reason: "unavailable" };
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (!isInside(realRoot, real))
      return { ok: false, reason: "outside-root" };
    if (
      leaf &&
      expectedFile &&
      (stat.dev !== expectedFile.dev || stat.ino !== expectedFile.ino)
    ) {
      return { ok: false, reason: "changed" };
    }
  }
  return { ok: true, root };
}

/**
 * Open and bind a regular file without following its final symlink. The
 * nonblocking flag prevents FIFOs and similar special files from stalling
 * before descriptor-based validation can reject them. Callers writing
 * security-sensitive ledgers can also reject multiply-linked inodes.
 */
export function openRegularFile(
  filePath: string,
  flags: number,
  options: OpenRegularFileOptions = {},
): OpenRegularFileResult {
  let trustedRoot: TrustedRootSnapshot | undefined;
  if (options.trustedRoot) {
    const inspected = inspectTrustedPath(filePath, options.trustedRoot);
    if (!inspected.ok) return inspected;
    trustedRoot = inspected.root;
  }
  let fd: number;
  try {
    fd = openSync(
      filePath,
      flags | NOFOLLOW_OPEN_FLAG | NONBLOCK_OPEN_FLAG,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    if (code === "EEXIST") return { ok: false, reason: "exists" };
    if (code === "ELOOP") return { ok: false, reason: "symlink" };
    return { ok: false, reason: "unavailable" };
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      closeSync(fd);
      return { ok: false, reason: "not-regular" };
    }
    if (options.rejectHardlinks && stat.nlink !== 1) {
      closeSync(fd);
      return { ok: false, reason: "hardlink" };
    }
    if (options.trustedRoot && trustedRoot) {
      const inspected = inspectTrustedPath(
        filePath,
        options.trustedRoot,
        trustedRoot,
        stat,
      );
      if (!inspected.ok) {
        closeSync(fd);
        return inspected;
      }
    }
    if (NOFOLLOW_OPEN_FLAG === 0) {
      const pathStat = lstatSync(filePath);
      if (pathStat.isSymbolicLink()) {
        closeSync(fd);
        return { ok: false, reason: "symlink" };
      }
      if (pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
        closeSync(fd);
        return { ok: false, reason: "changed" };
      }
    }
    return { ok: true, fd, stat };
  } catch {
    closeSync(fd);
    return { ok: false, reason: "unavailable" };
  }
}

export function writeAllSync(fd: number, content: string | Buffer): void {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("file write made no progress");
    offset += written;
  }
}

function sameFile(
  left: ReturnType<typeof fstatSync>,
  right: ReturnType<typeof fstatSync>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unlinkIfSameFile(
  filePath: string,
  expected: ReturnType<typeof fstatSync>,
): void {
  try {
    const current = lstatSync(filePath);
    if (!current.isSymbolicLink() && sameFile(current, expected))
      unlinkSync(filePath);
  } catch {
    // Best-effort cleanup must never remove a replacement path.
  }
}

export function atomicWriteTrustedFile(
  filePath: string,
  content: string | Buffer,
  options: OpenRegularFileOptions & { trustedRoot: string },
): void {
  const openOptions: OpenRegularFileOptions = {
    ...options,
    rejectHardlinks: options.rejectHardlinks ?? true,
  };
  const current = openRegularFile(filePath, constants.O_RDONLY, openOptions);
  let expectedTarget: ReturnType<typeof fstatSync> | undefined;
  if (current.ok) {
    expectedTarget = current.stat;
    closeSync(current.fd);
  } else if (current.reason !== "missing") {
    throw new Error(`target file could not be replaced safely: ${current.reason}`);
  }

  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp.${randomBytes(16).toString("hex")}`,
  );
  const staged = openRegularFile(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    openOptions,
  );
  if (!staged.ok)
    throw new Error(`replacement file could not be staged safely: ${staged.reason}`);
  const stagedStat = staged.stat;
  let stagedClosed = false;
  let renamed = false;
  try {
    if (expectedTarget)
      fchmodSync(staged.fd, Number(expectedTarget.mode) & 0o777);
    writeAllSync(staged.fd, content);
    fsyncSync(staged.fd);
    closeSync(staged.fd);
    stagedClosed = true;

    const reboundStage = openRegularFile(
      temporaryPath,
      constants.O_RDONLY,
      openOptions,
    );
    if (!reboundStage.ok || !sameFile(reboundStage.stat, stagedStat)) {
      if (reboundStage.ok) closeSync(reboundStage.fd);
      throw new Error("replacement file changed before commit");
    }
    closeSync(reboundStage.fd);

    const reboundTarget = openRegularFile(
      filePath,
      constants.O_RDONLY,
      openOptions,
    );
    if (expectedTarget) {
      if (!reboundTarget.ok || !sameFile(reboundTarget.stat, expectedTarget)) {
        if (reboundTarget.ok) closeSync(reboundTarget.fd);
        throw new Error("target file changed before replacement");
      }
      closeSync(reboundTarget.fd);
    } else if (reboundTarget.ok || reboundTarget.reason !== "missing") {
      if (reboundTarget.ok) closeSync(reboundTarget.fd);
      throw new Error("target file appeared before replacement");
    }

    renameSync(temporaryPath, filePath);
    renamed = true;
    const replaced = openRegularFile(filePath, constants.O_RDONLY, openOptions);
    if (!replaced.ok || !sameFile(replaced.stat, stagedStat)) {
      if (replaced.ok) closeSync(replaced.fd);
      throw new Error("replacement file could not be rebound safely");
    }
    closeSync(replaced.fd);

    if (process.platform !== "win32") {
      const directoryFd = openSync(path.dirname(filePath), constants.O_RDONLY);
      try {
        fsyncSync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    }
  } finally {
    if (!stagedClosed) closeSync(staged.fd);
    if (!renamed) unlinkIfSameFile(temporaryPath, stagedStat);
  }
}

/**
 * Atomically write content to a file using a temporary file + rename.
 * Ensures the target file is never left in a partially-written state.
 */
export function atomicWrite(path: string, content: string | Buffer): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/**
 * Ensure the directory for the given path exists, creating it recursively if needed.
 */
export function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Read and parse JSON from a file, returning the fallback value if the file
 * doesn't exist or cannot be parsed.
 */
export function readJSON<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Read a bounded prefix and mtime from one opened file descriptor. Opening
 * before stat/read avoids path-based check-then-use races when files are
 * concurrently removed or replaced.
 */
export function readFilePrefixWithStat(path: string, maxBytes: number): { text: string; mtimeMs: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    const len = Math.max(0, Math.min(stat.size, maxBytes));
    const buffer = Buffer.alloc(len);
    if (len > 0) readSync(fd, buffer, 0, len, 0);
    return { text: buffer.toString("utf8"), mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}
