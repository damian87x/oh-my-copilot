import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { ompRoot } from "../omp-root.js";
import {
  atomicWrite,
  openRegularFile,
} from "../utils/fs.js";
import { ensureLoopTeamMonitor } from "./monitor-supervisor.js";
import {
  ensureTeamMonitorDirs,
  resolveTeamMonitorPaths,
} from "./state-paths.js";
import {
  makeTmuxForSocket,
  type TmuxApi,
  type TmuxPaneContext,
} from "./tmux.js";
import { recordTeamMonitorEvent } from "./monitor-events.js";

const LANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PANE_ID_RE = /^%\d+$/;

interface VisualManifestLane {
  id: string;
  name?: string;
  paneId: string;
}

export interface VisualRegistrationInput {
  cwd: string;
  teamName: string;
  launchId: string;
  deliveryDir: string;
  manifestPath: string;
  socketPath: string;
  serverPid: number;
  serverStartedAt: number;
  sessionId: string;
  sessionCreatedAt: number;
  windowId: string;
}

export interface VisualRegisteredPane {
  paneId: string;
  laneId: string;
  laneName?: string;
}

export interface VisualTeamRegistration {
  schemaVersion: 1;
  registrationId: string;
  teamName: string;
  projectRoot: string;
  launchId: string;
  generation: string;
  deliveryDir: string;
  manifestPath: string;
  socketPath: string;
  serverPid: number;
  serverStartedAt: number;
  sessionId: string;
  sessionCreatedAt: number;
  windowId: string;
  panes: VisualRegisteredPane[];
  registeredAt: string;
  updatedAt: string;
}

export interface VisualRegistrationDeps {
  tmuxForSocket?: (socketPath: string) => TmuxApi;
  ensure?: typeof ensureLoopTeamMonitor;
  now?: () => number;
}

export type VisualRegistrationResult =
  | { ok: true; registration: VisualTeamRegistration }
  | { ok: false; error: string };

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === "" ||
    (
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot)
    )
  );
}

