import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { OutboxMessage } from "./types.js";

export function appendOutbox(path: string, msg: OutboxMessage): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(msg)}\n`, "utf8");
}

function readCursorBytes(offsetPath: string): number {
  if (!existsSync(offsetPath)) return 0;
  try {
    const data = JSON.parse(readFileSync(offsetPath, "utf8")) as { bytesRead?: number };
    return Number(data.bytesRead) || 0;
  } catch {
    return 0;
  }
}

function writeCursorBytes(offsetPath: string, bytes: number): void {
  mkdirSync(dirname(offsetPath), { recursive: true });
  writeFileSync(offsetPath, JSON.stringify({ bytesRead: bytes }), "utf8");
}

export function readNewOutbox(outboxPath: string, offsetPath: string): OutboxMessage[] {
  if (!existsSync(outboxPath)) return [];
  const stats = statSync(outboxPath);
  const cursor = readCursorBytes(offsetPath);
  if (cursor >= stats.size) return [];

  const remaining = stats.size - cursor;
  const fd = openSync(outboxPath, "r");
  const buf = Buffer.alloc(remaining);
  try {
    readSync(fd, buf, 0, remaining, cursor);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return []; // no complete line yet

  const consumed = text.slice(0, lastNewline + 1);
  const newCursor = cursor + Buffer.byteLength(consumed, "utf8");

  const messages: OutboxMessage[] = [];
  for (const line of consumed.split("\n")) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as OutboxMessage);
    } catch {
      // ignore unparseable line; advance past it anyway
    }
  }
  writeCursorBytes(offsetPath, newCursor);
  return messages;
}

export function resetOutboxCursor(offsetPath: string): void {
  if (existsSync(offsetPath)) writeCursorBytes(offsetPath, 0);
}
