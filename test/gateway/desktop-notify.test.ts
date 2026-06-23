import { describe, expect, it } from "vitest";
import { buildOsascriptArgs, notifyDesktop } from "../../src/gateway/desktop-notify.js";

/** Records the payloads handed to an injected transport. */
function spyTransport(result: { ok: true } | { ok: false; reason: string }) {
  const calls: Array<{ title: string; message: string; open?: string }> = [];
  return { calls, fn: async (p: { title: string; message: string; open?: string }) => (calls.push(p), result) };
}

describe("notifyDesktop (contract, via injected transport)", () => {
  it("delivers title/message/open through the transport and returns ok", async () => {
    const t = spyTransport({ ok: true });
    const r = await notifyDesktop(
      { title: "schedule: dep", message: "ok — 14 alerts", open: "file:///tmp/x.log" },
      { transport: t.fn, platform: "darwin", env: {} },
    );
    expect(r.ok).toBe(true);
    expect(t.calls[0]).toMatchObject({ title: "schedule: dep", message: "ok — 14 alerts", open: "file:///tmp/x.log" });
  });

  it("propagates a transport failure (never throws)", async () => {
    const r = await notifyDesktop(
      { title: "t", message: "m" },
      { transport: async () => ({ ok: false, reason: "delivery failed" }), platform: "darwin", env: {} },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/delivery failed/);
  });

  it("never throws when the transport throws synchronously", async () => {
    const r = await notifyDesktop(
      { title: "t", message: "m" },
      {
        transport: () => {
          throw new Error("boom");
        },
        platform: "darwin",
        env: {},
      },
    );
    expect(r.ok).toBe(false);
  });

  it("skips silently (ok, transport untouched) when OMP_DISABLE_DESKTOP_NOTIFY is set", async () => {
    const t = spyTransport({ ok: true });
    const r = await notifyDesktop({ title: "t", message: "m" }, { transport: t.fn, platform: "darwin", env: { OMP_DISABLE_DESKTOP_NOTIFY: "1" } });
    expect(r.ok).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  it("skips silently on headless Linux (no DISPLAY/WAYLAND_DISPLAY)", async () => {
    const t = spyTransport({ ok: true });
    const r = await notifyDesktop({ title: "t", message: "m" }, { transport: t.fn, platform: "linux", env: {} });
    expect(r.ok).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  it("delivers on Linux when a display is present", async () => {
    const t = spyTransport({ ok: true });
    const r = await notifyDesktop({ title: "t", message: "m" }, { transport: t.fn, platform: "linux", env: { DISPLAY: ":0" } });
    expect(r.ok).toBe(true);
    expect(t.calls).toHaveLength(1);
  });

  it("fails when both title and message are empty (transport untouched)", async () => {
    const t = spyTransport({ ok: true });
    const r = await notifyDesktop({ title: "  ", message: "" }, { transport: t.fn, platform: "darwin", env: {} });
    expect(r.ok).toBe(false);
    expect(t.calls).toHaveLength(0);
  });

  it("disable kill-switch wins over empty fields (silent skip)", async () => {
    const t = spyTransport({ ok: true });
    const r = await notifyDesktop({ title: "", message: "" }, { transport: t.fn, platform: "darwin", env: { OMP_DISABLE_DESKTOP_NOTIFY: "1" } });
    expect(r.ok).toBe(true);
    expect(t.calls).toHaveLength(0);
  });

  it("times out (never hangs) when the transport never resolves", async () => {
    const r = await notifyDesktop(
      { title: "t", message: "m" },
      { transport: () => new Promise(() => {}), platform: "darwin", env: {}, timeoutMs: 20 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tim(e|ed) out/i);
  });
});

describe("buildOsascriptArgs", () => {
  it("passes message and title as argv items so they are never interpolated into AppleScript", () => {
    expect(buildOsascriptArgs("schedule: t", 'ok — "quote" & $(boom)')).toEqual([
      "-e",
      "on run argv",
      "-e",
      "display notification (item 1 of argv) with title (item 2 of argv)",
      "-e",
      "end run",
      "--",
      'ok — "quote" & $(boom)',
      "schedule: t",
    ]);
  });
});

describe("macOS transport selection", () => {
  function spyExec() {
    const calls: Array<{ file: string; args: string[] }> = [];
    return { calls, fn: async (file: string, args: string[]) => (calls.push({ file, args }), { ok: true as const }) };
  }

  it("defaults to osascript on macOS — even when a system terminal-notifier exists (reliable on Sequoia)", async () => {
    const e = spyExec();
    const r = await notifyDesktop(
      { title: "t", message: "m", open: "file:///x" },
      { platform: "darwin", env: {}, exec: e.fn, hasSystemTerminalNotifier: true },
    );
    expect(r.ok).toBe(true);
    expect(e.calls[0].file).toBe("osascript");
    expect(e.calls[0].args).toContain("display notification (item 1 of argv) with title (item 2 of argv)");
  });

  it("opts into terminal-notifier (with -open click support) via OMP_NOTIFY_USE_TERMINAL_NOTIFIER when available", async () => {
    const e = spyExec();
    const r = await notifyDesktop(
      { title: "t", message: "m", open: "file:///x.command" },
      { platform: "darwin", env: { OMP_NOTIFY_USE_TERMINAL_NOTIFIER: "1" }, exec: e.fn, hasSystemTerminalNotifier: true },
    );
    expect(r.ok).toBe(true);
    expect(e.calls[0].file).toBe("terminal-notifier");
    expect(e.calls[0].args).toEqual(["-title", "t", "-message", "m", "-open", "file:///x.command"]);
  });

  it("falls back to osascript when terminal-notifier is opted in but none is on PATH", async () => {
    const e = spyExec();
    const r = await notifyDesktop(
      { title: "t", message: "m" },
      { platform: "darwin", env: { OMP_NOTIFY_USE_TERMINAL_NOTIFIER: "1" }, exec: e.fn, hasSystemTerminalNotifier: false },
    );
    expect(r.ok).toBe(true);
    expect(e.calls[0].file).toBe("osascript");
  });
});