function digest(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function readVisualManifest(
  deliveryDir: string,
  manifestPath: string,
): { deliveryDir: string; manifestPath: string; lanes: VisualManifestLane[] } {
  const absoluteDeliveryDir = resolve(deliveryDir);
  const absoluteManifestPath = resolve(manifestPath);
  if (absoluteManifestPath !== join(absoluteDeliveryDir, "manifest.json")) {
    throw new Error("visual manifest must be <delivery-dir>/manifest.json");
  }

  const tempRoots = Array.from(
    new Set(
      [tmpdir(), "/tmp"].flatMap((candidate) => {
        try {
          return [realpathSync(candidate)];
        } catch {
          return [];
        }
      }),
    ),
  );
  const deliveryStat = lstatSync(absoluteDeliveryDir);
  if (!deliveryStat.isDirectory() || deliveryStat.isSymbolicLink()) {
    throw new Error("visual delivery directory must be a real directory");
  }
  const realDeliveryDir = realpathSync(absoluteDeliveryDir);
  const trustedTempRoot = tempRoots.find((root) =>
    isInside(root, realDeliveryDir),
  );
  if (!trustedTempRoot) {
    throw new Error("visual delivery directory must be inside the system temp root");
  }
  const realManifestPath = realpathSync(absoluteManifestPath);
  if (realManifestPath !== join(realDeliveryDir, "manifest.json")) {
    throw new Error("visual manifest resolves outside its delivery directory");
  }

  const opened = openRegularFile(realManifestPath, constants.O_RDONLY, {
    rejectHardlinks: true,
    trustedRoot: trustedTempRoot,
  });
  if (!opened.ok) {
    throw new Error(`visual manifest is not a trusted regular file: ${opened.reason}`);
  }
  let raw: string;
  try {
    raw = readFileSync(opened.fd, "utf8");
  } finally {
    closeSync(opened.fd);
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("visual manifest must contain at least one lane");
  }
  const seen = new Set<string>();
  const lanes = parsed.map((value): VisualManifestLane => {
    if (!value || typeof value !== "object") {
      throw new Error("visual manifest lane must be an object");
    }
    const lane = value as Record<string, unknown>;
    if (
      typeof lane.id !== "string" ||
      !LANE_ID_RE.test(lane.id) ||
      typeof lane.paneId !== "string" ||
      !PANE_ID_RE.test(lane.paneId) ||
      (lane.name !== undefined && typeof lane.name !== "string")
    ) {
      throw new Error("visual manifest lane has invalid id, name, or paneId");
    }
    if (seen.has(lane.id) || seen.has(lane.paneId)) {
      throw new Error("visual manifest lane ids and pane ids must be unique");
    }
    seen.add(lane.id);
    seen.add(lane.paneId);
    return { id: lane.id, name: lane.name, paneId: lane.paneId };
  });
  return {
    deliveryDir: realDeliveryDir,
    manifestPath: realManifestPath,
    lanes,
  };
}

function validatePaneContext(
  context: TmuxPaneContext | undefined,
  lane: VisualManifestLane,
  input: VisualRegistrationInput,
  projectRoot: string,
): void {
  if (!context) throw new Error(`visual pane ${lane.paneId} was not found`);
  if (
    resolve(context.socketPath) !== resolve(input.socketPath) ||
    context.serverPid !== input.serverPid ||
    context.serverStartedAt !== input.serverStartedAt ||
    context.sessionId !== input.sessionId ||
    context.sessionCreatedAt !== input.sessionCreatedAt ||
    context.windowId !== input.windowId ||
    context.paneId !== lane.paneId
  ) {
    throw new Error(`visual pane ${lane.paneId} tmux identity mismatch`);
  }
  if (
    context.dead ||
    context.launchId !== input.launchId ||
    context.laneId !== lane.id
  ) {
    throw new Error(`visual pane ${lane.paneId} launch or lane tag mismatch`);
  }
  let paneRoot: string;
  try {
    paneRoot = realpathSync(context.currentPath);
  } catch {
    throw new Error(`visual pane ${lane.paneId} current path is unavailable`);
  }
  if (!isInside(projectRoot, paneRoot)) {
    throw new Error(`visual pane ${lane.paneId} is outside the project root`);
  }
}

function readExistingRegistration(path: string): VisualTeamRegistration | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as VisualTeamRegistration;
    return value?.schemaVersion === 1 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function registerVisualTeam(
  input: VisualRegistrationInput,
  deps: VisualRegistrationDeps = {},
): VisualRegistrationResult {
  try {
    if (
      !input.teamName.trim() ||
      !input.launchId.trim() ||
      !isAbsolute(input.socketPath) ||
      !Number.isInteger(input.serverPid) ||
      !Number.isFinite(input.serverStartedAt) ||
      !input.sessionId ||
      !Number.isFinite(input.sessionCreatedAt) ||
      !input.windowId
    ) {
      throw new Error("visual registration metadata is incomplete");
    }
    const projectRoot = ompRoot(input.cwd);
    const realProjectRoot = realpathSync(projectRoot);
    const manifest = readVisualManifest(input.deliveryDir, input.manifestPath);
    const tmux = (deps.tmuxForSocket ?? makeTmuxForSocket)(input.socketPath);
    if (!tmux.paneContext) {
      throw new Error("tmux pane identity inspection is unavailable");
    }
    for (const lane of manifest.lanes) {
      validatePaneContext(
        tmux.paneContext(lane.paneId),
        lane,
        input,
        realProjectRoot,
      );
    }

    const panes = manifest.lanes
      .map((lane) => ({
        paneId: lane.paneId,
        laneId: lane.id,
        laneName: lane.name,
      }))
      .sort((left, right) => left.laneId.localeCompare(right.laneId));
    const generation = digest([
      projectRoot,
      manifest.manifestPath,
      input.launchId,
      ...panes.flatMap((pane) => [pane.paneId, pane.laneId]),
    ]);
    const registrationId = digest([
      "visual",
      projectRoot,
      manifest.manifestPath,
      input.launchId,
    ]).slice(0, 32);
    const paths = resolveTeamMonitorPaths(projectRoot);
    ensureTeamMonitorDirs(paths);
    const registrationFile = join(paths.visualDir, `${registrationId}.json`);
    const existing = readExistingRegistration(registrationFile);
    const timestamp = new Date((deps.now ?? Date.now)()).toISOString();
    const registration: VisualTeamRegistration = {
      schemaVersion: 1,
      registrationId,
      teamName: input.teamName,
      projectRoot,
      launchId: input.launchId,
      generation,
      deliveryDir: manifest.deliveryDir,
      manifestPath: manifest.manifestPath,
      socketPath: input.socketPath,
      serverPid: input.serverPid,
      serverStartedAt: input.serverStartedAt,
      sessionId: input.sessionId,
      sessionCreatedAt: input.sessionCreatedAt,
      windowId: input.windowId,
      panes,
      registeredAt: existing?.registeredAt ?? timestamp,
      updatedAt: timestamp,
    };
    atomicWrite(registrationFile, `${JSON.stringify(registration, null, 2)}\n`);
    try {
      (deps.ensure ?? ensureLoopTeamMonitor)(projectRoot);
    } catch {
      // Registration is durable even if watcher startup is temporarily unavailable.
    }
    return { ok: true, registration };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordTeamMonitorEvent(input.cwd, {
      type: "visual-registration-failed",
      message,
      at: (deps.now ?? Date.now)(),
    });
    return {
      ok: false,
      error: message,
    };
  }
}
