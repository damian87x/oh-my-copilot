import { HC_ADDRESS_RE, makeHerdr } from "./herdr.js";
import type { MuxKind } from "./mux.js";
import { makeTmux, type TmuxApi } from "./tmux.js";
import type { TeamConfig } from "./types.js";

/**
 * Per-team backend pinning. Every caller that touches a team's panes builds its
 * client from what the team recorded at start (TeamConfig.mux / manifest lane
 * mux), never from the current environment — so a worker whose env says tmux
 * still nudges herdr terminals of a herdr team, and vice versa.
 */
export interface BackendDeps {
  tmux?: TmuxApi;
  herdr?: TmuxApi;
}

export function teamMuxKind(config: Pick<TeamConfig, "mux"> | undefined): MuxKind {
  return config?.mux?.kind === "herdr" ? "herdr" : "tmux";
}

export function backendFor(kind: MuxKind | undefined, deps: BackendDeps = {}): TmuxApi {
  if (kind === "herdr") return deps.herdr ?? makeHerdr();
  return deps.tmux ?? makeTmux();
}

export function backendForConfig(config: Pick<TeamConfig, "mux"> | undefined, deps: BackendDeps = {}): TmuxApi {
  return backendFor(teamMuxKind(config), deps);
}

const TMUX_PANE_RE = /^%\d+$/;

/** Infer the backend from raw pane ids: all `%N` ⇒ tmux, all `tN` ⇒ herdr, else error. */
export function inferMuxFromPaneIds(ids: string[]): MuxKind | { error: string } {
  if (ids.length === 0) return { error: "no pane ids" };
  if (ids.every((id) => TMUX_PANE_RE.test(id))) return "tmux";
  if (ids.every((id) => HC_ADDRESS_RE.test(id))) return "herdr";
  return { error: "pane ids mix tmux (%N) and herdr (tN) forms; pass --mux" };
}
