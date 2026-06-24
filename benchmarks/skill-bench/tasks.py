#!/usr/bin/env python3
"""Tasks for the omp skill benchmark.

Adapted from DietrichGebert/ponytail's agentic benchmark (MIT). Where ponytail measures
"does the skill make the agent write LESS code", this measures "does the skill make the
agent do the JOB THE SKILL PRESCRIBES" -- because omp's skills are process/orchestration
skills (tdd, code-review, ralplan, ...), not code-compression skills.

Each task is a realistic "do this job in this workspace" prompt. The workspace is seeded
with a starter file the agent must work against, which (a) forces a real artifact, (b)
guarantees something scorable, and (c) makes an agent that narrates "done" without acting
fail honestly. The scorer is DETERMINISTIC and stdlib-only wherever possible; an LLM judge
(judge.py) handles only the axes that resist a deterministic check (e.g. plan quality).

Task fields:
  skill   : which omp skill this exercises (tdd | code-review | ralplan)
  prompt  : instruction handed to the agent
  file    : entry file/artifact the scorer reads (a produced file, or _result.txt for chat)
  seed    : {filename: starter content} written before the agent runs
  reads   : "files" (scorer reads produced files) or "chat" (scorer reads the agent's reply)
  axis    : dimension good/bad differ on for --selftest -- "applied" (default) or "correct"
  score   : (workdir) -> {applied, correct, reason, **extra}
            applied = did the skill's prescribed behaviour show up (tests written / bug
                      caught / plan emitted)? correct = is the produced artifact sound?
  good/bad : reference artifacts for the selftest. good must score applied+correct;
             bad must be CAUGHT on `axis` (the lazy-but-plausible output a no-skill arm ships).

run.py --selftest proves good passes / bad is caught before any API spend.
"""
import json, re
from pathlib import Path


# --- helpers -------------------------------------------------------------------------
def _fail(reason):
    return {"applied": 0, "correct": 0, "reason": reason}


def _ok(applied, correct, reason="ok", **extra):
    return {"applied": int(bool(applied)), "correct": int(bool(correct)), "reason": reason, **extra}


def _read(workdir, name):
    p = Path(workdir) / name
    try:
        return p.read_text(encoding="utf-8", errors="ignore") if p.exists() else ""
    except Exception:
        return ""


def _all_text(workdir, suffixes=(".py", ".js", ".ts", ".md", ".txt")):
    """Concatenate every produced text artifact (skips seeds-as-fixtures handled by caller)."""
    out = []
    for p in sorted(Path(workdir).rglob("*")):
        if not p.is_file() or p.suffix not in suffixes:
            continue
        if "__pycache__" in p.parts or "node_modules" in p.parts:
            continue
        try:
            out.append(p.read_text(encoding="utf-8", errors="ignore"))
        except Exception:
            pass
    return "\n".join(out)


def _has_test_file(workdir):
    """Did the agent create a recognizable test file (not just the seed)?"""
    for p in Path(workdir).rglob("*"):
        if not p.is_file():
            continue
        n = p.name.lower()
        if n.startswith(".") or n.startswith("_"):
            continue
        if (n.startswith("test_") or n.endswith("_test.py") or n.endswith(".test.js")
                or n.endswith(".test.ts") or n.endswith(".spec.ts") or n.endswith(".spec.js")
                or n == "conftest.py" or "test" in p.parent.name.lower()):
            return True
    return False


def _count_asserts(workdir):
    """Rough count of assertion-like statements across produced test files -- a proxy for
    'wrote real tests' rather than an empty placeholder."""
    txt = _all_text(workdir, (".py", ".js", ".ts"))
    return len(re.findall(r"\b(assert|expect\s*\(|\.toBe|\.toEqual|self\.assert)", txt))


# ======================================================================================
# tdd -- the skill prescribes red-green-refactor: there MUST be a test, and the
#        implementation MUST be correct. We seed a stub + a known bug spec.
# ======================================================================================
TDD_SEED = (
    "def slugify(text):\n"
    '    """Turn a title into a URL slug: lowercase, spaces->hyphens, strip punctuation,\n'
    '    collapse repeated hyphens, trim leading/trailing hyphens. Empty -> empty string."""\n'
    "    raise NotImplementedError\n"
)
TDD_PROMPT = (
    "The file slugify.py has an unimplemented slugify(text) function. Implement it to match its "
    "docstring exactly: lowercase, spaces and underscores become single hyphens, drop any character "
    "that is not a letter, digit or hyphen, collapse runs of hyphens into one, and strip leading/"
    "trailing hyphens. An empty or all-punctuation input returns an empty string. Do this properly."
)


