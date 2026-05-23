import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeInbox(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

export function appendInbox(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, content, "utf8");
}

export function readInbox(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}
