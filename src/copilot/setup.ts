import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { resolveCopilotPaths, type CopilotPaths, type ResolveCopilotPathsOptions } from "./paths.js";
import { atomicWrite } from "../utils/fs.js";
import { loadCatalogBundle, validateCatalogBundle } from "../catalog.js";

export interface SetupOptions extends ResolveCopilotPathsOptions {
  dryRun?: boolean;
  scope?: "project" | "user";
  /** Overwrite bundled skills/agents that exist but differ from the bundle.
   *  Without it, changed files are reported as "skip-changed" (the CLI offers an
   *  interactive override); identical files are always skipped. */
  force?: boolean;
}

export type SetupActionKind =
  | "copy"
  | "create"
  | "update"
  | "skip-exists"
  | "skip-changed"
  | "skip-source-missing"
  | "skip-source-invalid";

export interface SetupAction {
  source: string;
  target: string;
  kind: SetupActionKind;
}

export interface SetupConflict {
  code:
    | "UNKNOWN_EFFECTIVE_GOAL"
    | "GOAL_SCOPE_MIGRATION_REQUIRED"
    | "LEGACY_GOAL_INSTRUCTIONS"
    | "BUNDLE_SYMLINK"
    | "BUNDLE_ENTRY_INVALID"
    | "TARGET_SYMLINK"
    | "TARGET_HARDLINK"
    | "TARGET_ENTRY_INVALID"
    | "CATALOG_INCOMPLETE"
    | "CATALOG_INVALID";
  path: string;
  message: string;
}

export interface GoalDiscoveryEntry {
  scope: "project" | "user" | "bundle";
  path: string;
  status: "missing" | "current" | "legacy-known" | "managed" | "unknown";
  sha256?: string;
}

export interface InstructionSource {
  scope: "project" | "user";
  path: string;
  status: "current" | "legacy-goal" | "unreadable";
}

export interface SetupValidation {
  bundle: {
    status: "valid" | "invalid";
    sha256: string;
    fileCount: number;
  };
  catalog: {
    status: "valid" | "absent" | "invalid";
    sha256?: string;
    skillNames: string[];
  };
  goalDiscovery: GoalDiscoveryEntry[];
  effectiveGoalPath?: string;
  instructionSources: InstructionSource[];
}

export interface SetupResult {
  ok: boolean;
  dryRun: boolean;
  scope: "project" | "user";
  actions: SetupAction[];
  conflicts: SetupConflict[];
  validation: SetupValidation;
  manifestPath: string;
  paths: CopilotPaths;
}

const COPILOT_INSTRUCTIONS_TEMPLATE = `# oh-my-copilot

Default behaviours installed by \`omp setup\`. Override per project as needed.

## Approach
- Surface assumptions before coding.
- Prefer the simplest change that satisfies the request.
- Touch only what the task requires.
- Verify success with concrete checks: tests, output, behaviour.

## Validation
- Run tests for code you change.
- Read the diff before committing.
- If unsure about scope, ask.

## Cost/token discipline
Cost data is local, best-effort, and estimated. \`omp cost [--today] [--session <id>]\`
summarizes prompt/tool token estimates from the hook ledger; it is not provider billing.

The cost hooks apply when this plugin's \`hooks/hooks.json\` is active in a Copilot CLI
session. They give session-wide visibility for skills invoked inside that session, not
standalone coverage for copied skills, raw shell scripts, or external CLIs.

Before rerunning noisy commands or failed edits, inspect the latest output and narrow the
next attempt. Prefer bounded summaries for large logs. Oversized postToolUse output is
minimized before it re-enters model context, with raw output preserved on disk and savings
recorded in the cost ledger. Budget gates and retry-cost guidance are not current live behavior.
`;

function filesEqual(a: string, b: string): boolean {
  try {
    return readFileSync(a, "utf8") === readFileSync(b, "utf8");
  } catch {
    return false;
  }
}

function hashFile(path: string): string | undefined {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
}

