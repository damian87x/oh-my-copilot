import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  fstatSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DeliveryReceipt, MailboxLine, MailboxMessage, MailboxMessageView } from "./types.js";

// ---------------------------------------------------------------------------
// Recipient name validation (path-traversal guard)
// ---------------------------------------------------------------------------

/**
 * Recipient names are used to build `<mailboxDir>/<recipient>.jsonl` paths and
 * come from external CLI `--input` JSON. Reject anything that could escape the
 * mailbox directory. Hard guard — call before constructing any file path.
 */
export function validateRecipientName(name: string): boolean {
  if (!name || name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function mailboxFilePath(mailboxDir: string, recipient: string): string {
  if (!validateRecipientName(recipient)) {
    throw new Error(`invalid_recipient_name: ${recipient}`);
  }
  return join(mailboxDir, `${recipient}.jsonl`);
}

export function mailboxOffsetPath(mailboxDir: string, recipient: string): string {
  if (!validateRecipientName(recipient)) {
    throw new Error(`invalid_recipient_name: ${recipient}`);
  }
  return join(mailboxDir, `.${recipient}.offset`);
}

// ---------------------------------------------------------------------------
// Byte-cursor scanner (copied verbatim from outbox.ts to mirror the pattern)
// ---------------------------------------------------------------------------

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

interface MailboxScan {
  lines: MailboxLine[];
  newCursor: number;
  cursor: number;
}

function scanFromCursor(filePath: string, offsetPath: string): MailboxScan | undefined {
  const cursor = readCursorBytes(offsetPath);
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return undefined;
  }
  let buf: Buffer;
  try {
    const stats = fstatSync(fd);
    if (cursor >= stats.size) return { lines: [], newCursor: cursor, cursor };

    const remaining = stats.size - cursor;
    buf = Buffer.alloc(remaining);
    readSync(fd, buf, 0, remaining, cursor);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf8");
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) return { lines: [], newCursor: cursor, cursor }; // no complete line yet

  const consumed = text.slice(0, lastNewline + 1);
  const newCursor = cursor + Buffer.byteLength(consumed, "utf8");

  const lines: MailboxLine[] = [];
  for (const line of consumed.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as MailboxLine);
    } catch {
      // ignore unparseable line; advance past it anyway
    }
  }
  return { lines, newCursor, cursor };
}

// ---------------------------------------------------------------------------
// Writes (append-only)
// ---------------------------------------------------------------------------

/** Append a message to its recipient's mailbox (keyed by msg.to). */
export function appendMailbox(mailboxDir: string, msg: MailboxMessage): void {
  const filePath = mailboxFilePath(mailboxDir, msg.to);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(msg)}\n`, "utf8");
}

/**
 * Mark a message delivered by APPENDING a DeliveryReceipt line (never rewrites
 * the file, so active byte cursors stay valid). Returns false if no message
 * with `messageId` exists (no receipt written).
 */
export function markDelivered(mailboxDir: string, recipient: string, messageId: string): boolean {
  const filePath = mailboxFilePath(mailboxDir, recipient);
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch {
    return false;
  }

  let text: string;
  try {
    const stats = fstatSync(fd);
    const buf = Buffer.alloc(stats.size);
    if (stats.size > 0) readSync(fd, buf, 0, stats.size, 0);
    text = buf.toString("utf8");
  } finally {
    closeSync(fd);
  }

  let found = false;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = JSON.parse(raw) as MailboxLine;
      if (line.type === "message" && line.id === messageId) {
        found = true;
        break;
      }
    } catch {
      // skip unparseable line
    }
  }
  if (!found) return false;

  const receipt: DeliveryReceipt = {
    type: "delivery-receipt",
    messageId,
    deliveredAt: new Date().toISOString(),
  };
  appendFileSync(filePath, `${JSON.stringify(receipt)}\n`, "utf8");
  return true;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Read new messages via byte cursor and advance it. The cursor advances past
 * ALL lines (including delivery-receipt lines), but only `type: "message"`
 * lines are returned — receipts are consumed but filtered from the result.
 */
export function readNewMailbox(mailboxDir: string, recipient: string): MailboxMessage[] {
  const filePath = mailboxFilePath(mailboxDir, recipient);
  const offsetPath = mailboxOffsetPath(mailboxDir, recipient);
  const scan = scanFromCursor(filePath, offsetPath);
  if (!scan) return [];
  if (scan.newCursor !== scan.cursor) writeCursorBytes(offsetPath, scan.newCursor);
  return scan.lines.filter((l): l is MailboxMessage => l.type === "message");
}

/** Same filtering as readNewMailbox but does NOT advance the cursor. */
export function peekMailbox(mailboxDir: string, recipient: string): MailboxMessage[] {
  const filePath = mailboxFilePath(mailboxDir, recipient);
  const offsetPath = mailboxOffsetPath(mailboxDir, recipient);
  const scan = scanFromCursor(filePath, offsetPath);
  if (!scan) return [];
  return scan.lines.filter((l): l is MailboxMessage => l.type === "message");
}

/**
 * Full-file scan (no cursor). Returns every message merged with delivery info
 * from any matching DeliveryReceipt line.
 */
export function listMailbox(mailboxDir: string, recipient: string): MailboxMessageView[] {
  const filePath = mailboxFilePath(mailboxDir, recipient);
  if (!existsSync(filePath)) return [];

  const messages: MailboxMessage[] = [];
  const deliveredAt = new Map<string, string>();
  for (const raw of readFileSync(filePath, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let line: MailboxLine;
    try {
      line = JSON.parse(raw) as MailboxLine;
    } catch {
      continue;
    }
    if (line.type === "message") {
      messages.push(line);
    } else if (line.type === "delivery-receipt") {
      deliveredAt.set(line.messageId, line.deliveredAt);
    }
  }

  return messages.map((m) => {
    const delivered = deliveredAt.get(m.id);
    return delivered ? { ...m, deliveredAt: delivered } : { ...m };
  });
}
