#!/usr/bin/env node
// Skill performance benchmark for oh-my-copilot.
//
// Runs each problem across one or more modes (e.g. skills hidden vs enabled),
// scores the result deterministically, and writes a JSON + Markdown report.
//
// Usage:
//   node tools/bench/bench-skills.mjs [--config tools/bench/bench.config.json]
//                                     [--problems P1,P2] [--modes no-skills,with-skills]
//                                     [--runs N] [--model M] [--dry-run] [--out DIR]
//
// Headless contract: spawn(copilotBin, ["--model", M, "-p", prompt, "--allow-all-tools?"]).
// "Skills hidden" baseline: temporarily renames .github/skills + ~/.copilot/skills
// out of the way for the duration of that cell, then restores them (always, even
// on crash) so Copilot cannot discover any skill. This is the only honest way to
// measure "without skills" without a separate clean install.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync, cpSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");

// ---------- arg parsing ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));

function die(msg) { console.error(`bench: ${msg}`); process.exit(1); }

// ---------- config ----------
const configPath = resolve(args.config || join(__dirname, "bench.config.json"));
if (!existsSync(configPath)) die(`config not found: ${configPath}`);
const cfg = JSON.parse(readFileSync(configPath, "utf8"));

const copilotBin = process.env.OMP_COPILOT_BIN || cfg.copilotBin || "copilot";
const model = args.model || cfg.model || "claude-sonnet-4.5";
const runsPerCell = Number(args.runs || cfg.runsPerCell || 1);
const timeoutMs = Number(cfg.timeoutMs || 600000);
const allowAllTools = cfg.allowAllTools !== false;
const dryRun = Boolean(args["dry-run"]);
const problemsDir = resolve(dirname(configPath), cfg.problemsDir || "problems");
const artifactBase = resolve(REPO_ROOT, cfg.artifactDir || ".omp/state/bench");

// ---------- load problems ----------
function loadProblems() {
  let problems = Array.isArray(cfg.problems) ? [...cfg.problems] : [];
  if (problems.length === 0 && existsSync(problemsDir)) {
    for (const entry of readdirSync(problemsDir)) {
      const f = join(problemsDir, entry, "problem.json");
      if (existsSync(f)) problems.push(JSON.parse(readFileSync(f, "utf8")));
    }
  }
  // problem.prompt may live in a sibling prompt.md
  for (const p of problems) {
    if (!p.prompt && p.id) {
      const pf = join(problemsDir, p.id, "prompt.md");
      if (existsSync(pf)) p.prompt = readFileSync(pf, "utf8").trim();
    }
  }
  problems.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return problems;
}

let problems = loadProblems();
if (args.problems) {
  const want = new Set(String(args.problems).split(","));
  problems = problems.filter((p) => want.has(p.id));
}
if (problems.length === 0) die(`no problems found (dir: ${problemsDir})`);

let modes = cfg.modes || [];
if (args.modes) {
  const want = new Set(String(args.modes).split(","));
  modes = modes.filter((m) => want.has(m.id));
}
if (modes.length === 0) die("no modes selected");

// ---------- skill hiding (baseline) ----------
const SKILL_DIRS = [
  join(REPO_ROOT, ".github", "skills"),
  join(homedir(), ".copilot", "skills"),
];
function hideSkills() {
  const moved = [];
  for (const d of SKILL_DIRS) {
    if (existsSync(d)) {
      const parked = `${d}.bench-hidden-${process.pid}`;
      renameSync(d, parked);
      moved.push([d, parked]);
    }
  }
  return moved;
}
function restoreSkills(moved) {
  for (const [orig, parked] of moved) {
    try {
      if (existsSync(orig)) rmSync(orig, { recursive: true, force: true });
      if (existsSync(parked)) renameSync(parked, orig);
    } catch (e) { console.error(`bench: WARNING failed to restore ${orig}: ${e.message}`); }
  }
}