/** Managed-file migration state for the user-scope bundle. `files` maps a
 *  path relative to `root` (e.g. `skills/ralplan/SKILL.md`) to the sha256 of
 *  the content omp last installed there. A target that differs from the new
 *  bundle but still matches the recorded hash was never user-edited, so
 *  upgrades may refresh it without --force; anything else stays skip-changed.
 *  Files installed before the manifest existed have no entry and keep the old
 *  skip-changed behaviour (one interactive/`--force` override seeds them). */
interface BundleManifest {
  version: 2;
  scope: "project" | "user";
  root: string;
  path: string;
  files: Record<string, string>;
  validation: SetupValidation;
}

const BUNDLE_MANIFEST_NAME = "omp-bundle-manifest.json";
const KNOWN_LEGACY_GOAL_HASHES = new Set([
  "e730467f9bdb03f72143f0177f1fe813644c7aac1e09bd78da76545f3d5b2723",
  "fe5fe83753c82a5ec63353068941257ffdd9c161d0c95473ca432b654eb94b07",
]);

function manifestLocation(
  paths: CopilotPaths,
  scope: "project" | "user",
): { root: string; path: string } {
  if (scope === "user") {
    return {
      root: paths.userScope,
      path: join(paths.userScope, BUNDLE_MANIFEST_NAME),
    };
  }
  return {
    root: paths.projectRoot,
    path: join(paths.projectRoot, ".omp", BUNDLE_MANIFEST_NAME),
  };
}

function emptyValidation(): SetupValidation {
  return {
    bundle: { status: "valid", sha256: "", fileCount: 0 },
    catalog: { status: "absent", skillNames: [] },
    goalDiscovery: [],
    instructionSources: [],
  };
}

function loadBundleManifest(
  paths: CopilotPaths,
  scope: "project" | "user",
): BundleManifest {
  const location = manifestLocation(paths, scope);
  let files: Record<string, string> = {};
  try {
    const raw = JSON.parse(readFileSync(location.path, "utf8")) as {
      files?: Record<string, string>;
    };
    if (raw.files && typeof raw.files === "object") files = raw.files;
  } catch {
    // Missing or unparseable → start empty; first real copy seeds it.
  }
  return {
    version: 2,
    scope,
    root: location.root,
    path: location.path,
    files,
    validation: emptyValidation(),
  };
}

function recordInstalled(manifest: BundleManifest, target: string, source: string): void {
  const hash = hashFile(source);
  if (!hash) return;
  const key = relative(manifest.root, target);
  manifest.files[key] = hash;
}

function saveBundleManifest(manifest: BundleManifest, dryRun: boolean): void {
  if (dryRun) return;
  mkdirSync(dirname(manifest.path), { recursive: true });
  atomicWrite(
    manifest.path,
    `${JSON.stringify(
      {
        version: 2,
        scope: manifest.scope,
        root: manifest.root,
        files: manifest.files,
        validation: manifest.validation,
      },
      null,
      2,
    )}\n`,
  );
}

