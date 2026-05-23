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

interface OutboxScan {
  messages: OutboxMessage[];
  newCursor: number;
  cursor: number;
}

function scanFromCursor(outboxPath: string, offsetPath: string): OutboxScan | undefined {
  if (!existsSync(outboxPath)) return undefined;
  const stats = statSync(outboxPath);
  const cursor = readCursorBytes(offsetPath);
  if (cursor >= stats.size) return { messages: [], newCursor: cursor, cursor };

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
  if (lastNewline === -1) return { messages: [], newCursor: cursor, cursor }; // no complete line yet

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
  return { messages, newCursor, cursor };
}

/**
 * Read new outbox messages and advance the cursor. Use this when you intend
 * to consume the messages (monitorTeam tick).
 */
export function readNewOutbox(outboxPath: string, offsetPath: string): OutboxMessage[] {
  const scan = scanFromCursor(outboxPath, offsetPath);
  if (!scan) return [];
  if (scan.newCursor !== scan.cursor) writeCursorBytes(offsetPath, scan.newCursor);
  return scan.messages;
}

/**
 * Read new outbox messages WITHOUT advancing the cursor. Use this for
 * read-only operations like `omc team status` — calling this never
 * affects what a concurrent monitor will read next.
 */
export function peekNewOutbox(outboxPath: string, offsetPath: string): OutboxMessage[] {
  const scan = scanFromCursor(outboxPath, offsetPath);
  return scan?.messages ?? [];
}

export function resetOutboxCursor(offsetPath: string): void {
  if (existsSync(offsetPath)) writeCursorBytes(offsetPath, 0);
}