// ---------- run one copilot cell ----------
function runCopilot({ prompt, cwd, env }) {
  const cliArgs = ["--model", model, "-p", prompt];
  if (allowAllTools) cliArgs.push("--allow-all-tools");
  const started = Date.now();
  if (dryRun) {
    return Promise.resolve({
      exitCode: 0, timedOut: false, durationMs: 0,
      stdout: `[dry-run] ${copilotBin} ${cliArgs.map((a) => (a === prompt ? `"<prompt ${prompt.length} chars>"` : a)).join(" ")}`,
      stderr: "",
    });
  }
  return new Promise((resolveFn) => {
    const child = spawn(copilotBin, cliArgs, {
      cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const timer = setTimeout(() => {
      timedOut = true; child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const finish = (exitCode) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolveFn({ exitCode, timedOut, durationMs: Date.now() - started, stdout, stderr });
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(typeof code === "number" ? code : 1));
  });
}

// ---------- scoring ----------
function countToolCalls(transcript) {
  // Copilot CLI prints tool invocations; count common markers conservatively.
  const m = transcript.match(/(?:Tool call|Running tool|» |\bbash\b\(|\bstr_replace\b|\bcreate\b\()/g);
  return m ? m.length : 0;
}
function runCheck(check, ctx) {
  const t = ctx.transcript;
  const weight = check.weight ?? 1;
  let pass = false, detail = "";
  switch (check.type) {
    case "transcript_contains": pass = t.includes(check.value); break;
    case "transcript_not_contains": pass = !t.includes(check.value); break;
    case "transcript_regex": pass = new RegExp(check.value, "m").test(t); break;
    case "exit_zero": pass = ctx.exitCode === 0; break;
    case "file_exists": pass = existsSync(join(ctx.cwd, check.path)); break;
    case "file_contains": {
      const fp = join(ctx.cwd, check.path);
      pass = existsSync(fp) && readFileSync(fp, "utf8").includes(check.value); break;
    }
    case "shell_exit_zero": {
      const r = spawnSync("bash", ["-lc", check.value], { cwd: ctx.cwd, encoding: "utf8", timeout: 60000 });
      pass = r.status === 0; detail = (r.stderr || r.stdout || "").slice(-200); break;
    }
    case "max_tool_calls": pass = countToolCalls(t) <= (check.max ?? 999); detail = `tool_calls=${countToolCalls(t)}`; break;
    default: detail = `unknown check type ${check.type}`;
  }
  return { type: check.type, label: check.label || check.type, value: check.value ?? check.path ?? check.max, weight, pass, detail };
}
function scoreProblem(problem, ctx) {
  const checks = (problem.checks || []).map((c) => runCheck(c, ctx));
  const totalW = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const gotW = checks.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const score = checks.length ? Math.round((gotW / totalW) * 100) : (ctx.exitCode === 0 ? 100 : 0);
  return { checks, score, passed: checks.every((c) => c.pass) };
}

// ---------- main ----------
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(args.out || join(artifactBase, `run-${stamp}`));
mkdirSync(outDir, { recursive: true });

console.log(`bench: ${problems.length} problem(s) × ${modes.length} mode(s) × ${runsPerCell} run(s)`);
console.log(`bench: model=${model} bin=${copilotBin} dryRun=${dryRun}`);
console.log(`bench: artifacts → ${outDir}\n`);

const results = [];
for (const mode of modes) {
  let moved = [];
  if (mode.skills === false && !dryRun) moved = hideSkills();
  try {
    for (const problem of problems) {
      // each problem gets an isolated workdir copy if a fixture dir exists
      const fixtureDir = join(problemsDir, problem.id, "fixture");
      for (let run = 0; run < runsPerCell; run++) {
        const cellId = `${problem.id}__${mode.id}__r${run}`;
        const cwd = join(outDir, "work", cellId);
        mkdirSync(cwd, { recursive: true });
        if (existsSync(fixtureDir)) cpSync(fixtureDir, cwd, { recursive: true });
        if (problem.setup && !dryRun) {
          spawnSync("bash", ["-lc", problem.setup], { cwd, encoding: "utf8", timeout: 120000 });
        }
        process.stdout.write(`  ${cellId} ... `);
        const r = await runCopilot({
          prompt: problem.prompt, cwd,
          env: { ...(mode.env || {}) },
        });
        const transcript = `${r.stdout}\n${r.stderr}`;
        const ctx = { transcript, exitCode: r.exitCode, cwd };
        const scored = scoreProblem(problem, ctx);
        const approxOutTokens = Math.ceil(transcript.length / 4);
        const rec = {
          cellId, problemId: problem.id, mode: mode.id, run,
          exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs,
          score: scored.score, passed: scored.passed, checks: scored.checks,
          approxOutTokens, toolCalls: countToolCalls(transcript),
          weight: problem.weight ?? 1,
        };
        results.push(rec);
        writeFileSync(join(cwd, "transcript.log"), transcript);
        writeFileSync(join(cwd, "result.json"), JSON.stringify(rec, null, 2));
        console.log(`${scored.passed ? "PASS" : "fail"} score=${scored.score} ${(r.durationMs / 1000).toFixed(1)}s`);
      }
    }
  } finally {
    if (moved.length) restoreSkills(moved);
  }
}

// ---------- aggregate ----------
function agg(filterFn) {
  const rows = results.filter(filterFn);
  if (!rows.length) return null;
  const totW = rows.reduce((s, r) => s + r.weight, 0) || 1;
  return {
    cells: rows.length,
    passRate: Math.round((rows.filter((r) => r.passed).length / rows.length) * 100),
    weightedScore: Math.round(rows.reduce((s, r) => s + r.score * r.weight, 0) / totW),
    medianDurationMs: median(rows.map((r) => r.durationMs)),
    medianOutTokens: median(rows.map((r) => r.approxOutTokens)),
    medianToolCalls: median(rows.map((r) => r.toolCalls)),
  };
}
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const summary = { config: configPath, model, runsPerCell, stamp, byMode: {} };
for (const mode of modes) summary.byMode[mode.id] = agg((r) => r.mode === mode.id);

writeFileSync(join(outDir, "results.json"), JSON.stringify({ summary, results }, null, 2));

// ---------- markdown report ----------
const md = [];
md.push(`# Skill benchmark report\n`);
md.push(`- Generated: ${stamp}`);
md.push(`- Model: \`${model}\`  ·  runs/cell: ${runsPerCell}  ·  problems: ${problems.length}`);
md.push(`- Config: \`${configPath.replace(REPO_ROOT + "/", "")}\`${dryRun ? "  ·  **DRY RUN**" : ""}\n`);
md.push(`## Aggregate by mode\n`);
md.push(`| Mode | Cells | Pass rate | Weighted score | Median time | Median out-tokens | Median tool calls |`);
md.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: |`);
for (const mode of modes) {
  const a = summary.byMode[mode.id]; if (!a) continue;
  md.push(`| ${mode.label || mode.id} | ${a.cells} | ${a.passRate}% | ${a.weightedScore} | ${(a.medianDurationMs / 1000).toFixed(1)}s | ${a.medianOutTokens} | ${a.medianToolCalls} |`);
}
// delta if exactly two modes
if (modes.length === 2) {
  const a = summary.byMode[modes[0].id], b = summary.byMode[modes[1].id];
  if (a && b) {
    md.push(`\n## Delta (${modes[1].id} − ${modes[0].id})\n`);
    md.push(`- Pass rate: **${b.passRate - a.passRate >= 0 ? "+" : ""}${b.passRate - a.passRate} pts**`);
    md.push(`- Weighted score: **${b.weightedScore - a.weightedScore >= 0 ? "+" : ""}${b.weightedScore - a.weightedScore}**`);
    md.push(`- Median tokens: ${a.medianOutTokens} → ${b.medianOutTokens} (${pct(a.medianOutTokens, b.medianOutTokens)})`);
    md.push(`- Median tool calls: ${a.medianToolCalls} → ${b.medianToolCalls}`);
  }
}
md.push(`\n## Per-problem\n`);
md.push(`| Problem | Mode | Score | Pass | Time | Tokens~ | Checks |`);
md.push(`| --- | --- | ---: | :--: | ---: | ---: | --- |`);
for (const r of results) {
  const failed = r.checks.filter((c) => !c.pass).map((c) => c.label).join(", ") || "—";
  md.push(`| ${r.problemId} | ${r.mode} | ${r.score} | ${r.passed ? "✓" : "✗"} | ${(r.durationMs / 1000).toFixed(1)}s | ${r.approxOutTokens} | ${r.passed ? "all" : "fail: " + failed} |`);
}
md.push(`\n> Token counts are length/4 estimates of captured stdout, not provider-billed usage. Percentages are workload-specific.`);
function pct(a, b) { if (!a) return "n/a"; const d = Math.round(((b - a) / a) * 100); return `${d >= 0 ? "+" : ""}${d}%`; }

const reportPath = join(outDir, "report.md");
writeFileSync(reportPath, md.join("\n") + "\n");

console.log(`\nbench: report → ${reportPath}`);
console.log(`bench: results → ${join(outDir, "results.json")}`);
for (const mode of modes) {
  const a = summary.byMode[mode.id]; if (!a) continue;
  console.log(`  ${mode.id.padEnd(14)} pass=${a.passRate}%  score=${a.weightedScore}  tok~${a.medianOutTokens}  tools=${a.medianToolCalls}`);
}
