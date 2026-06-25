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

Two axes are scored:
  applied = did the skill's prescribed PROCESS show up (a real test written / the bug caught
            with a verdict / a real plan, stopped before implementing)?
  correct = is the OUTCOME sound? Deliberately demanding so it does not saturate at 1.0 --
            the impl must handle the easy-to-miss edge cases (accents), the review must catch
            BOTH planted defects, the plan must cover the security specifics. A skill earns
            its keep when it lifts these over the baseline AND over a one-line prompt.

Task fields:
  skill   : which omp skill this exercises (tdd | code-review | ralplan)
  prompt  : instruction handed to the agent
  file    : entry file/artifact the scorer reads (a produced file, or _result.txt for chat)
  seed    : {filename: starter content} written before the agent runs
  reads   : "files" (scorer reads produced files) or "chat" (scorer reads the agent's reply)
  axis    : dimension good/bad differ on for --selftest -- "applied" (default) or "correct"
  score   : (workdir) -> {applied, correct, reason, **extra}
  good/bad : reference artifacts for the selftest. good must score applied+correct;
             bad must be CAUGHT on `axis` (the lazy-but-plausible output a no-skill arm ships).
  adversarial : [{name, file, extra}] -- gameable-but-wrong artifacts the scorer MUST reject
                (applied=0). The false positives a keyword-only scorer would pass.

run.py --selftest proves good passes / bad is caught / adversarial is rejected before any
API spend.
"""
import hashlib
import json
import re
import subprocess
import sys
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


def _is_test_file(p):
    """Recognize a real test file by name or by living in a tests/ dir."""
    n = p.name.lower()
    if n.startswith(".") or n.startswith("_"):
        return False
    return bool(
        n.startswith("test_") or n.endswith("_test.py") or n.endswith(".test.js")
        or n.endswith(".test.ts") or n.endswith(".spec.ts") or n.endswith(".spec.js")
        or n == "conftest.py" or "test" in p.parent.name.lower()
    )


def _test_files(workdir):
    return [p for p in Path(workdir).rglob("*")
            if p.is_file() and _is_test_file(p)
            and "__pycache__" not in p.parts and "node_modules" not in p.parts]


def _has_test_file(workdir):
    """Did the agent create a recognizable test file (not just the seed)?"""
    return bool(_test_files(workdir))


def _strip_comments(text, kind):
    """Drop whole-line comments so a commented-out `# assert` is not counted as a test."""
    marker = "#" if kind == "py" else "//"
    return "\n".join(ln for ln in text.splitlines() if not ln.strip().startswith(marker))


def _count_asserts_in_tests(workdir):
    """Count assertion-like statements ONLY inside recognized test files (not the
    implementation), ignoring commented-out lines -- a proxy for 'wrote real tests'
    rather than 'left an `assert` in the impl' or a commented placeholder."""
    total = 0
    for p in _test_files(workdir):
        try:
            raw = p.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        kind = "py" if p.suffix == ".py" else "js"
        txt = _strip_comments(raw, kind)
        total += len(re.findall(r"\b(assert|expect\s*\(|\.toBe|\.toEqual|self\.assert)", txt))
    return total


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


def _digest(text):
    return hashlib.sha256(text.strip().encode("utf-8", "ignore")).hexdigest()


# ======================================================================================
# tdd -- prescribes red-green-refactor: there MUST be a test, and the implementation MUST
#        be correct. Hardened: the spec now requires transliterating accented Latin letters
#        to ASCII (cafe, not caf), which a naive `[^a-z0-9]`-strip impl gets wrong -- so
#        `correct` no longer saturates and a test-first agent (which probes the accent case)
#        has room to beat a blind one.
# ======================================================================================
TDD_SEED = (
    "def slugify(text):\n"
    '    """Turn a title into a URL slug: lowercase, spaces->hyphens, strip punctuation,\n'
    '    transliterate accented Latin letters to ASCII, collapse repeated hyphens, trim\n'
    '    leading/trailing hyphens. Empty -> empty string."""\n'
    "    raise NotImplementedError\n"
)
# NOTE: the prompt is deliberately NEUTRAL -- it points at the docstring but does NOT spell out
# the hard requirement (accent transliteration). That requirement lives in the spec (TDD_SEED
# docstring) only, so a careful, test-first process must SURFACE it. Spelling it out here would
# let even an unguided agent pass and saturate `correct`.
TDD_PROMPT = (
    "The file slugify.py has an unimplemented slugify(text) function. Implement it to match its "
    "docstring exactly. Do this properly."
)

