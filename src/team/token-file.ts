import { randomUUID } from "node:crypto";
import {
  linkSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { atomicWrite } from "../utils/fs.js";

export function readTokenFileToken(path: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      token?: unknown;
    };
    return typeof value.token === "string" ? value.token : undefined;
  } catch {
    return undefined;
  }
}

function restoreOrDiscard(takenPath: string, path: string): void {
  try {
    // linkSync is exclusive: it restores the exact inode only when no newer
    // claimant has already occupied the well-known path.
    linkSync(takenPath, path);
  } catch {
    // A newer owner won the empty-path race. The displaced owner will observe
    // loss of its token and exit; never overwrite the winner.
  }
  try {
    unlinkSync(takenPath);
  } catch {
    // The temporary path was already cleaned up.
  }
}

function takeTokenFile(
  path: string,
  expectedToken: string | undefined,
): string | undefined {
  const takenPath = `${path}.taken.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, takenPath);
  } catch {
    return undefined;
  }
  if (readTokenFileToken(takenPath) !== expectedToken) {
    restoreOrDiscard(takenPath, path);
    return undefined;
  }
  return takenPath;
}

export function removeTokenFileIfMatches(
  path: string,
  expectedToken: string | undefined,
): boolean {
  const takenPath = takeTokenFile(path, expectedToken);
  if (!takenPath) return false;
  try {
    unlinkSync(takenPath);
    return true;
  } catch {
    restoreOrDiscard(takenPath, path);
    return false;
  }
}

export function replaceTokenFileIfMatches(
  path: string,
  expectedToken: string,
  content: string,
): boolean {
  const takenPath = takeTokenFile(path, expectedToken);
  if (!takenPath) return false;
  try {
    atomicWrite(takenPath, content);
    linkSync(takenPath, path);
  } catch {
    restoreOrDiscard(takenPath, path);
    return false;
  }
  try {
    unlinkSync(takenPath);
  } catch {
    // The well-known path already links the committed replacement.
  }
  return true;
}
