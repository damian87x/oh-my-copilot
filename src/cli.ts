#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findCapability, loadCatalogBundle, validateCatalogBundle } from "./catalog.js";
import { inspectProject } from "./project.js";

interface CliResult {
  ok: boolean;
  exitCode?: number;
  output?: unknown;
  message?: string;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function printResult(result: CliResult, json: boolean): void {
  if (json || typeof result.output === "object") {
    console.log(JSON.stringify(result.output ?? { ok: result.ok, message: result.message }, null, 2));
    return;
  }
  if (result.message) {
    console.log(result.message);
  }
}

function help(): string {
  return `oh-my-copilot\n\nRun \`omp\` with no arguments to launch copilot (permissions bypass OFF).\nUse \`omp help\` to show this list.\n\nCommands:\n  (no args)                                     launch copilot (bypass OFF by default)\n  version [--json]\n  list [--json]\n  setup [--dry-run] [--scope project|user] [--plugin-root <dir>] [--json]\n  doctor [--json] [--copilot-bin <path>] [--skip-copilot]\n  launch -- <args...>\n  --madmax [args...]                          (bare-flag launch with permissions bypass; alias of --yolo)\n  team <N:role> "<task>" [--name <name>] [--json]\n  team status <name> [--json]\n  team shutdown <name> [--json]\n  team api claim-task --input '<json>' [--json]\n  team api transition-task-status --input '<json>' [--json]\n  team api send-message --input '<json>' [--json]\n  team api broadcast --input '<json>' [--json]\n  team api mailbox-list --input '<json>' [--json]\n  team api mailbox-mark-delivered --input '<json>' [--json]\n  council "<question>" [--models a,b,c|m:role:weight] [--context <text|@file>] [--rubric <text|@file>] [--synth <model>] [--probe] [--timeout <ms>] [--synth-timeout <ms>] [--min-survivors <n>] [--max-concurrency <n>] [--tmp-dir <dir>] [--json]\n  ralph start "<task>" [--max-iterations <n>] [--session-id <id>] [--json]\n  ralph status [--json]\n  ralph tick [--json]\n  ralph cancel [--json]\n  ultrawork start "<objective>" [--task-count <n>] [--summary <s>] [--json]\n  ultrawork status [--json]\n  ultrawork cancel [--json]\n  ultraqa start "<goal>" [--max-cycles <n>] [--json]\n  ultraqa cycle pass|fail|pending [--json]\n  ultraqa status [--json]\n  ultraqa cancel [--json]\n  goal set "<objective>" [--json]\n  goal read [--json]\n  daily-log set-goal "<text>" [--json]\n  daily-log add "<text>" [--json]\n  daily-log read [--days <n>] [--json]\n  daily-log prune [--keep-days <n>] [--json]\n  state write <key> <val> [--ttl <s>] | read|delete|status <key> | list | cleanup [--json]\n  project-memory read [<id>] | index | add-note "<title>" [--body "<text>"] | add-directive "<rule>" [--json]\n  trace timeline [<sessionId>] [--limit <n>] | summary [<sessionId>] | add <sessionId> <event> [<json>] [--json]\n  catalog list [--json]\n  catalog validate [--json]\n  catalog capability <id> [--json]\n  project inspect [--json]\n  skill install <skill-dir> [--root <repo>] [--scope project|user] [--dry-run] [--json]\n  lint:skills [--root <repo>]\n  sync:dry-run [--root <repo>]\n  jira:dry-run [--root <repo>]\n  jira render <plan-file> [--root <repo>] [--json]\n  jira apply <ticket-key-or-plan-file> --comment|--update|--transition|--link [--dry-run] [--json]\n`;
}

async function resolveExistingInputPath(value: string): Promise<string> {
  const { existsSync } = await import("node:fs");
  const { isAbsolute, resolve } = await import("node:path");
  const direct = isAbsolute(value) ? value : resolve(process.cwd(), value);
  if (existsSync(direct)) return direct;
  const parentRelative = isAbsolute(value) ? value : resolve(process.cwd(), "..", value);
  if (existsSync(parentRelative)) return parentRelative;
  return direct;
}

const BARE_LAUNCH_FLAGS = new Set(["--madmax", "--yolo"]);

export async function runCli(argv = process.argv.slice(2)): Promise<CliResult> {
  const [group, command, value] = argv;
  const json = hasFlag(argv, "--json");

  if (group === "help" || group === "--help" || group === "-h") {
    return { ok: true, message: help() };
  }

  if (group === "version" || group === "--version" || group === "-v") {
    const { getVersionInfo, formatVersionInfo } = await import("./copilot/version.js");
    const info = getVersionInfo({ importMetaUrl: import.meta.url });
    return json ? { ok: true, output: info } : { ok: true, message: formatVersionInfo(info) };
  }

  // Bare `omp` (no subcommand) launches copilot directly with permissions
  // bypass OFF; `omp --madmax`/`--yolo` launch with bypass ON. For the bare
  // case argv is empty, so normalizeCopilotLaunchArgs emits no --yolo.
  if (!group || BARE_LAUNCH_FLAGS.has(group)) {
    const { launchCopilot } = await import("./copilot/launch.js");
    const result = await launchCopilot({
      args: argv,
      bin: flagValue(argv, "--bin"),
      cwd: flagValue(argv, "--root") ?? process.cwd(),
    });
    return json
      ? { ok: result.ok, exitCode: result.exitCode, output: result }
      : {
          ok: result.ok,
          exitCode: result.exitCode,
          message: `launch ${result.bin} exit=${result.exitCode}`,
        };
  }

  if (group === "list") {
    const { listAll, formatList } = await import("./copilot/list.js");
    const list = await listAll({ cwd: flagValue(argv, "--root") ?? process.cwd() });
    return json ? { ok: true, output: list } : { ok: true, message: formatList(list) };
  }

  if (group === "setup") {
    const { runSetup, formatSetup } = await import("./copilot/setup.js");
    const result = runSetup({
      cwd: flagValue(argv, "--root") ?? process.cwd(),
      pluginRoot: flagValue(argv, "--plugin-root"),
      importMetaUrl: import.meta.url,
      dryRun: hasFlag(argv, "--dry-run"),
      scope: flagValue(argv, "--scope") === "user" ? "user" : "project",
    });
    return json ? { ok: result.ok, output: result } : { ok: result.ok, message: formatSetup(result) };
  }

  if (group === "doctor") {
    const { runDoctor, formatDoctor } = await import("./copilot/doctor.js");
    const report = runDoctor({
      cwd: flagValue(argv, "--root") ?? process.cwd(),
      pluginRoot: flagValue(argv, "--plugin-root"),
      importMetaUrl: import.meta.url,
      copilotBin: flagValue(argv, "--copilot-bin"),
      skipCopilot: hasFlag(argv, "--skip-copilot"),
    });
    return json
      ? { ok: report.ok, exitCode: report.ok ? 0 : 1, output: report }
      : { ok: report.ok, exitCode: report.ok ? 0 : 1, message: formatDoctor(report) };
  }

  if (group === "launch") {
    const dashIndex = argv.indexOf("--");
    const passthrough = dashIndex >= 0 ? argv.slice(dashIndex + 1) : argv.slice(1);
    const { launchCopilot } = await import("./copilot/launch.js");
    const result = await launchCopilot({
      args: passthrough,
      bin: flagValue(argv, "--bin"),
      cwd: flagValue(argv, "--root") ?? process.cwd(),
    });
    return json
      ? { ok: result.ok, exitCode: result.exitCode, output: result }
      : {
          ok: result.ok,
          exitCode: result.exitCode,
          message: `launch ${result.bin} exit=${result.exitCode}`,
        };
  }

  if (group === "team") {
    return await handleTeamCommand(argv, json);
  }

  if (group === "council") {
    return await handleCouncilCommand(argv, json);
  }

  if (group === "ralph") {
    return await handleModeCommand("ralph", argv, json);
  }
  if (group === "ultrawork") {
    return await handleModeCommand("ultrawork", argv, json);
  }
  if (group === "ultraqa") {
    return await handleModeCommand("ultraqa", argv, json);
  }

  if (group === "goal") {
    const { readRepoGoal, writeRepoGoal } = await import("./goal.js");
    const cwd = flagValue(argv, "--root") ?? process.cwd();
    if (command === "set") {
      if (!value || !value.trim() || value.startsWith("-")) {
        return { ok: false, exitCode: 1, message: 'usage: omp goal set "<objective>"' };
      }
      const goal = writeRepoGoal(cwd, value);
      return json ? { ok: true, output: { ok: true, goal } } : { ok: true, message: `repo goal set: ${goal}` };
    }
    if (command === "read" || command === undefined) {
      const goal = readRepoGoal(cwd);
      return json ? { ok: true, output: { goal } } : { ok: true, message: goal || "(no repo goal set)" };
    }
    return { ok: false, exitCode: 1, message: 'Unknown goal subcommand. Try: goal set "<text>" | goal read' };
  }

  if (group === "daily-log") {
    const { setDailyGoal, addLogEntry, readDailyLog, pruneDailyLog } = await import("./daily-log.js");
    const cwd = flagValue(argv, "--root") ?? process.cwd();
    if (command === "set-goal") {
      if (!value || !value.trim() || value.startsWith("-")) {
        return { ok: false, exitCode: 1, message: 'usage: omp daily-log set-goal "<text>"' };
      }
      const res = setDailyGoal(cwd, value);
      return json ? { ok: true, output: { ok: true, ...res } } : { ok: true, message: `daily goal set (${res.date}): ${res.goal}` };
    }
    if (command === "add") {
      if (!value || !value.trim() || value.startsWith("-")) {
        return { ok: false, exitCode: 1, message: 'usage: omp daily-log add "<text>"' };
      }
      const res = addLogEntry(cwd, value);
      return json ? { ok: true, output: { ok: true, ...res } } : { ok: true, message: `logged (${res.date}); ${res.count} entr${res.count === 1 ? "y" : "ies"} today` };
    }
    if (command === "read" || command === undefined) {
      const daysRaw = flagValue(argv, "--days");
      const days = daysRaw !== undefined && Number.isFinite(Number(daysRaw)) ? Number(daysRaw) : 1;
      const text = readDailyLog(cwd, days);
      return json ? { ok: true, output: { log: text } } : { ok: true, message: text || "(no daily log entries)" };
    }
    if (command === "prune") {
      const keepRaw = flagValue(argv, "--keep-days");
      const keepDays = keepRaw !== undefined && Number.isFinite(Number(keepRaw)) ? Number(keepRaw) : 30;
      const removed = pruneDailyLog(cwd, keepDays);
      return json
        ? { ok: true, output: { removed } }
        : { ok: true, message: `pruned ${removed.length} day-file(s) older than ${keepDays}d` };
    }
    return {
      ok: false,
      exitCode: 1,
      message: 'Unknown daily-log subcommand. Try: daily-log set-goal "<text>" | add "<text>" | read [--days N] | prune [--keep-days N]',
    };
  }

  if (group === "state") {
    const s = await import("./state.js");
    const cwd = flagValue(argv, "--root") ?? process.cwd();
    if (command === "read" && value) {
      return { ok: true, output: s.stateRead(cwd, value) };
    }
    if (command === "write" && value) {
      const raw = argv[3];
      if (raw === undefined) return { ok: false, exitCode: 1, message: "usage: omp state write <key> <json-or-string> [--ttl <sec>]" };
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      const ttlRaw = flagValue(argv, "--ttl");
      const ttl = ttlRaw !== undefined && Number.isFinite(Number(ttlRaw)) ? Number(ttlRaw) : undefined;
      const expiresAt = s.stateWrite(cwd, value, parsed, ttl);
      return json ? { ok: true, output: { ok: true, expiresAt } } : { ok: true, message: `wrote ${value}${expiresAt ? ` (expires ${expiresAt})` : ""}` };
    }
    if (command === "delete" && value) {
      s.stateDelete(cwd, value);
      return { ok: true, message: `deleted ${value}` };
    }
    if (command === "list") {
      return { ok: true, output: { keys: s.stateList(cwd) } };
    }
    if (command === "cleanup") {
      const deleted = s.stateCleanup(cwd);
      return json ? { ok: true, output: { deleted } } : { ok: true, message: `cleaned ${deleted} expired` };
    }
    if (command === "status" && value) {
      return { ok: true, output: s.stateStatus(cwd, value) };
    }
    return { ok: false, exitCode: 1, message: "Unknown state subcommand. Try: state read <key> | write <key> <val> [--ttl s] | delete <key> | list | cleanup | status <key>" };
  }

  if (group === "project-memory") {
    const pm = await import("./project-memory.js");
    const cwd = flagValue(argv, "--root") ?? process.cwd();
    if (command === "add-note") {
      // Accept either a positional title or a --title flag (the model often
      // mirrors --body and writes --title); reject a stray flag as the title.
      const title = flagValue(argv, "--title") ?? (value && !value.startsWith("-") ? value : undefined);
      if (!title || !title.trim()) {
        return { ok: false, exitCode: 1, message: 'usage: omp project-memory add-note "<title>" [--body "<text>"]' };
      }
      const id = pm.addNote(cwd, title, flagValue(argv, "--body"));
      return json ? { ok: true, output: { ok: true, id } } : { ok: true, message: `note added: ${id}` };
    }
    if (command === "add-directive") {
      const directive = flagValue(argv, "--directive") ?? (value && !value.startsWith("-") ? value : undefined);
      if (!directive || !directive.trim()) {
        return { ok: false, exitCode: 1, message: 'usage: omp project-memory add-directive "<rule>"' };
      }
      const count = pm.addDirective(cwd, directive);
      return json ? { ok: true, output: { ok: true, count } } : { ok: true, message: `directive added (${count} total)` };
    }
    if (command === "index") {
      return { ok: true, output: { notes: pm.noteIndex(cwd) } };
    }
    if (command === "read" || command === undefined) {
      // `read <id>` loads one note's body on demand; bare `read` returns the
      // bounded summary (directives + note index — never note bodies).
      if (value && !value.startsWith("-")) {
        const note = pm.readNote(cwd, value);
        if (note === null) return { ok: false, exitCode: 1, message: `no note with id: ${value}` };
        return { ok: true, message: note };
      }
      return { ok: true, output: { directives: pm.readDirectives(cwd), notes: pm.noteIndex(cwd) } };
    }
    return {
      ok: false,
      exitCode: 1,
      message: 'Unknown project-memory subcommand. Try: project-memory read [<id>] | index | add-note "<title>" [--body "<text>"] | add-directive "<rule>"',
    };
  }

  if (group === "trace") {
    const tr = await import("./trace.js");
    const cwd = flagValue(argv, "--root") ?? process.cwd();
    const sid = value && !value.startsWith("-") ? value : undefined;
    if (command === "timeline" || command === undefined) {
      const limitRaw = flagValue(argv, "--limit");
      const limit = limitRaw !== undefined && Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 50;
      return { ok: true, output: tr.traceTimeline(cwd, sid, limit) };
    }
    if (command === "summary") {
      return { ok: true, output: tr.traceSummary(cwd, sid) };
    }
    if (command === "add" && sid) {
      const event = argv[3];
      if (!event) return { ok: false, exitCode: 1, message: "usage: omp trace add <sessionId> <event> [json-payload]" };
      const payloadRaw = argv[4];
      let payload: unknown;
      if (payloadRaw !== undefined) {
        try {
          payload = JSON.parse(payloadRaw);
        } catch {
          payload = payloadRaw;
        }
      }
      tr.appendTraceEntry(cwd, sid, { event, payload });
      return { ok: true, message: `trace appended to ${sid}` };
    }
    return { ok: false, exitCode: 1, message: "Unknown trace subcommand. Try: trace timeline [sessionId] [--limit N] | summary [sessionId] | add <sessionId> <event> [json]" };
  }

  if (group === "catalog") {
    if (command === "list") {
      const bundle = loadCatalogBundle();
      const output = bundle.capabilities.capabilities
        .filter((capability) => capability.phase1)
        .map((capability) => ({
          id: capability.id,
          command: `/${capability.defaultCommand}`,
          category: capability.category,
          phase1: capability.phase1,
          copilot: capability.providerSupport.copilot.state,
        }));
      return json ? { ok: true, output } : { ok: true, message: output.map((item) => `${item.id}\t${item.command}\t${item.copilot}`).join("\n") };
    }

    if (command === "validate") {
      const result = validateCatalogBundle();
      return {
        ok: result.ok,
        exitCode: result.ok ? 0 : 1,
        output: json ? result : undefined,
        message: result.ok ? "Catalog validation PASS" : `Catalog validation FAIL (${result.issues.length} issue(s))`,
      };
    }

    if (command === "capability" && value) {
      const capability = findCapability(value);
      if (!capability) {
        return { ok: false, exitCode: 1, output: json ? { ok: false, error: `Unknown capability: ${value}` } : undefined, message: `Unknown capability: ${value}` };
      }
      return json ? { ok: true, output: capability } : { ok: true, message: `${capability.id}: ${capability.summary}` };
    }
  }

  if (group === "project" && command === "inspect") {
    const output = inspectProject();
    return json ? { ok: true, output } : { ok: true, message: `packageRoot=${output.packageRoot}\nskillsRoot=${output.defaultSkillsRoot}\nhasCatalog=${output.hasCatalog}` };
  }

  if (group === "skill" && command === "install" && value) {
    const { installSkill, formatSkillInstall } = await import("./skills.js");
    try {
      const result = installSkill({
        cwd: process.cwd(),
        root: flagValue(argv, "--root"),
        source: value,
        scope: flagValue(argv, "--scope") === "user" ? "user" : "project",
        dryRun: hasFlag(argv, "--dry-run"),
      });
      return json ? { ok: true, output: result } : { ok: true, message: formatSkillInstall(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, exitCode: 1, output: json ? { ok: false, error: message } : undefined, message };
    }
  }

  if (group === "lint:skills") {
    const { lintSkills, formatLintIssues } = await import("./lint.js");
    const issues = lintSkills(flagValue(argv, "--root"));
    const ok = issues.filter((issue) => issue.level === "error").length === 0;
    return { ok, exitCode: ok ? 0 : 1, message: formatLintIssues(issues) };
  }

  if (group === "sync:dry-run") {
    const { formatDryRun } = await import("./sync.js");
    return { ok: true, message: formatDryRun() };
  }

  if (group === "jira:dry-run") {
    const jira = await import("./jira.js") as unknown as Record<string, any>;
    const config = typeof jira.discoverJiraConfig === "function" ? jira.discoverJiraConfig({ cwd: flagValue(argv, "--root") ?? process.cwd() }) : undefined;
    if (typeof jira.formatJiraDryRun === "function") {
      return { ok: true, message: jira.formatJiraDryRun(config) as string };
    }
    const payloads = [
      typeof jira.createIssuePayload === "function" ? jira.createIssuePayload(config, { summary: "Phase 1 MVP tracking ticket", description: "Prepared by oh-my-copilot dry-run adapter." }) : undefined,
      typeof jira.commentPayload === "function" ? jira.commentPayload(config, "<ISSUE-KEY>", "Verification evidence goes here.") : undefined,
      typeof jira.safeUpdatePayload === "function" ? jira.safeUpdatePayload(config, "<ISSUE-KEY>", { labels: ["oh-my-copilot"] }) : undefined,
    ].filter(Boolean);
    return { ok: true, message: `PASS: Jira dry-run fallback payloads\n${JSON.stringify(payloads, null, 2)}` };
  }

  if (group === "jira") {
    const jira = await import("./jira.js");
    const root = flagValue(argv, "--root") ?? process.cwd();
    const config = jira.discoverJiraConfig({ cwd: root });

    if (command === "render" && value) {
      const inputPath = await resolveExistingInputPath(value);
      const ticket = jira.readTicketInput(inputPath);
      const output = {
        ok: true,
        dryRun: true,
        source: inputPath,
        jira: jira.configSummary(config),
        operations: {
          create: jira.createIssuePayload(config, ticket),
          comment: jira.commentPayload(config, "<ISSUE-KEY>", `Planning source: ${inputPath}\n\n${ticket.summary}`),
          update: jira.safeUpdatePayload(config, "<ISSUE-KEY>", ticket),
          transition: jira.transitionFallbackPayload(config, "<ISSUE-KEY>", "planned"),
          link: jira.linkFallbackPayload(config, "<ISSUE-KEY>", "<RELATED-ISSUE-KEY>"),
        },
      };
      return json ? { ok: true, output } : { ok: true, message: JSON.stringify(output, null, 2) };
    }

    if (command === "apply" && value) {
      const operation = hasFlag(argv, "--comment")
        ? "comment"
        : hasFlag(argv, "--update")
          ? "update"
          : hasFlag(argv, "--transition")
            ? "transition"
            : hasFlag(argv, "--link")
              ? "link"
              : "create";
      const isFileInput = /\.[a-z0-9]+$/i.test(value);
      const inputPath = isFileInput ? await resolveExistingInputPath(value) : undefined;
      const ticket = inputPath ? jira.readTicketInput(inputPath) : undefined;
      if (operation === "link" && !flagValue(argv, "--link-target")) {
        return { ok: false, exitCode: 1, output: json ? { ok: false, error: "jira apply --link requires --link-target <issue-key>" } : undefined, message: "jira apply --link requires --link-target <issue-key>" };
      }
      if (operation === "create" && !ticket) {
        return { ok: false, exitCode: 1, output: json ? { ok: false, error: "jira apply create requires a readable plan/ticket file" } : undefined, message: "jira apply create requires a readable plan/ticket file" };
      }
      const result = await jira.applyJiraOperation({
        operation,
        target: inputPath ? undefined : value,
        ticket,
        comment: ticket ? ticket.summary : "Verification evidence goes here.",
        update: ticket,
        transitionState: flagValue(argv, "--state") ?? "done",
        linkTarget: flagValue(argv, "--link-target"),
        dryRun: hasFlag(argv, "--dry-run") || config.mode !== "live",
      }, config);
      return json ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result } : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result, null, 2) };
    }
  }

  return { ok: false, exitCode: 1, message: `Unknown command.\n\n${help()}` };
}

