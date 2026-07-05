# Execution Plan v2 — Phase 1 Hardening via /ralph + Codex (oh-my-copilot)

Revision of exec-plan v1 implementing all 9 Critic revision instructions (which subsume the Architect's 7 required changes). Execution wrapper around the **approved** hardening plan v3.1 at `/home/damian-linux/workspace/oh-my-copilot/docs/plans/2026-07-05-hardening-plan.md` (henceforth PLAN). This document does not re-litigate hardening content — every spec, acceptance criterion, and amendment lives in PLAN; this defines *who does what, where, how it is audited, and how done is detected*. Standalone; supersedes v1. Short ADR at the end.

**Scope of this ralph run:** Phase 1 as amended — B1, B2 (+ env-init amendment v3.1-3), B3 (+ pinned queue semantics v3.1-6), A4, then the loop-invariants slice A1 (+ team state-paths v3.1-2) → A3 (+ sessionId sanitization & clear-path cleanup v3.1-5, execution notes §5.1-2) → A2 (+ UltraQA amendment v3.1-1), with the bundled agent-stop harness, atomic writes, and omp-root tests. **Deferred:** Phase 0 V2 spike (needs an interactive Copilot session; A6 stays blocked) and V1 (same constraint; it only gates the plugin.json `"hooks"` removal decision, which is not a Phase-1 item). Phases 2–3 are follow-up ralph runs.

---

## 1. RALPLAN-DR Summary (compact)

### Principles
1. **Implementer/verifier separation — made substantive, not just provenance.** Codex writes every line of product code *and* its tests; Claude writes zero product code, prepares prompts, runs the gates, **audits the tests Codex wrote** (bullet→test checklist, red-proof), and commits only what passes. The verifier never grades its own work — and the implementer never grades its own tests.
2. **Isolation is absolute.** All writes happen in a dedicated worktree; the main checkout is asserted clean after every Codex pass; the orchestrator's own tooling (global `omp` binary) and its loop state live outside both the worktree and the main checkout — the run must never depend on code it is itself mutating.
3. **One plan item = one Codex task = one commit.** The commit trail mirrors PLAN IDs (conventional commits), keeping the branch bisectable and the human review per-item.
4. **PLAN is the single source of spec.** The plan doc is committed in the repo, so it exists inside the worktree — every Codex prompt points at the exact PLAN section by heading, never a paraphrase that could drift.
5. **Bounded everything, loud escalation.** 3 Codex passes per item, a hard wall-clock timeout per pass, and a defined red path at every stage — never loop or hang silently.

### Decision Drivers
1. PLAN's items already carry testable acceptance criteria and pinned verify commands — ready-made gate material for a mechanical execute-audit-verify loop.
2. User mandate: Codex is the implementer, Claude orchestrates; work isolated in a worktree; run driven by /ralph.
3. The A1 → A3 → A2 strict ordering in PLAN maps naturally onto ralph's sequential loop; the "parallelizable" B-lane simply runs first in sequence.

### Options
- **A — Codex implements, Claude audits + verifies (chosen).** Pros: genuine two-model separation with teeth — the gate reads the tests, maps them to PLAN bullets, and red-proves them, so a half-implementation with weak tests cannot pass; failures feed back as concrete test output. Cons: audit adds per-item orchestrator work — accepted, it is the cost of the separation being real.
- **B — Claude implements directly.** Invalidated: contradicts the explicit mandate, and collapses the implementer/verifier separation that gives the commit trail its review value.
- **C — Mixed routing (Codex for big items, Claude for one-liners like A4).** Invalidated: two write-paths muddy provenance in the commit trail for the sake of exactly one trivial item; not worth the accountability cost.
- **(v1's gate — superseded.)** v1 ran Codex-authored tests without auditing them: separation was provenance, not substance, and the retry loop Goodharts toward gate-passing. v2's audit + red-proof + no-weakening clause close that loop.

---

## 2. Setup, Guardrails, Loop Mechanics

### Run log (pinned location)
`/home/damian-linux/workspace/MoltCore-workspace/.ralph-runs/omp-hardening-phase1/run-log.md` — in the **orchestrating workspace**, never the worktree or main checkout. Records per item: pass count, prompts sent, verify output summaries, the bullet→test audit checklist, red-proof results, tripwire results, surface-review decisions, retries with failure output, and any BLOCKED verdicts. At T0 it additionally records `codex --version` and the exact confirmed invocation flags.

### T0 — Worktree + baseline + tooling pins (Claude, no Codex)
```bash
cd /home/damian-linux/workspace/oh-my-copilot
git worktree add ../oh-my-copilot-hardening -b hardening/phase-1 main
cd /home/damian-linux/workspace/oh-my-copilot-hardening
npm install
npm run build && npm test && npm run lint && npm run lint:skills   # baseline must be green
codex --version && codex exec --help | head -30                    # confirm exact exec/sandbox/cd flags
```
Additional T0 verifications (all logged):
- **Codex non-interactive check:** a trivial `codex exec --sandbox workspace-write` invocation completes without prompting for input (confirms the timeout wrapper won't mask an interactive hang as work).
- **Orchestrator tooling pin:** `which omp` resolves to the global install — never `dist/` inside the worktree or the main checkout. **Orchestrator loop state pin:** the ralph loop's own state (its `.omp` root, tick counters) resolves to the orchestrating workspace (`/home/damian-linux/workspace/MoltCore-workspace`), outside both checkouts — T5/T7 change the very code that drives loops, and this run must not be driven by the code it is mutating. Verified by checking the loop-state file path after `omp ralph start` (or the ralph skill's equivalent registration) from the orchestrating cwd.
- **Version record:** `codex --version` output + confirmed flag forms written to the run log (instruction: reproducibility of the run).

Acceptance gate: worktree exists on branch `hardening/phase-1` from `main@218f7ad`; baseline suite green; Codex flags confirmed and logged; both tooling pins verified. No commit.

### Codex invocation (every implementation task)
Direct form (flags confirmed at T0): `codex exec --cd /home/damian-linux/workspace/oh-my-copilot-hardening --sandbox workspace-write "<prompt>"`. Fallback: the companion runner (`node .../codex-companion.mjs task "<prompt>"`) with cwd set to the worktree.

**Hard timeout: 40 minutes wall-clock per `codex exec` invocation** (within the reviewed 30–45 band). On expiry the orchestrator kills the whole process group (`kill -- -<pgid>`), records the timeout in the run log, and the pass **counts toward the item's 3-pass cap** as a failed pass. A hung Codex can never wedge the run.

**Standard prompt preamble (prepended to every task prompt):**
> You are implementing one item of an approved hardening plan in the repo at your current working directory (a git worktree — operate ONLY inside it). Read `docs/plans/2026-07-05-hardening-plan.md`, section named below, including any referenced §6 amendments and §5 execution notes — that section is the full spec: change list, acceptance criteria, risks. Implement exactly that item: no scope creep, no drive-by refactors, match surrounding code style. Write the tests the acceptance criteria name. **Never weaken, delete, skip, or hollow out an existing test, and never loosen an assertion, to make a suite pass — if a pre-existing test genuinely conflicts with this item's spec, the spec section says so explicitly (as in the loop-driver cap tests); otherwise a conflicting test means your implementation is wrong.** Run the item's verify commands yourself before finishing and iterate until green. Do NOT run any git commit/push — the orchestrator commits. Do NOT modify docs/plans/, package.json scripts, or CI workflows unless the item's spec says so.

**Retry prompt (passes 2–3):** preamble (including the no-test-weakening clause, restated) + the item block + verbatim failing output (test failures, audit rejections, or surface-review rejections with file lists) + "Fix the failures above. Do not weaken or remove tests to do so; make the implementation satisfy them."

### Session-level guardrails
- **Write scope:** Codex runs with workspace-write sandbox scoped to the worktree; every prompt restates the boundary. Codex never receives a path outside the worktree.
- **Main-checkout tripwire:** after *every* Codex pass, ralph runs `git -C /home/damian-linux/workspace/oh-my-copilot status --porcelain` — any output aborts the run and escalates immediately (isolation breach).
- **Surface review (replaces v1's diff-stat check):** after the gates pass, ralph runs `git status --porcelain` in the worktree — this catches **untracked new files**, which `git diff` is blind to — and compares every listed path against the item's **directory-level allowlist** plus any named doc files (e.g. README for T2). Rules: **new files under `test/` are always in-surface**; a **modified existing file outside the allowlist is a rejection** (fed back to Codex with the file list, even if tests pass); unexpected new files outside `test/` and the allowlist are likewise rejected. Staging is **explicit**: `git add <each reviewed path>` — never a blind `git add -A`, which would silently sweep unreviewed untracked files into the commit.
- **No pushes until done:** the branch is pushed once, at T8, when the full suite is green.

### The ralph loop (per item T1–T7)
1. Compose prompt = preamble + item block (section reference, amendments, expected surface allowlist, verify commands).
2. Invoke Codex under the 40-minute timeout; wait for completion or kill on expiry.
3. Run the main-checkout tripwire.
4. Run the item's verify commands, then the full gate: `npm run build && npm test && npm run lint` (plus `npm run lint:skills` for items touching `.github/skills/`).
5. **Test audit (every item, before any commit):** map **every acceptance bullet of the PLAN item to a named test** — read the test's assertions, confirm it actually asserts the bullet's behavior (not a tautology or a smoke check) — and write the bullet→test checklist into the run log. A bullet with no test, or a test whose assertions don't cover its bullet, or any weakened/deleted pre-existing test not sanctioned by the PLAN spec = **failed pass** (feed back to Codex).
6. **Red-proof (T1, T6, T7 only — the behavior-change items; scoped to behavior-change bullets, not pure test-infrastructure bullets):**
   - Revert **only the item's own non-test files** to their pre-item state: `git stash push -- <the item's changed non-test paths>` (the item is uncommitted at gate time, so this restores those files to HEAD while keeping the new tests in place).
   - Run **only the item's named acceptance tests** (from the step-5 checklist).
   - **Require ≥1 red.** All-green against the reverted implementation means the tests don't test the change = failed pass.
   - Restore: `git stash pop`. Re-run the item's tests green before proceeding.
7. **Green through audit** → surface review (§ guardrails) → explicit staging → `git commit` with the item's message → `omp ralph tick` → next item.
8. **Red at any gate** → feed the exact failing output/rejection back to Codex via the retry prompt. **Max 3 passes per item (timeouts included).** After the 3rd red: `git checkout -- . && git clean -fd` in the worktree, mark the item BLOCKED in the run log, escalate to human.
9. **Blocked-item policy:** B1/B2/B3/A4 are independent — a block there skips forward. A block in the slice halts the slice at that point (A3 requires A1; A2 requires A3); remaining independent items still run, then the loop escalates rather than emitting RALPH_COMPLETE.

### Done detection
Ralph is done when: **all seven items committed** (one commit each, T1–T7, each having passed audit + red-proof where required) **+ T8's full verify suite green in the worktree + PR opened**. Then and only then emit `RALPH_COMPLETE` (and `omp ralph cancel` if registered via the omp loop). Any BLOCKED item means no sentinel — the loop ends in escalation instead.

**T8-red path (defined):** if the full suite goes red at T8 despite all per-item gates having passed (cross-item interaction), the orchestrator does **not** emit the sentinel, leaves the branch and all commits **intact** (no reverts — the trail is the diagnostic), identifies the earliest failing commit by running the failing tests backward from HEAD toward the last-known-green per-item commit (per-item blame via the one-commit-per-item trail), records the finding in the run log, and escalates to human with the blame candidate. No push, no PR, unless the human decides otherwise.

### What the human reviews at the end
- The PR diff (branch `hardening/phase-1` → `main`) and the seven-commit trail, one commit per PLAN item, reviewable in plan order.
- The run log (pinned location above): per-item pass counts, bullet→test audit checklists, red-proof results, retries with failure output, tripwire and surface-review results, T0 version/flag record.
- The two flagged release-note surfaces: B2's breaking change (empty allowlist now refuses; `*` opt-in) and A2's three-mode iteration-semantics change.
- Deferred-items note: V1/V2 spikes and A6 remain open; Phases 2–3 are follow-up runs.

---

## 3. Ordered Task List

Full gate (every item): `npm run build && npm test && npm run lint`, then test audit, then red-proof where marked. Item-specific verify listed per task. Failure policy is global (§2) — only deviations noted. Each item's **surface allowlist** is directory-level; new files under `test/` are always in-surface.

**T1 — B1: installSkill path traversal. [RED-PROOF]**
- Codex prompt: preamble + "Implement PLAN §Phase 1 → 'B1 — Sanitize `skillName` in installSkill'. **The `--scope user` tests must stub the home/skills root (e.g. inject or mock the target root) — they must never write to the real `$HOME`/`~/.copilot/skills`**, both for isolation and because the sandbox may not permit it."
- Surface allowlist: `src/` (skills.ts), `test/`.
- Verify: full gate; audit maps B1's four acceptance bullets (traversal throws pre-filesystem; project + user scope; absolute path; overwrite) to named tests; red-proof: stash `src/skills.ts` → B1's tests must show ≥1 red → restore.
- Commit: `fix(skills): validate skill name and confine install target (B1)`

**T2 — B2: Slack allowlist default-closed (incl. env-init amendment).**
- Codex prompt: preamble + "Implement PLAN §Phase 1 → 'B2 — Close the default-open Slack allowlist' INCLUDING Amendment v3.1-3 (§6.3: `omp env init` makes the allowlist prompt required, accepting `*` explicitly; generated-file test asserts the var is always present)."
- Surface allowlist: `src/slack/`, `src/gateway/`, `src/env/`, `test/`, plus named doc file `README.md`.
- Verify: full gate; audit maps B2's acceptance bullets + amendment bullet to named tests.
- Commit: `fix(slack): require explicit SLACK_ALLOWED_USERS with * opt-in (B2)`

**T3 — B3: per-session FIFO with bounded queue (pinned semantics).**
- Codex prompt: preamble + "Implement PLAN §Phase 1 → 'B3 — Serialize concurrent Slack→Copilot requests' INCLUDING clarification v3.1-6 (§6.6: cap = 3 pending in addition to the 1 in-flight, 4th pending gets the busy reply; settled entries removed from the promise-chain map — no leaked per-session chains)."
- Surface allowlist: `src/gateway/`, `test/`.
- Verify: full gate; audit maps B3's acceptance bullets (sequential resolution, busy reply beyond cap, timed-out item advances queue, map cleanup) to named tests.
- Commit: `fix(slack): serialize per-session requests behind bounded queue (B3)`

**T4 — A4: crash-safe preToolUse template.**
- Codex prompt: preamble + "Implement PLAN §Phase 1 → 'A4 — Make preToolUse crash-safe'."
- Surface allowlist: `hooks/`, `test/`.
- Verify: full gate; audit maps A4's two command-form bullets (bare; composed `export …; node … || echo '{}'`) to named tests.
- Commit: `fix(hooks): crash-safe preToolUse fallback in hooks template (A4)`

**T5 — A1: unify `.omp` state root (incl. team state-paths amendment). [slice start]**
- Codex prompt: preamble + "Implement PLAN §Phase 1 → 'A1 — Unify the `.omp` state root' INCLUDING the team amendment already inlined in its change list (src/team/state-paths.ts → ompRoot; Amendment v3.1-2). Includes the bundled `scripts/lib/omp-root.mjs` unit tests and both nested-state warnings (loop state + schedule jobs)."
- Surface allowlist: `src/mode-state/`, `src/schedule/`, `src/team/`, `scripts/`, `test/`.
- Verify: full gate; audit maps A1's acceptance bullets (subdir → root-anchored state; prompt-submit/session-start/agent-stop all read it; team+schedule+KV pinned; omp-root unit tests; both warnings) to named tests.
- Commit: `fix(state): unify .omp root across CLI, hooks, schedule, team (A1)`
- Note: largest independent-file surface in the run; expect a retry. A failure here halts T6/T7.

**T6 — A3: canonical hook source + idempotency guard (+ atomic writes + harness core). [RED-PROOF]**
- Codex prompt: preamble + "Implement PLAN §Phase 1 → 'A3 — Canonical hook source + self-defending idempotency guard' INCLUDING §6.5 (sanitize `sessionId` for marker filenames; cleanup also on agent-stop's own `result.clear` path) and §5 execution notes 1-2 (epoch-ms `startedAt` in marker names; `mkdirSync` recursive on the locks dir inside the fail-open envelope). ALSO in this task, from the slice bundle: atomic tmp+rename writes in agent-stop, and the agent-stop end-to-end harness core (block→patch, sentinel→clear, cap→clear, OMP_TEAM_WORKER skip; from root and subdir). **Do NOT modify plugin.json — the hooks-entry removal is deferred pending the V1 spike.**"
- Surface allowlist: `scripts/`, `src/mode-state/`, `test/`.
- Verify: full gate; audit maps A3's acceptance bullets (concurrent-dedup; fail-open-toward-counting; restart no-freeze with cap at exactly 4; cleanup-on-start; atomic writes; harness scenarios) to named tests; red-proof: stash A3's non-test files (agent-stop.mjs, guard helper, mode-state clear changes) → A3's named tests must show ≥1 red → restore. Red-proof scope: behavior-change bullets only — the harness-infrastructure bullets (test scaffolding itself) are exempt.
- Commit: `fix(hooks): atomic agent-stop dedup guard + e2e harness (A3)`

**T7 — A2: single counter owner + N-yields-N cap (incl. UltraQA amendment). [RED-PROOF]**
- Codex prompt: preamble + "Implement PLAN §Phase 1 → 'A2 — Single owner for the loop counters' INCLUDING Amendment v3.1-1 (§6.1: `recordUltraqaCycle` stops incrementing `cycleCount`; `omp ultraqa cycle pass|fail` records verdict, keeps pass→cancel; agent-stop sole writer) and §5 note 4 (the existing loop-driver tests pin the old N-1 cap behavior — updating them is IN SPEC for this item, the one sanctioned test change). **T6's harness tests that pin cap→clear behavior also encode the old semantics and are expected to change here.**"
- Surface allowlist: `scripts/`, `src/mode-state/`, `.github/skills/`, `test/` — **explicitly including the test files T6 created for the agent-stop harness (cap-pinning tests), which this item must update**; treat those updates as PLAN-sanctioned, not test-weakening.
- Verify: full gate **+ `npm run lint:skills`** (touches `.github/skills/`); audit maps A2's acceptance bullets (ralph max 4 → exactly 4, 5th clears; ultraqa maxCycles 4 with interleaved `cycle fail` → exactly 4 hook-driven cycles; turns vs slices in status; N-yields-N for all three modes) to named tests; red-proof: stash A2's non-test files (loop-driver.mjs, ralph.ts, ultraqa.ts changes) → A2's named tests must show ≥1 red → restore.
- Commit: `fix(loops): single counter owner + N-yields-N cap across modes (A2)`

**T8 — Wrap-up: full verify + PR (Claude, no Codex, no commit).**
- Run the complete suite in the worktree: `npm run build && npm test && npm run lint && npm run lint:skills && npm run check:catalog && node scripts/skills-safety-scan.mjs --root .`.
- **Green** → push branch; open PR `hardening/phase-1` → `main` titled `Phase 1 hardening: security P0 + loop invariants (plan v3.1)`; body links PLAN, lists the seven commits by item ID, flags the two release-note surfaces (B2 breaking change, A2 three-mode semantics), and notes deferred V1/V2/A6. Then: `RALPH_COMPLETE`.
- **Red** → the defined T8-red path (§2 Done detection): no sentinel, branch and commits left intact, per-item blame from the commit trail, escalate with findings. No push, no PR.

---

## 4. Risks

| Risk | Mitigation |
|---|---|
| Codex authors weak/tautological tests and the gate passes a half-implementation | Test audit: bullet→test checklist with assertions read, logged per item; red-proof on T1/T6/T7 (implementation reverted → tests must go red); weakened/missing test = failed pass |
| Codex weakens or deletes existing tests to get green (Goodhart loop) | No-test-weakening clause in the standard preamble AND restated in every retry prompt; audit flags unsanctioned test changes; the two sanctioned test updates (loop-driver N-1 pins, T6 cap-pin harness tests) are named in T7's spec |
| Hung `codex exec` wedges the run | 40-minute hard timeout per invocation, process group killed, counts toward the 3-pass cap; T0 confirms non-interactive operation under the sandbox |
| Codex drifts outside the item's file surface (incl. NEW untracked files invisible to `git diff`) | Surface review via `git status --porcelain` against the item's directory allowlist + named docs; new files under `test/` auto-in-surface; modified existing files outside the list rejected; explicit per-path staging, never `git add -A` |
| Codex writes to the main checkout or elsewhere on disk | workspace-write sandbox scoped to worktree + post-pass tripwire on the main checkout; abort on breach |
| Self-hosting hazard: the run is driven by code the run is changing (T5/T7 touch loop-driver/state paths) | Orchestrator uses the global `omp` binary and keeps its loop state in the orchestrating workspace — both pins verified at T0, outside worktree and main checkout |
| B1 user-scope tests write to the real `$HOME` | T1 prompt requires stubbing the home/skills root; audit checks the test for real-`$HOME` writes |
| Prompt-fidelity loss (Codex lacks conversation context) | Prompts reference the in-repo PLAN section by heading, including §5/§6 pointers — spec drift impossible without editing the committed doc |
| T6 accidentally starts the plugin.json hooks-removal (deferred pending V1) | Explicit fence in T6's prompt; plugin.json is outside T6's surface allowlist |
| Slice failure mid-run (A1 or A3 red after 3 passes) | Revert item, halt slice, finish remaining independent items, escalate without RALPH_COMPLETE — never commit a half-slice |
| Cross-item regression surfaces only at T8 | Full gate runs on every item; T8-red path defined: sentinel withheld, branch intact, per-item blame via the one-commit-per-item trail, escalate |
| `codex exec` flag drift vs. this doc | T0 confirms flags from `codex exec --help` and records `codex --version` + flag forms in the run log |
| Retry loop burns budget on an unimplementable spec | Hard cap: 3 passes per item (timeouts included), then human escalation with the failure trail |

**Out of scope for this run:** Phase 0 spikes V1/V2 (interactive Copilot needed; A6 stays blocked), Phases 2–3 (follow-up ralph runs), release/publish (PR merge and version bump are human decisions), and any hardening content change — spec questions found mid-run are escalated, not improvised.

---

## 5. ADR — Codex-Implements / Claude-Audits Execution Shape

**Status:** Accepted (exec-plan consensus, 2 rounds: v1 ITERATE → v2 — Architect SOUND, Critic APPROVE, 2026-07-05).

**Decision.** Execute Phase 1 of the approved hardening plan v3.1 as a sequential /ralph loop in a dedicated git worktree (`hardening/phase-1` off `main@218f7ad`), with the Codex CLI as sole implementer (one `codex exec` task per plan item, 40-minute timeout, workspace-write sandbox scoped to the worktree) and Claude as orchestrator-verifier that composes prompts from the in-repo plan document, runs the verify gates, **audits every Codex-authored test against the plan item's acceptance bullets, red-proves the behavior-change items (T1/T6/T7)**, reviews the change surface via `git status --porcelain` against per-item allowlists, stages explicitly, and commits one conventional commit per item. Done = seven audited commits + full suite green + PR opened, then `RALPH_COMPLETE`; any block or T8-red ends in escalation with the branch intact.

**Drivers.** (1) User mandate for the Codex-implements/Claude-orchestrates shape in an isolated worktree driven by /ralph; (2) the approved plan's per-item acceptance criteria and pinned verify commands make a mechanical gate feasible; (3) review finding: without test auditing, implementer/verifier separation is provenance rather than substance — the implementer would author the very tests that grade it.

**Alternatives considered.** *Claude implements directly* — rejected: contradicts the mandate and collapses the separation. *Mixed routing* — rejected: two write-paths muddy commit-trail provenance for one trivial item. *v1's unaudited gate* — superseded in round 1: it let a half-implementation with weak tests pass every layer and let retries Goodhart toward gate-passing.

**Why chosen.** It is the only shape that satisfies the mandate while making the separation enforceable: the audit (bullet→test checklist), the red-proof (reverted implementation must fail the tests), the no-weakening clause in every prompt, and the untracked-file-aware surface review together ensure a commit means "the plan item's behavior is demonstrably implemented and tested," not "a suite went green."

**Consequences.** Positive: per-item bisectable trail, human review reduced to a seven-commit PR plus a run log with evidence per acceptance bullet; the main checkout and the orchestrator's own tooling are structurally insulated from the run. Negative/accepted: per-item orchestration overhead (audit + red-proof) lengthens the run; the 3-pass/40-minute caps may block items that a longer budget would land (deliberate — escalation over silent burn); T6/T7 intentionally share test files (cap-pinning tests), handled as a sanctioned in-spec update rather than a violation.

**Follow-ups.** Phases 2–3 as separate ralph runs reusing this shape; V1/V2 spikes when an interactive Copilot session is available (V1 unblocks the plugin.json hooks-removal decision; V2 unblocks A6); PR merge, release notes (B2 breaking change; A2 three-mode semantics), and version bump remain human decisions; the run log format established here becomes the template for subsequent runs.

---

## 6. Notes for Execution (from final consensus review)

1. **Red-proof stash must include untracked files (REQUIRED, not hygiene):** use `git stash push -u -- <paths>`. Without `-u`, stashing a *new* non-test file (e.g. T6's extracted guard helper) errors outright — untracked paths aren't known to git — and `-u` also correctly removes the new file for the revert, which is the intended pre-item state.
2. **Post-commit cleanliness assert:** immediately after each item's commit, assert `git status --porcelain` is empty in the worktree — residue would surface as a phantom surface violation charged to the *next* item's retry budget.
3. **Gitignore the run log dir** in the orchestrating repo (`.ralph-runs/`) before T0.
4. **Stash-pop conflicts during red-proof restore:** escalate, don't improvise — the branch state is the diagnostic.
5. **ADR status lines** in this doc and the content plan record final consensus outcomes (done at commit time).
