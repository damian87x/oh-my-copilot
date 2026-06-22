import { describe, expect, it } from "vitest";
import { notifyDesktop } from "../../src/gateway/desktop-notify.js";

/** A fake node-notifier that records the options it was handed and drives the callback. */
function fakeNotifier(behavior: "ok" | "error" | "throw") {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    notify(opts: Record<string, unknown>, cb?: (err: Error | null) => void): void {
      calls.push(opts);
      if (behavior === "throw") throw new Error("notify exploded");
      if (behavior === "error") cb?.(new Error("delivery failed"));
      else cb?.(null);
    },
  };
}

describe("notifyDesktop", () => {
  it("posts title/message/open to the notifier and returns ok on success", async () => {
    const n = fakeNotifier("ok");
    const r = await notifyDesktop(
      { title: "schedule: dependabot", message: "ok — 14 alerts", open: "file:///tmp/x.log" },
      { notifier: n, platform: "darwin", env: {} },
    );
    expect(r.ok).toBe(true);
    expect(n.calls).toHaveLength(1);
    expect(n.calls[0]).toMatchObject({
      title: "schedule: dependabot",
      message: "ok — 14 alerts",
      open: "file:///tmp/x.log",
    });
  });

  it("returns a failure (never throws) when the notifier reports an error", async () => {
    const n = fakeNotifier("error");
    const r = await notifyDesktop({ title: "t", message: "m" }, { notifier: n, platform: "darwin", env: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/delivery failed/);
  });

  it("returns a failure (never throws) when the notifier throws synchronously", async () => {
    const n = fakeNotifier("throw");
    const r = await notifyDesktop({ title: "t", message: "m" }, { notifier: n, platform: "darwin", env: {} });
    expect(r.ok).toBe(false);
  });

  it("skips silently (ok, notifier untouched) when OMP_DISABLE_DESKTOP_NOTIFY is set", async () => {
    const n = fakeNotifier("ok");
    const r = await notifyDesktop(
      { title: "t", message: "m" },
      { notifier: n, platform: "darwin", env: { OMP_DISABLE_DESKTOP_NOTIFY: "1" } },
    );
    expect(r.ok).toBe(true);
    expect(n.calls).toHaveLength(0);
  });

  it("skips silently on headless Linux (no DISPLAY/WAYLAND_DISPLAY)", async () => {
    const n = fakeNotifier("ok");
    const r = await notifyDesktop({ title: "t", message: "m" }, { notifier: n, platform: "linux", env: {} });
    expect(r.ok).toBe(true);
    expect(n.calls).toHaveLength(0);
  });

  it("does notify on Linux when a display is present", async () => {
    const n = fakeNotifier("ok");
    const r = await notifyDesktop(
      { title: "t", message: "m" },
      { notifier: n, platform: "linux", env: { DISPLAY: ":0" } },
    );
    expect(r.ok).toBe(true);
    expect(n.calls).toHaveLength(1);
  });

  it("fails when both title and message are empty (nothing to show)", async () => {
    const n = fakeNotifier("ok");
    const r = await notifyDesktop({ title: "  ", message: "" }, { notifier: n, platform: "darwin", env: {} });
    expect(r.ok).toBe(false);
    expect(n.calls).toHaveLength(0);
  });

  it("times out (never hangs) when the notifier never invokes its callback", async () => {
    // A notifier that posts but never calls back — would otherwise hang omp schedule run forever.
    const hung = { notify(_o: Record<string, unknown>, _cb?: (e: Error | null) => void): void {} };
    const r = await notifyDesktop({ title: "t", message: "m" }, { notifier: hung, platform: "darwin", env: {}, timeoutMs: 20 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/tim(e|ed) out/i);
  });

  it("disable kill-switch wins over empty fields (silent skip, not failure)", async () => {
    const n = fakeNotifier("ok");
    const r = await notifyDesktop(
      { title: "", message: "" },
      { notifier: n, platform: "darwin", env: { OMP_DISABLE_DESKTOP_NOTIFY: "1" } },
    );
    expect(r.ok).toBe(true);
    expect(n.calls).toHaveLength(0);
  });
});
