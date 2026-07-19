---
name: skill-retro
description: Bulletproof skill-usage retrospective from local Copilot history. Prefer omp skill-retro (not history analyze). Simple or advanced tables, optional HTML. Use for skill usage retros, times used, tokens, spend.
---

# Skill Retro (bulletproof)

Use `/skill-retro` to request this local metadata-only skill-usage retrospective.

Local Copilot session-state only. Never read conversation content.

## Hard rules (cheap-model safe)

1. **Only** run the `omp skill-retro` command below.  
   **Never** run `omp history analyze`.  
   **Never** invent flags if a command fails.  
   **Never** use JSON mode (`--json`).  
   **Never** reformat tables into bullets or one long line.
2. If `omp skill-retro` is not found or fails → **stop**. Tell the user to install/link the omp that includes skill-retro. Do **not** fall back to other commands.
3. The CLI prints markdown tables plus a plain **What next?** section. **Show that stdout to the user as the answer.**

## 1. Ask view once (plain words)

> Do you want a **quick summary** (recommended) or the **full detailed report**?

- Quick summary → simple  
- Full detailed report → advanced  
- Silence → simple  

Do **not** ask with flag names.

## 2. Run exactly one command

**Quick summary (default):**

```bash
omp skill-retro
```

**Full detailed report:**

```bash
omp skill-retro advanced
```

**After the user picks a next step** (only then):

| User says | What you do |
| --- | --- |
| more detail / full | `omp skill-retro advanced` |
| simpler / summary / quick | `omp skill-retro simple` |
| dollar estimates / pricing / $ | same view + `--price public` |
| save html / html / browser | `omp skill-retro … --html` then **ask open** (below) |
| open / yes / open it (after HTML) | only then run `open '<path>'` (macOS) |
| no / skip / done | stop |

Default days stay **14** unless the user asked another window earlier.  
Aliases: `omp retro`. Optional: `--days 7`, `--project current`.

## 3. Present

1. Paste CLI stdout as-is (tables + **What next?**).  
2. Do not rewrite numbers or dates.  
3. Do **not** invent technical flag lists as next steps.

## 4. HTML flow (important)

When the user asks to **save as HTML** / **html**:

1. Run `omp skill-retro simple --html` (or advanced if that was the current view).  
2. Show the CLI output (includes **HTML report ready** + path + open question).  
3. **Stop and wait.** The CLI already asks: “Open this report in your browser now?”  
4. **Only if they reply yes / open / open it** → run exactly:  
   `open '<absolute-path-from-cli>'` (macOS).  
5. **Never** run `open` in the same turn as `--html`.  
6. **Never open automatically.**

## Fail closed

| Situation | Action |
| --- | --- |
| `skill-retro` unknown | Stop + link/update omp |
| Exit non-zero | Show error only |
| Want JSON | Refuse; use text stdout |

## What each view shows

- **Quick (simple):** snapshot, top skills (UK dates), **API usage always** (AI credits + tokens + premium/duration when present), **by-model API usage always** (tokens + AI credits; public USD only after dollar estimates), single-skill associations.  
- **Full (advanced):** all of that + full session metrics + spend/models + shared + warnings.  
- Never show a USD-from-credits dollar column; AI **credits** (usage units) always appear in API usage + by-model.