def _slug_fn(workdir):
    """Import the produced slugify and return the callable, or None."""
    import importlib.util
    p = Path(workdir) / "slugify.py"
    if not p.exists():
        return None
    try:
        spec = importlib.util.spec_from_file_location("produced_slug", str(p))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        fn = getattr(mod, "slugify", None)
        return fn if callable(fn) else None
    except Exception:
        return None


def score_tdd(workdir):
    fn = _slug_fn(workdir)
    if fn is None:
        return _fail("slugify.py missing, stub left, or import error")
    cases = [
        ("Hello World", "hello-world"),
        ("  Multiple   Spaces  ", "multiple-spaces"),
        ("Already-Sluggy", "already-sluggy"),
        ("Punctuation!!! Here?", "punctuation-here"),
        ("under_score_words", "under-score-words"),
        ("---trim---", "trim"),
        ("!!!", ""),
        ("", ""),
    ]
    try:
        correct = all(fn(inp) == exp for inp, exp in cases)
    except Exception as e:
        return _fail(f"implementation raised: {e}")
    wrote_test = _has_test_file(workdir)
    asserts = _count_asserts(workdir)
    # "applied" the tdd skill = it left a real test behind, not just an implementation.
    applied = wrote_test and asserts >= 1
    return _ok(applied, correct,
               reason=f"correct={correct} wrote_test={wrote_test} asserts={asserts}",
               wrote_test=int(wrote_test), asserts=asserts)


# good ref: correct impl + a real test file sibling (selftest seeds both)
TDD_GOOD = (
    "import re\n"
    "def slugify(text):\n"
    "    s = text.lower()\n"
    "    s = re.sub(r'[\\s_]+', '-', s)\n"
    "    s = re.sub(r'[^a-z0-9-]', '', s)\n"
    "    s = re.sub(r'-+', '-', s)\n"
    "    return s.strip('-')\n"
)
TDD_GOOD_TEST = (
    "from slugify import slugify\n"
    "def test_basic():\n"
    "    assert slugify('Hello World') == 'hello-world'\n"
    "def test_empty():\n"
    "    assert slugify('!!!') == ''\n"
)
# bad ref: a "works on the happy path" one-liner with NO test -> tdd skill NOT applied.
TDD_BAD = (
    "def slugify(text):\n"
    "    return text.lower().replace(' ', '-')\n"
)


# ======================================================================================
# code-review -- the skill prescribes catching blockers/security/regressions and emitting
#                a structured verdict. We seed a diff containing a real SQL-injection bug
#                and ask for a review. "applied" = it flagged the injection AND used the
#                verdict structure.
# ======================================================================================
CR_VULN_FILE = (
    "import sqlite3\n"
    "def get_user(db_path, username):\n"
    "    conn = sqlite3.connect(db_path)\n"
    "    cur = conn.cursor()\n"
    "    # builds SQL by string concatenation -- injectable\n"
    "    cur.execute(\"SELECT * FROM users WHERE name = '\" + username + \"'\")\n"
    "    return cur.fetchall()\n"
)
CR_PROMPT = (
    "Review the change in users.py before we merge it. Produce a review verdict. Be specific about "
    "anything that must be fixed before merge. Write your review to a file named review.md."
)


def score_code_review(workdir):
    txt = (_read(workdir, "review.md") or _read(workdir, "_result.txt") or _all_text(workdir, (".md", ".txt"))).lower()
    if not txt.strip():
        return _fail("no review.md / review text produced")
    # caught the actual defect?
    caught = bool(re.search(r"sql injection|sqli|parameteri|injection|concatenat|bind parameter|prepared statement", txt))
    # used the skill's structured verdict?
    has_verdict = bool(re.search(r"\b(pass|needs_changes|needs changes|blocker)\b", txt))
    structured = has_verdict and bool(re.search(r"blocking|verdict|non-blocking|evidence", txt))
    applied = caught and has_verdict
    return _ok(applied, caught,
               reason=f"caught_injection={caught} has_verdict={has_verdict} structured={structured}",
               caught_injection=int(caught), structured=int(structured))


# good ref: a review that names the injection and uses the verdict structure
CR_GOOD = (
    "# Code Review\n\n"
    "Verdict: BLOCKER\n\n"
    "## Blocking\n"
    "- SQL injection in get_user: the query is built by string concatenation of `username`. "
    "An input like `' OR '1'='1` leaks every row. Use a parameterized query "
    "(`cur.execute('SELECT * FROM users WHERE name = ?', (username,))`).\n\n"
    "## Non-blocking\n- Connection is never closed.\n\n"
    "## Evidence reviewed\n- users.py diff\n"
)
# bad ref: the lazy "looks fine" review that misses the injection -> skill NOT applied
CR_BAD = (
    "# Review\n\nLooks good to me, the function reads a user by name and returns the rows. "
    "Ship it.\n"
)


