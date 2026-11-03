---
name: security-audit
description: Source-first security review of a codebase, API, service, or CLI. Use with /security-audit for security questions, focused reviews, or a full audit. Only confirms findings that cross a real trust boundary.
---

# Security Audit

Condensed from [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill) (MIT). Use the upstream skill for the full multi-agent harness, coverage ledger, and JSON validators.

Goal: find vulnerabilities that cross a real trust boundary, with source evidence, a safe repro, and the smallest fix. A candidate with no concrete victim, resource, or outcome is not a finding.

## Modes

- **Guidance (default)**: answer the question or review the named code. Write no files and do not run all phases.
- **Full audit**: only when the user explicitly asks for an audit, pen test, or a report. Run all phases below. If unclear, ask one question first.

## Safety rules (both modes)

- Reading source is always fine.
- Run target code (builds, tests, fuzzers) only in an OS sandbox: no network, empty allowlisted env, read-only target, writes only to a scratch dir, CPU/memory/time limits. If you can't sandbox it, don't run it; report `needs_validation` with a plan.
- Use dummy users, data, and secrets. Never probe live endpoints, prod, or shared infra. Never install dependencies from the target.
- Stop at the minimum effect that proves the defect (wrong return, unauthorized dummy record, sanitizer hit). No persistence or exploit chains.

## Every candidate needs

1. Lower-trust actor
2. Input or action they control
3. Intended control (authz check, validation, isolation)
4. Boundary crossed
5. Affected principal or resource
6. Observed result (source trace or sandboxed local test)

Missing best practice, generic crash, self-impact only, or guessed deployment behavior is **not** a finding. If the deciding fact is outside the repo (proxy, IAM, headers), mark `needs_validation` and name the exact missing fact.

## Phases (full audit)

1. **Recon**: map entry points, trust boundaries, authn/authz, data stores, secrets, parsers, external calls, build/release path. Write `architecture.md`.
2. **Hunt**: go surface by surface, checking attack classes: injection, authz/IDOR, authn/session, SSRF, path traversal, deserialization, memory safety, crypto misuse, secrets, supply chain/CI, tenant isolation, resource exhaustion, LLM prompt injection/tool abuse, client-side (XSS/CSRF), IPC/local privilege. Track which surfaces are covered and which are not.
3. **Validate**: for each candidate, try to *disprove* it (ideally with a separate fresh agent). Look for upstream checks, unreachable paths, or non-attacker-controlled input.
4. **Classify**: `confirmed` (boundary failure shown), `needs_validation` (blocker named), `rejected` (with reason).
5. **Re-verify** confirmed items against the current source, quoting file and line.
6. **Report**: write outside the target (e.g. `~/security-audit/<repo>/run-N/REPORT.md`), never inside it unless git-ignored. Per finding: title, severity tied to impact, `file:line` evidence, safe repro, minimal fix. End with an honest coverage statement. One pass never proves the rest is clean.

## Severity

Rate by impact and attacker precondition: unauthenticated remote > authenticated cross-tenant > local/privileged. Downgrade when exploitation needs unlikely preconditions.

## Output rules

- Lead with confirmed findings, then `needs_validation`, then coverage gaps.
- Quote the code. No vague claims.
- Say plainly what was and wasn't checked.
