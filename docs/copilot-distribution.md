# Copilot skill distribution

## Bundle install (Copilot CLI plugin)

The future-proof path: register the marketplace once, then install the bundled 17-skill plugin.

```bash
copilot plugin marketplace add damian87x/oh-my-copilot
copilot plugin install oh-my-copilot@oh-my-copilot
```

Backed by root `plugin.json` with `"skills": ".github/skills/"` — no skills moved, no duplication. Backed by `.github/plugin/marketplace.json` listing the single self-hosted plugin. Requires Copilot CLI v1.0.48+.

The shorter `owner/repo` form also works today but Copilot CLI prints a deprecation notice and will remove it in a future release:

```bash
copilot plugin install damian87x/oh-my-copilot   # works today, deprecated
```

The per-skill flows below remain valid for cases where you only want one skill or are on an older Copilot CLI.

---

## Per-skill install

Use the agent-skill package shape as the default install surface:

```text
skills/<skill-name>/SKILL.md
skills/<skill-name>/references/*
skills/<skill-name>/scripts/*
skills/<skill-name>/assets/*
```

For Copilot project install, copy the skill directory to:

```text
.github/skills/<skill-name>/SKILL.md
```

For Copilot personal install, copy the skill directory to:

```text
~/.copilot/skills/<skill-name>/SKILL.md
```

The catalog is optional metadata for this repository's built-in general skill list. Copilot discovers skills from the skill directories themselves.

## Native oh-my-copilot installer

Use `omcc skill install` when you want the same simple OMC-style copy flow, or as a fallback on machines without a new enough GitHub CLI. The bin is `omcc` (not `omc`) to avoid colliding with the `oh-my-claudecode` global command:

```bash
omcc skill install ./skills/my-skill --dry-run
omcc skill install ./skills/my-skill --scope project --root /path/to/repo
omcc skill install ./skills/my-skill              # default: ~/.copilot/skills
```

The installer validates `SKILL.md` frontmatter, previews copied files with `--dry-run`, preserves optional resource folders, and writes to `~/.copilot/skills/<name>` by default. Pass `--scope project` only when you intentionally want a repo-local copy under `.github/skills/<name>`.

## GitHub CLI path

GitHub documents `gh skill` for searching, previewing, installing, updating, and publishing skills. It requires GitHub CLI `2.90.0` or newer.

Useful commands:

```bash
gh skill preview OWNER/REPOSITORY SKILL
gh skill install OWNER/REPOSITORY SKILL
gh skill install OWNER/REPOSITORY SKILL --scope user
gh skill publish --dry-run
```

Local note: this machine has `gh 2.92.0`, so `gh skill` is available. Do not make `gh skill` the only install path; keep `omcc skill install` as the fallback and repo-native dry-run surface.

## OMC-like installer shape

The `oh-my-copilot` installer should stay thin:

1. Fetch a skill directory from a GitHub repository.
2. Validate `SKILL.md` frontmatter: `name` and `description`.
3. Preview the file tree before writing.
4. Copy the directory unchanged to `~/.copilot/skills/<name>` by default (user scope), or `.github/skills/<name>` when `--scope project` is set.
5. Preserve optional `references/`, `scripts/`, and `assets/`.
6. Write provenance metadata only if needed for updates; do not require catalog entries.

Dry-run output should show the target path and files that would be written.

## Not a GitHub App Copilot Extension

GitHub App-based Copilot Extensions are not the right path for this repo. GitHub sunset that extension type in favor of MCP servers: new creation was blocked in September 2025 and existing GitHub App-based Copilot Extensions were disabled in November 2025.

If this project later needs live tools beyond static skills, prefer an MCP server. If it needs IDE UI integration, consider a VS Code extension. Keep project skills as plain skill packages.

## References

- GitHub Docs: Adding agent skills for GitHub Copilot — https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/create-skills
- GitHub Docs: About agent skills — https://docs.github.com/en/copilot/concepts/agents/about-agent-skills
- GitHub Docs: Running GitHub Copilot CLI programmatically — https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically
- GitHub Changelog: Sunset notice for GitHub App-based Copilot Extensions — https://github.blog/changelog/2025-09-24-deprecate-github-copilot-extensions-github-apps/
