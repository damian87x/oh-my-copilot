import { describe, expect, it } from "vitest";
import { muxConfigPath, readMuxConfig, resolveMux } from "../../src/team/mux.js";
import { inferMuxFromPaneIds, teamMuxKind } from "../../src/team/pane-backend.js";

const yes = () => true;
const no = () => false;
const noConfig = () => undefined;

describe("resolveMux", () => {
  it("auto: neither hc nor tmux ⇒ herdr", () => {
    expect(resolveMux({ env: {}, hcAvailable: yes, readConfig: noConfig })).toEqual({ kind: "herdr", source: "auto" });
  });

  it("auto: inside tmux ⇒ tmux", () => {
    expect(resolveMux({ env: { TMUX: "/tmp/tmux-1/default,1,0" }, hcAvailable: yes, readConfig: noConfig }).kind).toBe("tmux");
  });

  it("auto: inside hc ⇒ herdr even if TMUX leaks in", () => {
    expect(resolveMux({ env: { HC_TERMINAL_ID: "t3", TMUX: "x" }, hcAvailable: yes, readConfig: noConfig }).kind).toBe("herdr");
  });

  it("config overrides auto (herdr inside tmux)", () => {
    const sel = resolveMux({ env: { TMUX: "x" }, hcAvailable: yes, readConfig: () => '{"mux":"herdr"}' });
    expect(sel).toEqual({ kind: "herdr", source: "config" });
  });

  it("config tmux wins over auto herdr", () => {
    expect(resolveMux({ env: {}, hcAvailable: yes, readConfig: () => '{"mux":"tmux"}' }).kind).toBe("tmux");
  });

  it("OMP_MUX beats config", () => {
    const sel = resolveMux({ env: { OMP_MUX: "TMUX" }, hcAvailable: yes, readConfig: () => '{"mux":"herdr"}' });
    expect(sel).toEqual({ kind: "tmux", source: "env" });
  });

  it("herdr selected but hc missing ⇒ tmux with a notice", () => {
    const sel = resolveMux({ env: {}, hcAvailable: no, readConfig: noConfig });
    expect(sel.kind).toBe("tmux");
    expect(sel.notice).toMatch(/hc not found; using tmux/);
  });

  it("malformed config ⇒ auto with warning", () => {
    const sel = resolveMux({ env: {}, hcAvailable: yes, readConfig: () => "{nope" });
    expect(sel.kind).toBe("herdr");
    expect(sel.source).toBe("auto");
    expect(sel.warning).toMatch(/invalid JSON/);
  });

  it("invalid mux value ⇒ auto with warning", () => {
    expect(readMuxConfig({}, () => '{"mux":"screen"}').warning).toMatch(/must be "herdr" or "tmux"/);
  });

  it("invalid OMP_MUX is ignored with a warning", () => {
    const sel = resolveMux({ env: { OMP_MUX: "zellij", TMUX: "x" }, hcAvailable: yes, readConfig: noConfig });
    expect(sel.kind).toBe("tmux");
    expect(sel.warning).toMatch(/OMP_MUX=zellij/);
  });

  it("config path honors COPILOT_HOME", () => {
    expect(muxConfigPath({ COPILOT_HOME: "/x/copilot" })).toBe("/x/copilot/omp.json");
    let seen = "";
    resolveMux({ env: { COPILOT_HOME: "/x/copilot" }, hcAvailable: yes, readConfig: (p) => ((seen = p), undefined) });
    expect(seen).toBe("/x/copilot/omp.json");
  });
});

describe("pinning helpers", () => {
  it("legacy config without mux ⇒ tmux", () => {
    expect(teamMuxKind({})).toBe("tmux");
    expect(teamMuxKind({ mux: { kind: "herdr", group: "omp-abcdef" } })).toBe("herdr");
  });

  it("infers backend from pane id shape", () => {
    expect(inferMuxFromPaneIds(["%1", "%22"])).toBe("tmux");
    expect(inferMuxFromPaneIds(["t1", "t12b"])).toBe("herdr");
    expect(inferMuxFromPaneIds(["%1", "t2"])).toEqual({ error: expect.stringMatching(/mix/) });
  });
});