function copyDirRecursive(
  source: string,
  target: string,
  actions: SetupAction[],
  dryRun: boolean,
  force: boolean,
  manifest?: BundleManifest,
  trustedOverwriteTargets: ReadonlySet<string> = new Set(),
  protectedTargets: ReadonlySet<string> = new Set(),
): void {
  if (!existsSync(source)) {
    actions.push({ source, target, kind: "skip-source-missing" });
    return;
  }
  if (!dryRun && !existsSync(target)) mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sPath = join(source, entry.name);
    const tPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(
        sPath,
        tPath,
        actions,
        dryRun,
        force,
        manifest,
        trustedOverwriteTargets,
        protectedTargets,
      );
    } else if (entry.isFile()) {
      if (existsSync(tPath)) {
        // Identical → always skip. Differs → skip unless forced (the CLI offers
        // an override prompt), so updated bundled skills can actually propagate.
        if (filesEqual(sPath, tPath)) {
          actions.push({ source: sPath, target: tPath, kind: "skip-exists" });
          if (manifest) recordInstalled(manifest, tPath, sPath);
          continue;
        }
        if (protectedTargets.has(tPath)) {
          actions.push({ source: sPath, target: tPath, kind: "skip-changed" });
          continue;
        }
        if (!force && !trustedOverwriteTargets.has(tPath)) {
          // Managed-file migration: the target differs from the new bundle but
          // still matches what WE installed last time → the user never edited
          // it, so the upgrade may refresh it without clobbering real edits.
          const recorded = manifest?.files[relative(manifest.root, tPath)];
          if (!manifest || !recorded || hashFile(tPath) !== recorded) {
            actions.push({ source: sPath, target: tPath, kind: "skip-changed" });
            continue;
          }
        }
        if (!dryRun) {
          mkdirSync(dirname(tPath), { recursive: true });
          atomicWrite(tPath, readFileSync(sPath));
        }
        actions.push({ source: sPath, target: tPath, kind: "update" });
        if (manifest && !dryRun) recordInstalled(manifest, tPath, sPath);
        continue;
      }
      if (!dryRun) {
        mkdirSync(dirname(tPath), { recursive: true });
        atomicWrite(tPath, readFileSync(sPath));
      }
      actions.push({ source: sPath, target: tPath, kind: "copy" });
      if (manifest && !dryRun) recordInstalled(manifest, tPath, sPath);
    }
  }
}

function ensureFile(target: string, content: string, actions: SetupAction[], dryRun: boolean): void {
  if (existsSync(target)) {
    actions.push({ source: "(template)", target, kind: "skip-exists" });
    return;
  }
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true });
    atomicWrite(target, content);
  }
  actions.push({ source: "(template)", target, kind: "create" });
}

function ensureDir(target: string, actions: SetupAction[], dryRun: boolean): void {
  if (existsSync(target)) {
    actions.push({ source: "(dir)", target, kind: "skip-exists" });
    return;
  }
  if (!dryRun) mkdirSync(target, { recursive: true });
  actions.push({ source: "(dir)", target, kind: "create" });
}

// Copilot only loads hooks from user (`~/.copilot/hooks/*.json`) or project
// (`.github/hooks/*.json`) locations — NOT from a plugin's own hooks/hooks.json.
// So omp's lifecycle hooks (sessionEnd → memory-review, cost ledger, etc.) never
// fire until we install them into one of those locations (this is how Orca's
// orca.json works). The file is machine-local (absolute node script paths), so
// it always goes to the user location regardless of skills/agents scope.
const HOOK_FILE_NAME = "omp.json";

/** Pin the plugin root for a hook command. The bundled hooks.json resolves its
 *  script dir from `${COPILOT_PLUGIN_ROOT:-…}`, but copilot does NOT set that var
 *  for user/project hook files (only for plugin-context hooks). We `export` the
 *  vars as a SEPARATE statement first: an assignment prefix on the same simple
 *  command (`VAR=x node "${VAR:-…}"`) is NOT visible to that command's own
 *  parameter expansion, so it must be exported before the command runs. */
function pinPluginRoot(bash: string, pluginRoot: string): string {
  const esc = pluginRoot.replace(/'/g, "'\\''");
  return `export COPILOT_PLUGIN_ROOT='${esc}' OMP_PLUGIN_ROOT='${esc}'; ${bash}`;
}

function installHooks(paths: CopilotPaths, dryRun: boolean, actions: SetupAction[]): void {
  const source = paths.hooksManifest;
  if (!existsSync(source)) {
    actions.push({ source, target: HOOK_FILE_NAME, kind: "skip-source-missing" });
    return;
  }
  let manifest: { version?: number; hooks?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(source, "utf8"));
  } catch {
    // Present but unparseable — surface it rather than masking as "missing".
    actions.push({ source, target: HOOK_FILE_NAME, kind: "skip-source-invalid" });
    return;
  }
  const hooks = manifest.hooks;
  if (!hooks || typeof hooks !== "object") {
    actions.push({ source, target: HOOK_FILE_NAME, kind: "skip-source-invalid" });
    return;
  }
  // Rewrite every command's bash to pin the absolute plugin root.
  for (const handlers of Object.values(hooks)) {
    if (!Array.isArray(handlers)) continue;
    for (const handler of handlers) {
      if (handler && typeof handler === "object" && typeof (handler as { bash?: unknown }).bash === "string") {
        const h = handler as { bash: string };
        h.bash = pinPluginRoot(h.bash, paths.pluginRoot);
      }
    }
  }

  const target = join(paths.userScope, "hooks", HOOK_FILE_NAME);
  // Managed, generated file — refresh on every setup so updated script paths /
  // new events propagate (unlike copied skills, which we never clobber).
  const kind: SetupActionKind = existsSync(target) ? "update" : "create";
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(tmp, target);
  }
  actions.push({ source, target, kind });
}

