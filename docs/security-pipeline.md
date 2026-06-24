# Security & quality pipeline

This repo ships two GitHub Actions workflows plus Dependabot. Together they cover
dependency vulnerabilities, supply-chain/malicious-package risk, static code
analysis, and **AI-skill-specific safety** (the same classes of issue that the
[skills.sh](https://www.skills.sh) audits — Agent Trust Hub, Socket, Snyk —
flag for Agent Skills).

## Workflows

### `.github/workflows/ci.yml` — build, test, lint, skills validation

| Job | What it runs |
| --- | --- |
| `build-test` | `npm ci` → `npm run build` (tsc) → `npm run lint` (eslint) → `npm test` (vitest), on Node 20 & 22 |
| `skills` | `npm run lint:skills` (omp's own validator) + `npm run check:catalog` |

### `.github/workflows/security.yml` — security scanners

| Job | Tool | Secret required | Gate |
| --- | --- | --- | --- |
| `npm-audit` | `npm audit` | none | fails on **high+** in **production** deps |
| `skills-safety` | `scripts/skills-safety-scan.mjs` | none | fails on any **HIGH** finding |
| `codeql` | GitHub CodeQL (JS/TS) | none | results in Security tab |
| `dependency-review` | GitHub Dependency Review | none (PRs only) | fails on **high** severity |
| `socket` | Socket CLI | `SOCKET_SECURITY_API_KEY` | skipped if secret unset |
| `snyk` | Snyk Open Source + Snyk Code | `SNYK_TOKEN` | SARIF → Security tab |

Runs on every push/PR to `main`, plus a weekly scheduled full scan (Mondays).
Socket and Snyk jobs **self-skip with a notice** if their secret isn't set, so
the pipeline is green out of the box and lights up as you add tokens.

## Required secrets (optional but recommended)

Add these under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Where to get it | Free tier |
| --- | --- | --- |
| `SNYK_TOKEN` | [snyk.io](https://snyk.io) → Account settings → Auth Token | Yes |
| `SOCKET_SECURITY_API_KEY` | [socket.dev](https://socket.dev) → Settings → API Tokens | Yes |

`GITHUB_TOKEN` is provided automatically — no setup needed for CodeQL,
Dependency Review, or SARIF upload.

## GitHub repo settings to flip on (one-time, free)

These complement the workflows and live in **Settings → Code security**:

- **Dependabot alerts** + **security updates** — `.github/dependabot.yml` already
  schedules weekly version bumps for npm and Actions.
- **Secret scanning** + **push protection** — blocks committed credentials.
- **Code scanning** — surfaces CodeQL/Snyk SARIF in the Security tab.

## The skills safety scanner

`scripts/skills-safety-scan.mjs` statically audits `.github/skills/**/SKILL.md`,
`.github/agents/**`, and `catalog/**` for the risk classes those external
audits care about:

| Rule | Severity | Detects |
| --- | --- | --- |
| S001 | HIGH | `curl … | sh` remote code execution |
| S002 | MEDIUM | Unpinned remote install / `npx <pkg> add` |
| S003 | LOW | Global `-g` installs |
| S004 | MEDIUM | Indirect prompt-injection surface (fetch + act on untrusted/third-party content — cf. Snyk W011) |
| S005 | HIGH | Credential/secret exfiltration |
| S006 | MEDIUM | Obfuscation (`base64 -d | sh`, `eval(`, `Function(`) |
| S007 | HIGH | Destructive shell (`rm -rf /`, `dd`, `mkfs`, `chmod 777`) |
| S100/S101 | MEDIUM | SKILL.md missing `name` / `description` frontmatter |

Run locally:

```bash
npm run scan:skills              # human-readable, fails on HIGH
node scripts/skills-safety-scan.mjs --json    # machine-readable
node scripts/skills-safety-scan.mjs --strict  # also fail on MEDIUM
```

## Local commands

```bash
npm run lint          # eslint over src + scripts
npm run lint:fix      # auto-fix
npm run lint:skills   # omp's own SKILL.md validator
npm run check:catalog # catalog schema validation
npm run scan:skills   # AI-skill safety scan
npm run audit:ci      # prod-dep vulnerability gate (high+)
```

## Notes

- ESLint is scoped to `src/**` and `scripts/**`. Tests (`test/**`) are covered
  by vitest and kept out of the lint gate to avoid a large up-front refactor.
- `npm audit` gates on **production** dependencies only (`--omit=dev`); dev-only
  vulns (vitest, vite, etc.) are handled by Dependabot PRs rather than blocking CI.