const DEFAULT_COUNCIL_ROLES = ["critic", "architect", "pragmatist"];

/** Parse a --models value: comma-separated `model` or `model:role:weight` tokens. */
export function parseModelsFlag(
  value: string,
): { model: string; role: string; weight: number }[] {
  const tokens = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    throw new Error("--models was empty");
  }
  return tokens.map((token, i) => {
    const parts = token.split(":");
    const model = parts[0].trim();
    if (!model) throw new Error(`--models token "${token}" has no model`);
    const role = parts[1]?.trim() || DEFAULT_COUNCIL_ROLES[i % DEFAULT_COUNCIL_ROLES.length];
    let weight = 1;
    if (parts[2] !== undefined) {
      const w = Number(parts[2]);
      if (!Number.isFinite(w) || w <= 0) {
        throw new Error(`--models token "${token}" has invalid weight`);
      }
      weight = w;
    }
    return { model, role, weight };
  });
}

/** Parse a numeric flag as a finite positive integer; throw on malformed input. */
export function parsePositiveIntFlag(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid ${flag}: expected a positive integer, got "${value}"`);
  }
  return n;
}

async function readFlagOrFile(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  if (value.startsWith("@")) {
    const { readFileSync } = await import("node:fs");
    const path = await resolveExistingInputPath(value.slice(1));
    return readFileSync(path, "utf8");
  }
  return value;
}

async function handleCouncilCommand(argv: string[], json: boolean): Promise<CliResult> {
  const question = argv[1] && !argv[1].startsWith("--") ? argv[1] : undefined;
  if (!question) {
    return { ok: false, exitCode: 1, message: 'council requires a question: omp council "<question>" [flags]' };
  }

  let members;
  try {
    const modelsFlag = flagValue(argv, "--models");
    members = modelsFlag ? parseModelsFlag(modelsFlag) : undefined;
  } catch (err) {
    return { ok: false, exitCode: 1, message: `Invalid --models: ${String(err)}` };
  }

  const context = await readFlagOrFile(flagValue(argv, "--context"));
  const rubric = await readFlagOrFile(flagValue(argv, "--rubric"));

  let perMemberTimeoutMs: number | undefined;
  let synthTimeoutMs: number | undefined;
  let minSurvivors: number | undefined;
  let maxConcurrency: number | undefined;
  try {
    perMemberTimeoutMs = parsePositiveIntFlag(flagValue(argv, "--timeout"), "--timeout");
    synthTimeoutMs = parsePositiveIntFlag(flagValue(argv, "--synth-timeout"), "--synth-timeout");
    minSurvivors = parsePositiveIntFlag(flagValue(argv, "--min-survivors"), "--min-survivors");
    maxConcurrency = parsePositiveIntFlag(flagValue(argv, "--max-concurrency"), "--max-concurrency");
  } catch (err) {
    return { ok: false, exitCode: 1, message: String(err instanceof Error ? err.message : err) };
  }

  // Only set probe when the flag is present, so `council.probe` from config
  // takes effect (precedence: spec.probe ?? config.probe ?? false).
  const probe = hasFlag(argv, "--probe") ? true : undefined;

  const { runCouncilWithDefaults } = await import("./council/index.js");
  const result = await runCouncilWithDefaults(
    {
      question,
      context,
      rubric,
      rolePack: flagValue(argv, "--role-pack"),
      members,
      synthesizerModel: flagValue(argv, "--synth"),
      probe,
      perMemberTimeoutMs,
      synthTimeoutMs,
      minSurvivors,
      maxConcurrency,
      tmpDir: flagValue(argv, "--tmp-dir"),
    },
    {
      cwd: flagValue(argv, "--root") ?? process.cwd(),
      bin: flagValue(argv, "--bin"),
      onProgress: json ? undefined : (msg: string) => process.stderr.write(`${msg}\n`),
    },
  );

  if (json) {
    return { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result };
  }

  const lines: string[] = [];
  if (result.ok && result.synth) {
    lines.push(`Verdict: ${result.synth.verdict}`);
    lines.push(`Confidence: ${result.synth.confidence}`);
    lines.push(`Rationale: ${result.synth.rationale}`);
    if (result.synth.minority_report) {
      lines.push(`Minority report: ${result.synth.minority_report}`);
    }
    lines.push(`Members: ${result.survivors} survived, ${result.dropped} dropped`);
  } else {
    lines.push(`Council failed: ${result.error ?? "unknown error"}`);
  }
  for (const m of result.members) {
    if (m.status !== "ok") {
      lines.push(`  - dropped ${m.spec.model} (${m.spec.role}): ${m.status} — ${m.dropReason ?? ""}`);
    }
  }
  lines.push(`Artifacts: ${result.tmpDir}`);
  return { ok: result.ok, exitCode: result.ok ? 0 : 1, message: lines.join("\n") };
}

const TEAM_SPEC_RE = /^(\d+):([\w-]+)$/;

async function handleTeamCommand(argv: string[], json: boolean): Promise<CliResult> {
  const [, command, value, extra] = argv;
  const cwd = flagValue(argv, "--root") ?? process.cwd();

  if (command && TEAM_SPEC_RE.test(command)) {
    const match = command.match(TEAM_SPEC_RE)!;
    const workerCount = Number(match[1]);
    const role = match[2]!;
    if (!value) {
      return { ok: false, exitCode: 1, message: "team <N:role> requires a task description" };
    }
    const name = flagValue(argv, "--name") ?? `${role}-${Date.now().toString(36)}`;
    const { startTeam } = await import("./team/runtime.js");
    try {
      const result = await startTeam({ cwd, name, role, workerCount, task: value });
      return json
        ? { ok: true, output: result }
        : {
            ok: true,
            message: `started team ${name} session=${result.tmuxSession} workers=${result.config.workers
              .map((w) => `${w.name}(${w.paneId ?? "?"})`)
              .join(",")}`,
          };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, exitCode: 1, output: json ? { ok: false, error: message } : undefined, message };
    }
  }

  if (command === "status" && value) {
    const { statusTeam, formatStatus } = await import("./team/runtime.js");
    const report = statusTeam({ cwd, name: value });
    return json
      ? { ok: report.ok, output: report }
      : { ok: report.ok, message: formatStatus(report) };
  }

  if (command === "shutdown" && value) {
    const { shutdownTeam } = await import("./team/runtime.js");
    const result = await shutdownTeam({ cwd, name: value });
    return json
      ? { ok: result.ok, output: result }
      : {
          ok: result.ok,
          message: `shutdown team ${value} killedPanes=${result.killedPanes} killedSession=${result.killedSession}`,
        };
  }

  if (command === "api") {
    const sub = value;
    const inputRaw = flagValue(argv, "--input");
    if (!sub || !inputRaw) {
      return { ok: false, exitCode: 1, message: "team api <sub> --input '<json>' required" };
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(inputRaw) as Record<string, unknown>;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, exitCode: 1, message: `invalid --input JSON: ${message}` };
    }
    const api = await import("./team/api.js");
    if (sub === "claim-task") {
      const result = api.apiClaimTask(input as never);
      return json
        ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result }
        : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result) };
    }
    if (sub === "transition-task-status") {
      const result = api.apiTransitionTaskStatus(input as never);
      return json
        ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result }
        : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result) };
    }
    if (sub === "send-message") {
      const result = await api.apiSendMessage(input as never);
      return json
        ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result }
        : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result) };
    }
    if (sub === "broadcast") {
      const result = await api.apiBroadcast(input as never);
      return json
        ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result }
        : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result) };
    }
    if (sub === "mailbox-list") {
      const result = api.apiMailboxList(input as never);
      return json
        ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result }
        : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result) };
    }
    if (sub === "mailbox-mark-delivered") {
      const result = api.apiMailboxMarkDelivered(input as never);
      return json
        ? { ok: result.ok, exitCode: result.ok ? 0 : 1, output: result }
        : { ok: result.ok, exitCode: result.ok ? 0 : 1, message: JSON.stringify(result) };
    }
    return { ok: false, exitCode: 1, message: `Unknown team api command: ${sub}` };
  }

  // tolerate trailing extras (e.g., '--json')
  void extra;
  return { ok: false, exitCode: 1, message: `Unknown team command. Try: omp team <N:role> "<task>" | status <name> | shutdown <name> | api <sub>` };
}

type LoopMode = "ralph" | "ultrawork" | "ultraqa";

async function handleModeCommand(mode: LoopMode, argv: string[], json: boolean): Promise<CliResult> {
  const [, command, value] = argv;
  const cwd = flagValue(argv, "--root") ?? process.cwd();
  const sessionId = flagValue(argv, "--session-id");

  if (mode === "ralph") {
    const mod = await import("./mode-state/ralph.js");
    if (command === "start" && value) {
      const max = flagValue(argv, "--max-iterations");
      const state = mod.startRalph({
        cwd,
        prompt: value,
        sessionId,
        maxIterations: max ? Number(max) : undefined,
      });
      return json ? { ok: true, output: state } : { ok: true, message: `ralph started iter=0/${state.maxIterations}` };
    }
    if (command === "status") {
      const state = mod.readRalph(cwd);
      return json
        ? { ok: !!state, output: state ?? { active: false } }
        : {
            ok: !!state,
            message: state
              ? `ralph active iter=${state.iteration}/${state.maxIterations} prompt=${state.prompt}`
              : "ralph inactive",
          };
    }
    if (command === "cancel") {
      mod.cancelRalph(cwd);
      return json ? { ok: true, output: { cancelled: true } } : { ok: true, message: "ralph cancelled" };
    }
    if (command === "tick") {
      const result = mod.tickRalph(cwd);
      return json
        ? { ok: result.ok, output: result }
        : {
            ok: result.ok,
            message: result.ok
              ? `ralph tick → iter=${result.state?.iteration}/${result.state?.maxIterations}`
              : `ralph tick failed: ${result.reason}`,
          };
    }
  }

  if (mode === "ultrawork") {
    const mod = await import("./mode-state/ultrawork.js");
    if (command === "start" && value) {
      const taskCount = flagValue(argv, "--task-count");
      const summary = flagValue(argv, "--summary");
      const state = mod.startUltrawork({
        cwd,
        objective: value,
        taskCount: taskCount ? Number(taskCount) : undefined,
        taskSummary: summary,
        sessionId,
      });
      return json ? { ok: true, output: state } : { ok: true, message: `ultrawork started: ${state.objective}` };
    }
    if (command === "status") {
      const state = mod.readUltrawork(cwd);
      return json
        ? { ok: !!state, output: state ?? { active: false } }
        : { ok: !!state, message: state ? `ultrawork active: ${state.objective}` : "ultrawork inactive" };
    }
    if (command === "cancel") {
      mod.cancelUltrawork(cwd);
      return json ? { ok: true, output: { cancelled: true } } : { ok: true, message: "ultrawork cancelled" };
    }
  }

  if (mode === "ultraqa") {
    const mod = await import("./mode-state/ultraqa.js");
    if (command === "start" && value) {
      const max = flagValue(argv, "--max-cycles");
      const state = mod.startUltraqa({
        cwd,
        goal: value,
        maxCycles: max ? Number(max) : undefined,
        sessionId,
      });
      return json ? { ok: true, output: state } : { ok: true, message: `ultraqa started cycle=0/${state.maxCycles}` };
    }
    if (command === "status") {
      const state = mod.readUltraqa(cwd);
      return json
        ? { ok: !!state, output: state ?? { active: false } }
        : {
            ok: !!state,
            message: state
              ? `ultraqa active cycle=${state.cycleCount}/${state.maxCycles} verdict=${state.lastVerdict ?? "pending"}`
              : "ultraqa inactive",
          };
    }
    if (command === "cancel") {
      mod.cancelUltraqa(cwd);
      return json ? { ok: true, output: { cancelled: true } } : { ok: true, message: "ultraqa cancelled" };
    }
    if (command === "cycle" && value) {
      if (value !== "pass" && value !== "fail" && value !== "pending") {
        return { ok: false, exitCode: 1, message: `ultraqa cycle expects pass|fail|pending, got ${value}` };
      }
      const result = mod.recordUltraqaCycle(cwd, value);
      return json
        ? { ok: result.ok, output: result }
        : {
            ok: result.ok,
            message: result.ok
              ? `ultraqa cycle → ${result.state?.cycleCount}/${result.state?.maxCycles} verdict=${result.state?.lastVerdict}`
              : `ultraqa cycle: ${result.reason}`,
          };
    }
  }

  return {
    ok: false,
    exitCode: 1,
    message: `Unknown ${mode} subcommand. Try: ${mode} start "<task>" | status | cancel${mode === "ralph" ? " | tick" : ""}${mode === "ultraqa" ? " | cycle pass|fail|pending" : ""}`,
  };
}

function isEntrypoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  if (import.meta.url === pathToFileURL(argv1).href) return true;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const result = await runCli();
  printResult(result, process.argv.includes("--json"));
  process.exitCode = result.exitCode ?? (result.ok ? 0 : 1);
}