/** Absolute path of the user-level hook file omp installs/refreshes. Lets callers
 *  (e.g. bare-launch first-run setup) cheaply check "are hooks installed?". */
export function userHookPath(options: SetupOptions = {}): string {
  return join(resolveCopilotPaths(options).userScope, "hooks", HOOK_FILE_NAME);
}

/** True when the user-level hooks should be (re)installed: either missing, or the
 *  PINNED plugin root in the installed omp.json differs from where omp now runs
 *  (e.g. an nvm node switch / reinstall moved the install path, leaving the hook
 *  scripts pointing at a stale absolute path). Lets bare `omp` self-repair. */
export function userHooksNeedRefresh(options: SetupOptions = {}): boolean {
  const p = userHookPath(options);
  if (!existsSync(p)) return true;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as { hooks?: Record<string, unknown> };
    const current = resolveCopilotPaths(options).pluginRoot;
    for (const handlers of Object.values(raw.hooks ?? {})) {
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const bash = (handler as { bash?: unknown })?.bash;
        if (typeof bash !== "string") continue;
        // Quote-aware capture: a single-quoted shell value is non-quote chars or
        // the escaped-quote token `'\''`. Greedy `(.*)` would mis-stop on a path
        // that literally contains ` OMP_PLUGIN_ROOT=` and refresh-loop forever.
        const m = bash.match(/COPILOT_PLUGIN_ROOT='((?:[^']|'\\'')*)' OMP_PLUGIN_ROOT=/);
        if (m) {
          const pinned = m[1].replace(/'\\''/g, "'"); // reverse shell-escaping
          return pinned !== current; // stale if it points at a different install
        }
      }
    }
    return false; // no pinned marker found → leave it alone
  } catch {
    return true; // unparseable → reinstall a clean copy
  }
}

/** Install just the user-level hooks (the piece copilot won't load from the
 *  plugin dir). Used by bare launch self-repair when only hooks are stale.
 *  Idempotent. */
export function installUserHooks(options: SetupOptions = {}): { actions: SetupAction[]; paths: CopilotPaths } {
  const paths = resolveCopilotPaths(options);
  const actions: SetupAction[] = [];
  installHooks(paths, Boolean(options.dryRun), actions);
  return { actions, paths };
}

/** Copy bundled skills/agents into the user home (`~/.copilot/skills|agents`).
 *  Never touches the project `.github`. Used by `omp update` and interactive
 *  auto-update so personal installs stay in lockstep with the CLI. */
export function installUserBundle(
  options: SetupOptions = {},
): {
  ok: boolean;
  actions: SetupAction[];
  conflicts: SetupConflict[];
  validation: SetupValidation;
  paths: CopilotPaths;
} {
  const paths = resolveCopilotPaths(options);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const actions: SetupAction[] = [];
  const preparation = prepareBundleInstall(paths, "user");
  const blocked = hasBlockingConflict(preparation.conflicts);
  if (!blocked) {
    copyBundledSkillsAndAgents(paths, "user", actions, dryRun, force, preparation);
  }
  return {
    ok: !blocked,
    actions,
    conflicts: preparation.conflicts,
    validation: preparation.validation,
    paths,
  };
}

/** Refresh the full user-home install: hooks + skills + agents. No project
 *  scaffolding. Shared by `omp update` and bare-`omp` "Update now?" yes. */
