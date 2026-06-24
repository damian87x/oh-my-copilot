#!/usr/bin/env node
/**
 * skills-safety-scan — static safety audit for Agent Skills (SKILL.md) and agents.
 *
 * Mirrors the kinds of issues that Agent Trust Hub / Socket / Snyk flag for
 * AI skills (see skills.sh audits), but runs locally with no network and no
 * secrets so it can gate every PR:
 *
 *   - Untrusted install / remote-code execution surfaces (curl | sh, npx <pkg>, -g, npm i remote)
 *   - Indirect prompt-injection surfaces (fetching + acting on third-party/user content)
 *   - Credential / secret exfiltration patterns
 *   - Obfuscation (base64 decode + exec, eval, large encoded blobs)
 *   - Destructive shell (rm -rf, dd, mkfs, chmod 777)
 *   - Frontmatter hygiene (missing name/description)
 *
 * Exit codes:
 *   0 = no HIGH findings (warnings allowed)
 *   1 = at least one HIGH finding, or with --strict any MEDIUM finding
 *
 * Usage:
 *   node scripts/skills-safety-scan.mjs [--root .] [--strict] [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const opt = (flag, def = null) => {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true) : def;
};
const ROOT = typeof opt("--root") === "string" ? opt("--root") : ".";
const STRICT = !!opt("--strict", false);
const JSON_OUT = !!opt("--json", false);

// Where skills/agents live in this repo.
const SCAN_DIRS = [".github/skills", ".github/agents", "catalog"];
const SCAN_EXT = [".md", ".json"];

/** @type {{severity:'HIGH'|'MEDIUM'|'LOW',rule:string,file:string,line:number,match:string,why:string}[]} */
const findings = [];

const RULES = [
  {
    rule: "S001 remote-code-execution",
    severity: "HIGH",
    re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i,
    why: "Pipes a downloaded script straight into a shell (untrusted remote code execution).",
  },
  {
    rule: "S002 unpinned-remote-install",
    severity: "MEDIUM",
    re: /\bnpx\s+(?:-y\s+|--yes\s+)?(?!tsc\b|vitest\b|eslint\b)[a-z@][\w@/.-]*\s+add\b|\bnpm\s+i(nstall)?\s+(-g\s+)?https?:\/\//i,
    why: "Installs/executes packages from an external source at runtime (supply-chain + untrusted install surface).",
  },
  {
    rule: "S003 global-install",
    severity: "LOW",
    re: /\bnpm\s+i(nstall)?\s+-g\b|\bnpx\b[^\n]*\s-g\b/i,
    why: "Global install persists tooling at user/system level.",
  },
  {
    rule: "S004 prompt-injection-surface",
    severity: "MEDIUM",
    re: /\b(fetch|read|download|ingest|browse)\b[^\n]*\b(untrusted|third-?party|user-generated|external (registry|source|content|repos?))\b/i,
    why: "Fetches and may act on third-party/untrusted content — indirect prompt-injection risk (cf. Snyk W011).",
  },
  {
    rule: "S005 credential-exfiltration",
    severity: "HIGH",
    re: /\b(env|printenv|cat)\b[^\n]*\b(\.env|secret|token|api[_-]?key|password|credential)\b[^\n]*\|\s*(curl|wget|nc)\b|\b(curl|wget)\b[^\n]*\$\{?\s*(SECRET|TOKEN|API_KEY|PASSWORD)/i,
    why: "Reads secrets/credentials and sends them off the machine.",
  },
  {
    rule: "S006 obfuscation",
    severity: "MEDIUM",
    re: /\bbase64\b\s+(-d|--decode)\b[^\n]*\|\s*(ba)?sh|\beval\b\s*\(|\bFunction\s*\(\s*['"`]/i,
    why: "Decodes/evaluates hidden code at runtime (obfuscation).",
  },
  {
    rule: "S007 destructive-shell",
    severity: "HIGH",
    re: /\brm\s+-rf\s+[/~]|\bdd\s+if=|\bmkfs\b|\bchmod\s+-R?\s*777\b|>\s*\/dev\/sd/i,
    why: "Destructive or overly-permissive filesystem operation.",
  },
];

function walk(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir may not exist in every repo
  }
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try {
      s = statSync(p);
    } catch {
      continue;
    }
    if (s.isDirectory()) out = out.concat(walk(p));
    else if (SCAN_EXT.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

function scanFile(file) {
  const rel = relative(ROOT, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);

  // Frontmatter hygiene for SKILL.md
  if (file.endsWith("SKILL.md")) {
    const fm = text.startsWith("---") ? text.slice(3, text.indexOf("\n---", 3)) : "";
    if (!/\bname\s*:/.test(fm))
      findings.push({ severity: "MEDIUM", rule: "S100 missing-name", file: rel, line: 1, match: "frontmatter", why: "SKILL.md is missing a `name` in frontmatter." });
    if (!/\bdescription\s*:/.test(fm))
      findings.push({ severity: "MEDIUM", rule: "S101 missing-description", file: rel, line: 1, match: "frontmatter", why: "SKILL.md is missing a `description` in frontmatter." });
  }

  lines.forEach((line, i) => {
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (m) {
        findings.push({
          severity: r.severity,
          rule: r.rule,
          file: rel,
          line: i + 1,
          match: m[0].slice(0, 120),
          why: r.why,
        });
      }
    }
  });
}

// Run
const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
files.forEach(scanFile);

const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
findings.forEach((f) => (counts[f.severity] += 1));

if (JSON_OUT) {
  console.log(JSON.stringify({ scanned: files.length, counts, findings }, null, 2));
} else {
  const C = { HIGH: "\x1b[31m", MEDIUM: "\x1b[33m", LOW: "\x1b[36m", reset: "\x1b[0m" };
  console.log(`\nskills-safety-scan — scanned ${files.length} file(s) in ${SCAN_DIRS.join(", ")}\n`);
  if (findings.length === 0) {
    console.log("  ✓ No issues found.\n");
  } else {
    for (const f of findings.sort((a, b) => ("HML".indexOf(a.severity[0]) - "HML".indexOf(b.severity[0])))) {
      console.log(`  ${C[f.severity]}${f.severity}${C.reset} ${f.rule}`);
      console.log(`    ${f.file}:${f.line}`);
      console.log(`    match: ${f.match}`);
      console.log(`    why:   ${f.why}\n`);
    }
  }
  console.log(`Summary: ${counts.HIGH} high, ${counts.MEDIUM} medium, ${counts.LOW} low\n`);
}

const fail = counts.HIGH > 0 || (STRICT && counts.MEDIUM > 0);
process.exit(fail ? 1 : 0);