_SLUG_CASES = [
    ("Hello World", "hello-world"),
    ("  Multiple   Spaces  ", "multiple-spaces"),
    ("Already-Sluggy", "already-sluggy"),
    ("Punctuation!!! Here?", "punctuation-here"),
    ("under_score_words", "under-score-words"),
    ("---trim---", "trim"),
    ("!!!", ""),
    ("", ""),
    # the de-saturating edge cases: accented Latin must transliterate, not vanish.
    ("Café René", "cafe-rene"),
    ("Naïve Façade", "naive-facade"),
    ("Zürich", "zurich"),
]

# Run the model-produced slugify in a FRESH, SANDBOXED subprocess with a hard timeout.
# Importing untrusted code in-process (exec_module) let a top-level side effect or an
# infinite loop hang/poison the benchmark runner; a subprocess contains both.
_SLUG_RUNNER = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
try:
    from slugify import slugify
except Exception as e:
    print(json.dumps({"error": "import: " + str(e)[:200]})); raise SystemExit(0)
cases = json.loads(sys.argv[2])
out = []
for inp, exp in cases:
    try:
        out.append([inp, slugify(inp), exp])
    except Exception as e:
        print(json.dumps({"error": "raised: " + str(e)[:200]})); raise SystemExit(0)
print(json.dumps({"results": out}))
"""


def _run_slug_cases(workdir, cases, timeout=10):
    """Return (correct: bool, reason: str). Never raises; a hang is killed by `timeout`."""
    p = Path(workdir) / "slugify.py"
    if not p.exists():
        return False, "slugify.py missing"
    try:
        r = subprocess.run(
            [sys.executable, "-c", _SLUG_RUNNER, str(Path(workdir).resolve()), json.dumps(cases)],
            capture_output=True, text=True, timeout=timeout, cwd=str(workdir),
        )
    except subprocess.TimeoutExpired:
        return False, "implementation hung (timeout)"
    except Exception as e:
        return False, f"sandbox error: {str(e)[:120]}"
    try:
        data = json.loads((r.stdout or "").strip().splitlines()[-1])
    except Exception:
        return False, f"no parseable result (rc={r.returncode})"
    if "error" in data:
        return False, data["error"]
    fails = [inp for inp, got, exp in data.get("results", []) if got != exp]
    return (not fails), ("all cases pass" if not fails else f"wrong on {len(fails)} case(s) e.g. {fails[:1]}")


def score_tdd(workdir):
    correct, why = _run_slug_cases(workdir, _SLUG_CASES)
    if why == "slugify.py missing":
        return _fail("slugify.py missing or stub left")
    wrote_test = _has_test_file(workdir)
    asserts = _count_asserts_in_tests(workdir)
    # "applied" the tdd skill = it left a REAL test (asserts inside a test file), not just an
    # implementation and not a commented placeholder.
    applied = wrote_test and asserts >= 1
    return _ok(applied, correct,
               reason=f"correct={correct} ({why}) wrote_test={wrote_test} test_asserts={asserts}",
               wrote_test=int(wrote_test), asserts=asserts)


# good ref: correct (accent-aware) impl + a real test file sibling (selftest seeds both)
TDD_GOOD = (
    "import re, unicodedata\n"
    "def slugify(text):\n"
    "    s = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode('ascii')\n"
    "    s = s.lower()\n"
    "    s = re.sub(r'[\\s_]+', '-', s)\n"
    "    s = re.sub(r'[^a-z0-9-]', '', s)\n"
    "    s = re.sub(r'-+', '-', s)\n"
    "    return s.strip('-')\n"
)
TDD_GOOD_TEST = (
    "from slugify import slugify\n"
    "def test_basic():\n"
    "    assert slugify('Hello World') == 'hello-world'\n"
    "def test_accents():\n"
    "    assert slugify('Café René') == 'cafe-rene'\n"
    "def test_empty():\n"
    "    assert slugify('!!!') == ''\n"
)
# bad ref: a "works on the happy path" one-liner with NO test -> tdd skill NOT applied, and it
# also fails the accent cases so correct=0.
TDD_BAD = (
    "def slugify(text):\n"
    "    return text.lower().replace(' ', '-')\n"
)
# adversarial: a CORRECT impl, but the only "test" is a placeholder whose assert is commented
# out -> the skill was not really applied. A name/keyword-only scorer would pass this.
TDD_ADV_TEST = (
    "from slugify import slugify\n"
    "def test_placeholder():\n"
    "    # assert slugify('Hello World') == 'hello-world'\n"
    "    pass\n"
)


# ======================================================================================
# code-review -- prescribes catching blockers/security/regressions and emitting a structured
#                verdict. Hardened: the seed now has TWO defects -- (1) a SQL injection and
#                (2) `SELECT *` returning password_hash to the caller. `applied` = it flagged
#                the injection (with a real fix) AND used a verdict; `correct` = a THOROUGH
#                review that also catches the data-exposure, so it does not saturate.
# ======================================================================================
CR_VULN_FILE = (
    "import sqlite3\n"
    "# users table columns: id, name, email, password_hash, is_admin\n"
    "def get_user(db_path, username):\n"
    "    conn = sqlite3.connect(db_path)\n"
    "    cur = conn.cursor()\n"
    "    # builds SQL by string concatenation -- injectable\n"
    "    cur.execute(\"SELECT * FROM users WHERE name = '\" + username + \"'\")\n"
    "    return cur.fetchall()  # returns every column, incl. password_hash, to the caller\n"
)
# NEUTRAL prompt: it does NOT hint at the second defect (the SELECT * password_hash exposure).
# Catching it must come from a thorough review process, not from being told.
CR_PROMPT = (
    "Review the change in users.py before we merge it. Produce a review verdict and write it to a "
    "file named review.md."
)

# Phrases that mean "I did NOT find the injection" -- a review containing these (and no
# remediation) is the lazy false-positive a keyword scorer would wrongly pass.
_CR_NEGATED = re.compile(
    r"no (sql )?injection|not (vulnerable|injectable|exploitable)|no (security|sql) (issue|problem|vuln)"
    r"|looks (good|fine)|ship it|lgtm|safe to merge",
)
# A real fix being proposed -- the discriminator a genuine reviewer always includes.
_CR_REMEDIATION = re.compile(
    r"parameteri[sz]|prepared statement|bind (param|variable)|placeholder|bound parameter"
    r"|execute\([^)]*\?|where name = \?",
)
_CR_NAMES_DEFECT = re.compile(r"sql injection|sqli|string concatenation|concatenat")
# The SECOND defect: SELECT * leaks password_hash to the caller. A thorough review names it.
_CR_SECOND = re.compile(
    r"password_hash|select \*|select\*|every column|all columns|sensitive (column|data|field)"
    r"|over[- ]?broad|leak|data exposure|exposes",
)
# Standard review verdicts (any one is fine) -- including the previously false-failed ones.
_CR_VERDICT = re.compile(
    r"\b(pass|fail|blocker|reject|approve)\b|needs[ _]changes|request[ _]changes|must[ -]fix",
)


def score_code_review(workdir):
    txt = (_read(workdir, "review.md") or _read(workdir, "_result.txt")
           or _all_text(workdir, (".md", ".txt"))).lower()
    if not txt.strip():
        return _fail("no review.md / review text produced")
    names_defect = bool(_CR_NAMES_DEFECT.search(txt))
    remediation = bool(_CR_REMEDIATION.search(txt))
    negated = bool(_CR_NEGATED.search(txt))
    second = bool(_CR_SECOND.search(txt))
    # caught the PRIMARY defect = names the injection AND proposes the parameterized fix AND is
    # not a negated "no injection here" review. (Kills "Verdict: PASS. No SQL injection found.")
    caught = names_defect and remediation and not negated
    has_verdict = bool(_CR_VERDICT.search(txt))
    structured = has_verdict and bool(re.search(r"blocking|verdict|non-blocking|evidence", txt))
    applied = caught and has_verdict
    # "correct" = a THOROUGH review: caught the injection AND the data-exposure second defect.
    correct = caught and second
    return _ok(applied, correct,
               reason=f"caught={caught} (names={names_defect} fix={remediation} neg={negated}) "
                      f"second={second} verdict={has_verdict} structured={structured}",
               caught_injection=int(caught), caught_second=int(second), structured=int(structured))


# good ref: names BOTH defects, with fixes and a verdict structure
CR_GOOD = (
    "# Code Review\n\n"
    "Verdict: BLOCKER\n\n"
    "## Blocking\n"
    "- SQL injection in get_user: the query is built by string concatenation of `username`. "
    "An input like `' OR '1'='1` leaks every row. Use a parameterized query "
    "(`cur.execute('SELECT * FROM users WHERE name = ?', (username,))`).\n"
    "- Data exposure: `SELECT *` returns every column including `password_hash` to the caller. "
    "Select only the needed columns (id, name, email).\n\n"
    "## Non-blocking\n- Connection is never closed.\n\n"
    "## Evidence reviewed\n- users.py diff\n"
)
# bad ref: the lazy "looks fine" review that misses everything -> skill NOT applied
CR_BAD = (
    "# Review\n\nLooks good to me, the function reads a user by name and returns the rows. "
    "Ship it.\n"
)
# adversarial: a confident verdict that explicitly clears the (real) bug. Names "injection"
# and "pass" -- exactly what a bare-keyword scorer rewards -- but is dead wrong.
CR_ADV = (
    "# Code Review\n\nVerdict: PASS\n\n"
    "I checked get_user for problems. No SQL injection found; the function is not vulnerable. "
    "Approved, safe to merge.\n"
)


# ======================================================================================
# ralplan -- prescribes an implementation-ready PLAN (slices, acceptance criteria, test shape,
#            risks) and to STOP at the plan. Hardened: `correct` now also requires the plan to
#            cover the SECURITY specifics this feature actually needs (token expiry, single-use/
#            replay protection, and email-enumeration / rate-limiting), so a generic
#            plan-shaped answer is `applied` but not `correct`.
# ======================================================================================
RALPLAN_SEED_A = "# app.py\n# existing flask app (stub for planning)\n"
RALPLAN_SEED_B = "# auth.py\n# existing auth helpers (stub for planning)\n"
# NEUTRAL prompt: it does NOT enumerate the security specifics (expiry / replay / rate-limit).
# A thorough planning process must raise them unprompted.
RALPLAN_PROMPT = (
    "We need to add password-reset-by-email to this Flask app (touches app.py routes, auth.py "
    "token logic, and a new email sender). Produce an implementation-ready plan first -- do not "
    "write the implementation yet. Write the plan to a file named plan.md."
)

_RALPLAN_SEEDS = {"app.py": RALPLAN_SEED_A, "auth.py": RALPLAN_SEED_B}
# The plan must be anchored to THIS task, not generic plan-shaped boilerplate.
_RALPLAN_ANCHORS = re.compile(r"token|reset|email|expir|password|/forgot|/reset|route")
# The security specifics a THOROUGH plan covers (>=2 needed for `correct`).
_RALPLAN_SECURITY = (
    re.compile(r"expir|ttl|time[- ]?to[- ]?live"),
    re.compile(r"single[- ]?use|one[- ]?time|replay|invalidat|nonce|consumed"),
    re.compile(r"enumerat|rate[- ]?limit|throttle|timing"),
)


def _wrote_implementation(workdir, seeds):
    """Did the agent go past planning and write real code (content that differs from the
    seed and is more than a stray line)? Compares against seed digests instead of a blanket
    line-count so editing a seed file into a real implementation is also caught."""
    seed_digests = {_digest(c) for c in seeds.values()}
    for p in Path(workdir).rglob("*.py"):
        if p.name.startswith((".", "_")) or "__pycache__" in p.parts:
            continue
        txt = p.read_text(encoding="utf-8", errors="ignore")
        if _digest(txt) in seed_digests:
            continue  # untouched seed
        body = [ln for ln in txt.splitlines() if ln.strip() and not ln.strip().startswith("#")]
        if len(body) >= 1:
            return True
    return False


def score_ralplan(workdir):
    txt = (_read(workdir, "plan.md") or _read(workdir, "_result.txt")
           or _all_text(workdir, (".md", ".txt"))).lower()
    if not txt.strip():
        return _fail("no plan.md / plan text produced")
    has_slices = bool(re.search(r"slice|step|phase|\b1\.|order", txt))
    has_accept = bool(re.search(r"acceptance|criteria|done when|must be true", txt))
    has_tests = bool(re.search(r"test", txt))
    has_risks = bool(re.search(r"risk|tradeoff|trade-off|alternativ|could go wrong", txt))
    sections = sum([has_slices, has_accept, has_tests, has_risks])
    anchors = len(set(_RALPLAN_ANCHORS.findall(txt)))
    security = sum(bool(rx.search(txt)) for rx in _RALPLAN_SECURITY)
    implemented = _wrote_implementation(workdir, _RALPLAN_SEEDS)
    # applied = the 4 plan sections (>=3), anchored to the actual task, AND stopped at the plan.
    applied = sections >= 3 and anchors >= 2 and not implemented
    # "correct" = a THOROUGH, task-specific plan: also covers >=2 of the security specifics.
    correct = sections >= 3 and anchors >= 2 and security >= 2
    return _ok(applied, correct,
               reason=f"sections={sections}/4 anchors={anchors} security={security}/3 implemented={implemented}",
               sections=sections, anchors=anchors, security=security, stopped_at_plan=int(not implemented))


RALPLAN_GOOD = (
    "# Plan: password reset by email\n\n"
    "## Plan (slices, in order)\n"
    "1. auth.py: add `make_reset_token(user)` / `verify_reset_token(token)` (signed, expiring).\n"
    "2. email sender module: `send_reset_email(user, token)`.\n"
    "3. app.py: POST /forgot route issues token+email; POST /reset route verifies and sets password.\n\n"
    "## Acceptance criteria\n- A valid token within its TTL resets the password; an expired or "
    "tampered token is rejected; a token is single-use (invalidated after a successful reset).\n\n"
    "## Test shape\n- unit: token round-trip, expiry, tamper, replay (second use rejected). "
    "integration: /forgot then /reset happy path.\n\n"
    "## Risks\n- Email enumeration via /forgot timing/response -- return a generic response and "
    "rate-limit the route. Token leakage in logs. Tradeoff: stateless signed token vs DB-stored "
    "single-use token (chose DB-stored so it can be invalidated/consumed).\n"
)
# bad ref: it skipped planning and just narrated that it implemented it -> skill NOT applied
RALPLAN_BAD = (
    "# Done\n\nI added the reset routes and token logic. It works.\n"
)
# adversarial: plan-shaped word salad that hits every section keyword but plans NOTHING
# about this task -> must fail on the anchor check.
RALPLAN_ADV = (
    "# Plan\n\n## Steps\n1. Do the thing in order.\n\n"
    "## Acceptance criteria\n- It is done when it must be true.\n\n"
    "## Tests\n- Add a test.\n\n## Risks\n- There is a tradeoff and it could go wrong.\n"
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
        "adversarial": [
            {"name": "correct-impl-placeholder-test", "file": TDD_GOOD,
             "extra": {"test_slugify.py": TDD_ADV_TEST}},
        ],
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
        "adversarial": [
            {"name": "confident-pass-no-injection", "file": CR_ADV, "extra": {}},
        ],
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
        "adversarial": [
            {"name": "plan-shaped-word-salad", "file": RALPLAN_ADV, "extra": {}},
        ],
    },
}