export function refreshUserInstall(
  options: SetupOptions = {},
): {
  ok: boolean;
  actions: SetupAction[];
  conflicts: SetupConflict[];
  validation: SetupValidation;
  paths: CopilotPaths;
} {
  const paths = resolveCopilotPaths(options);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const actions: SetupAction[] = [];
  const preparation = prepareBundleInstall(paths, "user");
  const blocked = hasBlockingConflict(preparation.conflicts);
  if (!blocked) {
    installHooks(paths, dryRun, actions);
    copyBundledSkillsAndAgents(paths, "user", actions, dryRun, force, preparation);
  }
  return {
    ok: !blocked,
    actions,
    conflicts: preparation.conflicts,
    validation: preparation.validation,
    paths,
  };
}

function skillsTargetFor(paths: CopilotPaths, scope: "project" | "user"): string {
  return scope === "project" ? paths.projectScopeSkills : paths.userScopeSkills;
}

function agentsTargetFor(paths: CopilotPaths, scope: "project" | "user"): string {
  return scope === "project" ? paths.projectScopeAgents : paths.userScopeAgents;
}

interface InstallPreparation {
  conflicts: SetupConflict[];
  manifest: BundleManifest;
  validation: SetupValidation;
  trustedOverwriteTargets: Set<string>;
  protectedTargets: Set<string>;
}

const ADVISORY_CONFLICT_CODES = new Set<SetupConflict["code"]>([
  "UNKNOWN_EFFECTIVE_GOAL",
  "GOAL_SCOPE_MIGRATION_REQUIRED",
  "LEGACY_GOAL_INSTRUCTIONS",
]);

function hasBlockingConflict(conflicts: readonly SetupConflict[]): boolean {
  return conflicts.some((conflict) => !ADVISORY_CONFLICT_CODES.has(conflict.code));
}

function hashRecords(records: Array<{ path: string; sha256: string }>): string {
  const hash = createHash("sha256");
  for (const record of [...records].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(record.path, "utf8");
    hash.update("\0", "utf8");
    hash.update(record.sha256, "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex");
}

function scanBundleTree(
  root: string,
  current: string,
  records: Array<{ path: string; sha256: string }>,
  conflicts: SetupConflict[],
): void {
  if (!existsSync(current)) return;
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      conflicts.push({
        code: "BUNDLE_SYMLINK",
        path,
        message: "bundled setup sources must not contain symbolic links",
      });
      continue;
    }
    if (entry.isDirectory()) {
      scanBundleTree(root, path, records, conflicts);
      continue;
    }
    if (!entry.isFile()) {
      conflicts.push({
        code: "BUNDLE_ENTRY_INVALID",
        path,
        message: "bundled setup sources must contain only directories and regular files",
      });
      continue;
    }
    const sha256 = hashFile(path);
    if (!sha256) {
      conflicts.push({
        code: "BUNDLE_ENTRY_INVALID",
        path,
        message: "bundled setup source could not be hashed",
      });
      continue;
    }
    records.push({ path: relative(root, path), sha256 });
  }
}