# ======================================================================================
# ralplan -- the skill prescribes an implementation-ready PLAN (slices, acceptance criteria,
#            test shape, risks) and to STOP at the plan (not implement). We ask for a plan
#            for a multi-file change. "applied" = the plan has the prescribed sections AND
#            the agent did not start editing code.
# ======================================================================================
RALPLAN_SEED_A = "# app.py\n# existing flask app (stub for planning)\n"
RALPLAN_SEED_B = "# auth.py\n# existing auth helpers (stub for planning)\n"
RALPLAN_PROMPT = (
    "We need to add password-reset-by-email to this Flask app (touches app.py routes, auth.py "
    "token logic, and a new email sender). Produce an implementation-ready plan first -- do not "
    "write the implementation yet. Write the plan to a file named plan.md."
)


def _wrote_implementation(workdir):
    """Did the agent go past planning and actually write real code (more than the seeds)?"""
    for p in Path(workdir).rglob("*.py"):
        if p.name.startswith((".", "_")):
            continue
        txt = p.read_text(encoding="utf-8", errors="ignore")
        body = [ln for ln in txt.splitlines() if ln.strip() and not ln.strip().startswith("#")]
        # seeds are comment-only; any non-trivial code body means it implemented
        if len(body) > 2:
            return True
    return False


def score_ralplan(workdir):
    txt = (_read(workdir, "plan.md") or _read(workdir, "_result.txt") or _all_text(workdir, (".md", ".txt"))).lower()
    if not txt.strip():
        return _fail("no plan.md / plan text produced")
    has_slices = bool(re.search(r"slice|step|phase|\b1\.|order", txt))
    has_accept = bool(re.search(r"acceptance|criteria|done when|must be true", txt))
    has_tests = bool(re.search(r"test", txt))
    has_risks = bool(re.search(r"risk|tradeoff|trade-off|alternativ|could go wrong", txt))
    sections = sum([has_slices, has_accept, has_tests, has_risks])
    implemented = _wrote_implementation(workdir)
    # applied the ralplan skill = produced the 4 plan sections AND stopped at the plan.
    applied = sections >= 3 and not implemented
    # "correct" here = it is a usable plan (>=3 of the 4 prescribed sections present)
    correct = sections >= 3
    return _ok(applied, correct,
               reason=f"sections={sections}/4 implemented={implemented}",
               sections=sections, stopped_at_plan=int(not implemented))


RALPLAN_GOOD = (
    "# Plan: password reset by email\n\n"
    "## Plan (slices, in order)\n"
    "1. auth.py: add `make_reset_token(user)` / `verify_reset_token(token)` (signed, expiring).\n"
    "2. email sender module: `send_reset_email(user, token)`.\n"
    "3. app.py: POST /forgot route issues token+email; POST /reset route verifies and sets password.\n\n"
    "## Acceptance criteria\n- A valid token within TTL resets the password; an expired/tampered token is rejected.\n\n"
    "## Test shape\n- unit: token round-trip, expiry, tamper. integration: /forgot then /reset happy path.\n\n"
    "## Risks\n- Token leakage in logs; email enumeration. Tradeoff: stateless signed token vs DB-stored token (chose signed).\n"
)
# bad ref: it skipped planning and just narrated that it implemented it -> skill NOT applied
RALPLAN_BAD = (
    "# Done\n\nI added the reset routes and token logic. It works.\n"
)


# ======================================================================================
TASKS = {
    "tdd-slugify": {
        "skill": "tdd",
        "prompt": TDD_PROMPT,
        "file": "slugify.py",
        "reads": "files",
        "seed": {"slugify.py": TDD_SEED},
        "axis": "applied",
        "score": score_tdd,
        # selftest seeds the entry file with the ref AND a test sibling for the good case.
        "good": TDD_GOOD,
        "good_extra": {"test_slugify.py": TDD_GOOD_TEST},
        "bad": TDD_BAD,
    },
    "code-review-sqli": {
        "skill": "code-review",
        "prompt": CR_PROMPT,
        "file": "review.md",
        "reads": "files",
        "seed": {"users.py": CR_VULN_FILE},
        "axis": "applied",
        "score": score_code_review,
        "good": CR_GOOD,
        "bad": CR_BAD,
    },
    "ralplan-pwreset": {
        "skill": "ralplan",
        "prompt": RALPLAN_PROMPT,
        "file": "plan.md",
        "reads": "files",
        "seed": {"app.py": RALPLAN_SEED_A, "auth.py": RALPLAN_SEED_B},
        "axis": "applied",
        "score": score_ralplan,
        "good": RALPLAN_GOOD,
        "bad": RALPLAN_BAD,
    },
}