function scanInstallTarget(path: string, conflicts: SetupConflict[]): void {
  if (!existsSync(path)) return;
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    conflicts.push({
      code: "TARGET_ENTRY_INVALID",
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (stat.isSymbolicLink()) {
    conflicts.push({
      code: "TARGET_SYMLINK",
      path,
      message: "setup will not write through a symbolic-link target",
    });
    return;
  }
  if (stat.isFile()) {
    if (stat.nlink > 1) {
      conflicts.push({
        code: "TARGET_HARDLINK",
        path,
        message: "setup will not overwrite a multiply-linked target file",
      });
    }
    return;
  }
  if (!stat.isDirectory()) {
    conflicts.push({
      code: "TARGET_ENTRY_INVALID",
      path,
      message: "setup targets must contain only directories and regular files",
    });
    return;
  }
  try {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      scanInstallTarget(join(path, entry.name), conflicts);
    }
  } catch (error) {
    conflicts.push({
      code: "TARGET_ENTRY_INVALID",
      path,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateBundle(paths: CopilotPaths): {
  bundle: SetupValidation["bundle"];
  catalog: SetupValidation["catalog"];
  conflicts: SetupConflict[];
} {
  const conflicts: SetupConflict[] = [];
  const records: Array<{ path: string; sha256: string }> = [];
  for (const directory of [
    join(paths.pluginRoot, ".github", "skills"),
    join(paths.pluginRoot, ".github", "agents"),
    join(paths.pluginRoot, "hooks"),
    join(paths.pluginRoot, "catalog"),
  ]) {
    scanBundleTree(paths.pluginRoot, directory, records, conflicts);
  }

  const catalogDir = join(paths.pluginRoot, "catalog");
  const capabilitiesPath = join(catalogDir, "capabilities.json");
  const skillsPath = join(catalogDir, "skills-general.json");
  const hasCapabilities = existsSync(capabilitiesPath);
  const hasSkills = existsSync(skillsPath);
  let catalog: SetupValidation["catalog"] = {
    status: "absent",
    skillNames: [],
  };
  if (hasCapabilities !== hasSkills) {
    conflicts.push({
      code: "CATALOG_INCOMPLETE",
      path: catalogDir,
      message: "catalog must contain both capabilities.json and skills-general.json",
    });
    catalog = { status: "invalid", skillNames: [] };
  } else if (hasCapabilities && hasSkills) {
    try {
      const validation = validateCatalogBundle(loadCatalogBundle(catalogDir));
      const catalogRecords = records.filter((record) => record.path.startsWith("catalog/"));
      catalog = {
        status: validation.ok ? "valid" : "invalid",
        sha256: hashRecords(catalogRecords),
        skillNames: validation.skillNames,
      };
      if (!validation.ok) {
        conflicts.push({
          code: "CATALOG_INVALID",
          path: catalogDir,
          message: validation.issues
            .map((issue) => `${issue.code}: ${issue.message}`)
            .join("; ")
            .slice(0, 4_000),
        });
      }
    } catch (error) {
      catalog = { status: "invalid", skillNames: [] };
      conflicts.push({
        code: "CATALOG_INVALID",
        path: catalogDir,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    bundle: {
      status: conflicts.some((conflict) =>
        conflict.code === "BUNDLE_SYMLINK" || conflict.code === "BUNDLE_ENTRY_INVALID"
      )
        ? "invalid"
        : "valid",
      sha256: hashRecords(records),
      fileCount: records.length,
    },
    catalog,
    conflicts,
  };
}

function classifyGoalSurface(
  scope: "project" | "user",
  path: string,
  manifest: BundleManifest,
  currentHash: string,
): GoalDiscoveryEntry {
  if (!existsSync(path)) return { scope, path, status: "missing" };
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { scope, path, status: "unknown" };
  }
  if (!stat.isFile()) return { scope, path, status: "unknown" };
  const sha256 = hashFile(path);
  if (!sha256) return { scope, path, status: "unknown" };
  if (sha256 === currentHash) return { scope, path, status: "current", sha256 };
  if (KNOWN_LEGACY_GOAL_HASHES.has(sha256)) {
    return { scope, path, status: "legacy-known", sha256 };
  }
  const recorded = manifest.files[relative(manifest.root, path)];
  if (recorded === sha256) return { scope, path, status: "managed", sha256 };
  return { scope, path, status: "unknown", sha256 };
}

function collectInstructionFiles(directory: string, output: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collectInstructionFiles(path, output);
    else if (entry.isFile() && /\.md$/i.test(entry.name)) output.push(path);
  }
}

function scanInstructionSources(paths: CopilotPaths): InstructionSource[] {
  const candidates = [
    { scope: "project" as const, path: paths.copilotInstructions },
    { scope: "user" as const, path: join(paths.userScope, "copilot-instructions.md") },
  ];
  const projectInstructions: string[] = [];
  const userInstructions: string[] = [];
  collectInstructionFiles(
    join(paths.projectRoot, ".github", "instructions"),
    projectInstructions,
  );
  collectInstructionFiles(join(paths.userScope, "instructions"), userInstructions);
  candidates.push(
    ...projectInstructions.map((path) => ({ scope: "project" as const, path })),
    ...userInstructions.map((path) => ({ scope: "user" as const, path })),
  );

  const inspected: Array<{
    scope: "project" | "user";
    path: string;
    status: "current" | "legacy-goal" | "unreadable";
  }> = [];
  for (const candidate of candidates.sort((left, right) =>
    left.path.localeCompare(right.path))) {
    let fd: number | undefined;
    try {
      // Descriptor-bound read — no exists/lstat then path re-read (CodeQL TOCTOU).
      fd = openSync(
        candidate.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = fstatSync(fd);
      if (!stat.isFile()) {
        inspected.push({ ...candidate, status: "unreadable" });
        continue;
      }
      const content = readFileSync(fd, "utf8");
      const legacyGoal =
        /\bomp\s+goal\s+(?:set|read)\b/i.test(content)
        && !/\bomp\s+goal\b[^\n]*--session-id\b/i.test(content);
      inspected.push({
        ...candidate,
        status: legacyGoal ? "legacy-goal" : "current",
      });
    } catch (error) {
      // Missing paths are skipped (same as the old existsSync filter). Other
      // open failures stay visible as unreadable.
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") continue;
      inspected.push({ ...candidate, status: "unreadable" });
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }
  return inspected;
}

function prepareBundleInstall(
  paths: CopilotPaths,
  scope: "project" | "user",
): InstallPreparation {
  const bundleValidation = validateBundle(paths);
  const conflicts = [...bundleValidation.conflicts];
  scanInstallTarget(skillsTargetFor(paths, scope), conflicts);
  scanInstallTarget(agentsTargetFor(paths, scope), conflicts);
  const userManifest = loadBundleManifest(paths, "user");
  const projectManifest = loadBundleManifest(paths, "project");
  const manifest = scope === "user" ? userManifest : projectManifest;
  const goalSource = join(paths.pluginRoot, ".github", "skills", "goal", "SKILL.md");
  const goalDiscovery: GoalDiscoveryEntry[] = [];
  const trustedOverwriteTargets = new Set<string>();
  const protectedTargets = new Set<string>();
  let effectiveGoalPath: string | undefined;

  if (existsSync(goalSource)) {
    const currentHash = hashFile(goalSource) ?? "";
    const projectGoal = join(paths.projectScopeSkills, "goal", "SKILL.md");
    const userGoal = join(paths.userScopeSkills, "goal", "SKILL.md");
    goalDiscovery.push(
      classifyGoalSurface("project", projectGoal, projectManifest, currentHash),
      classifyGoalSurface("user", userGoal, userManifest, currentHash),
      {
        scope: "bundle",
        path: goalSource,
        status: "current",
        ...(currentHash ? { sha256: currentHash } : {}),
      },
    );
    const effective = goalDiscovery.find((entry) => entry.status !== "missing");
    effectiveGoalPath = effective?.path;
    if (effective?.status === "unknown") {
      conflicts.push({
        code: "UNKNOWN_EFFECTIVE_GOAL",
        path: effective.path,
        message:
          "effective /goal content is unknown and was preserved; move or rename it, "
          + "then rerun setup if you want the bundled workflow (--force will not overwrite it)",
      });
    } else if (
      scope === "user"
      && effective?.scope === "project"
      && effective.status !== "current"
    ) {
      conflicts.push({
        code: "GOAL_SCOPE_MIGRATION_REQUIRED",
        path: effective.path,
        message: "run setup with --scope project to migrate the effective project /goal",
      });
    }

    const target = scope === "user" ? goalDiscovery[1] : goalDiscovery[0];
    if (target?.status === "legacy-known") trustedOverwriteTargets.add(target.path);
    if (target?.status === "unknown") protectedTargets.add(target.path);
  }

  const instructionSources = scanInstructionSources(paths);
  for (const source of instructionSources) {
    if (source.status === "legacy-goal") {
      conflicts.push({
        code: "LEGACY_GOAL_INSTRUCTIONS",
        path: source.path,
        message:
          "instruction source still routes repository objectives through /goal; "
          + "update it to /project-goal or add the required --session-id",
      });
    }
  }

  const validation: SetupValidation = {
    bundle: bundleValidation.bundle,
    catalog: bundleValidation.catalog,
    goalDiscovery,
    ...(effectiveGoalPath ? { effectiveGoalPath } : {}),
    instructionSources,
  };
  manifest.validation = validation;
  return {
    conflicts,
    manifest,
    validation,
    trustedOverwriteTargets,
    protectedTargets,
  };
}

function copyBundledSkillsAndAgents(
  paths: CopilotPaths,
  scope: "project" | "user",
  actions: SetupAction[],
  dryRun: boolean,
  force: boolean,
  preparation: InstallPreparation,
): void {
  const manifest = preparation.manifest;
  const skillsTarget = skillsTargetFor(paths, scope);
  const agentsTarget = agentsTargetFor(paths, scope);
  const bundleSkills = join(paths.pluginRoot, ".github", "skills");
  if (relative(bundleSkills, skillsTarget) !== "") {
    copyDirRecursive(
      bundleSkills,
      skillsTarget,
      actions,
      dryRun,
      force,
      manifest,
      preparation.trustedOverwriteTargets,
      preparation.protectedTargets,
    );
  }
  const bundleAgents = join(paths.pluginRoot, ".github", "agents");
  if (relative(bundleAgents, agentsTarget) !== "") {
    copyDirRecursive(
      bundleAgents,
      agentsTarget,
      actions,
      dryRun,
      force,
      manifest,
      preparation.trustedOverwriteTargets,
      preparation.protectedTargets,
    );
  }
  saveBundleManifest(manifest, dryRun);
}

export function runSetup(options: SetupOptions = {}): SetupResult {
  const paths = resolveCopilotPaths(options);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  // Default user home so setup never pollutes a project unless --scope project.
  const scope = options.scope ?? "user";
  const actions: SetupAction[] = [];
  const preparation = prepareBundleInstall(paths, scope);
  const blocked = hasBlockingConflict(preparation.conflicts);

  if (!blocked) {
    copyBundledSkillsAndAgents(
      paths,
      scope,
      actions,
      dryRun,
      force,
      preparation,
    );

    ensureFile(paths.copilotInstructions, COPILOT_INSTRUCTIONS_TEMPLATE, actions, dryRun);
    ensureDir(paths.stateDir, actions, dryRun);
    installHooks(paths, dryRun, actions);
  }

  return {
    ok: !blocked,
    dryRun,
    scope,
    actions,
    conflicts: preparation.conflicts,
    validation: preparation.validation,
    manifestPath: preparation.manifest.path,
    paths,
  };
}

export function formatSetup(result: SetupResult): string {
  const prefix = result.ok ? (result.dryRun ? "DRY-RUN" : "PASS") : "FAIL";
  const lines = [`${prefix}: omp setup (scope=${result.scope})`];
  for (const conflict of result.conflicts ?? []) {
    lines.push(`  [conflict:${conflict.code}] ${conflict.path}: ${conflict.message}`);
  }
  for (const action of result.actions) {
    lines.push(`  [${action.kind}] ${action.target}`);
  }
  const protectedPaths = new Set(
    (result.conflicts ?? [])
      .filter((conflict) => conflict.code === "UNKNOWN_EFFECTIVE_GOAL")
      .map((conflict) => conflict.path),
  );
  const changed = result.actions.filter(
    (action) => action.kind === "skip-changed" && !protectedPaths.has(action.target),
  ).length;
  if (changed > 0) {
    lines.push(`${changed} bundled file(s) differ from your local copies — re-run with --force to override.`);
  }
  return lines.join("\n");
}

export function formatUserInstallRefreshBlock(conflicts: readonly SetupConflict[]): string {
  const details = conflicts
    .map((conflict) => `[${conflict.code}] ${conflict.path}: ${conflict.message}`)
    .join("; ");
  return `User install refresh blocked by setup safety checks${details ? `: ${details}` : "."} Run \`omp setup --dry-run\` to inspect the migration.`;
}
