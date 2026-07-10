#!/usr/bin/env python3
"""Self-contained HTML report for the skill-bench model sweep.

Kept separate from run.py (per the rightmodel sweep guidance): the runner writes
summary.json; this plotter globs the rows and draws. Regenerating the report costs nothing
and never re-spends. Plots are inline SVG (no matplotlib dependency) so the file opens in any
browser and is trivial to share.

Telemetry note: Copilot cells capture the full input/cache/output token breakdown from the
completed local session. USD and AI-credit equivalents use the pricing snapshot saved with the
run from GitHub's official Copilot model-pricing page.
"""
import html
import json
from collections import defaultdict
from pathlib import Path

# One stable colour per model family; markers distinguish the three arms.
_PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2", "#be185d"]
_ARM_MARKER = {"baseline": "circle", "skill": "square", "prompt": "triangle"}
_COST_BASIS = {
    "copilot_session": "Copilot session total",
    "mixed": "mixed direct/estimated",
    "partial": "partial / missing",
}


def _color_for(models):
    return {m: _PALETTE[i % len(_PALETTE)] for i, m in enumerate(sorted(models))}


def _fmt(v, nd=2):
    return "-" if v is None else format(v, f".{nd}f")


def _fmt_count(v):
    return "-" if v is None else format(v, ".0f")


def _fmt_usd(v):
    return "-" if v is None else f"${v:.8f}"


def _axis_tick(v, xkey):
    if xkey.startswith("cost_usd"):
        return f"${v:.3f}"
    return _fmt(v, 1)


def _cost_basis(value):
    if value is None:
        return "-"
    if value in _COST_BASIS:
        return _COST_BASIS[value]
    if isinstance(value, str) and value.startswith("https://"):
        return "GitHub pricing estimate"
    return str(value)


def _marker_svg(shape, cx, cy, color, r=6):
    if shape == "square":
        return f'<rect x="{cx-r}" y="{cy-r}" width="{2*r}" height="{2*r}" fill="{color}" fill-opacity="0.85"/>'
    if shape == "triangle":
        pts = f"{cx},{cy-r} {cx-r},{cy+r} {cx+r},{cy+r}"
        return f'<polygon points="{pts}" fill="{color}" fill-opacity="0.85"/>'
    return f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{color}" fill-opacity="0.85"/>'


def _scatter(rows, xkey, xlabel, colors, width=460, height=300):
    """Scatter: quality (correct_rate, 0..1) on Y vs `xkey` on X. Points coloured by model,
    shaped by arm. Returns an SVG string, or a 'no data' note if X is entirely missing."""
    pts = [r for r in rows if r.get(xkey) is not None and r.get("correct_rate") is not None]
    if not pts:
        return f'<p class="nodata">no {html.escape(xlabel)} data (host did not report it)</p>'
    pad_l, pad_b, pad_t, pad_r = 46, 40, 16, 12
    xs = [r[xkey] for r in pts]
    xmin, xmax = min(xs), max(xs)
    if xmax == xmin:
        xmax = xmin + 1
    plot_w, plot_h = width - pad_l - pad_r, height - pad_t - pad_b

    def px(x):
        return pad_l + (x - xmin) / (xmax - xmin) * plot_w

    def py(q):
        return pad_t + (1 - q) * plot_h

    svg = [f'<svg viewBox="0 0 {width} {height}" width="{width}" height="{height}" role="img">']
    # axes
    svg.append(f'<line x1="{pad_l}" y1="{pad_t}" x2="{pad_l}" y2="{pad_t+plot_h}" class="axis"/>')
    svg.append(f'<line x1="{pad_l}" y1="{pad_t+plot_h}" x2="{pad_l+plot_w}" y2="{pad_t+plot_h}" class="axis"/>')
    # y gridlines at 0/50/100%
    for q in (0.0, 0.5, 1.0):
        y = py(q)
        svg.append(f'<line x1="{pad_l}" y1="{y:.1f}" x2="{pad_l+plot_w}" y2="{y:.1f}" class="grid"/>')
        svg.append(f'<text x="{pad_l-6}" y="{y+3:.1f}" class="tick" text-anchor="end">{int(q*100)}%</text>')
    # x ticks at min/mid/max
    for xv, anchor in ((xmin, "start"), ((xmin + xmax) / 2, "middle"),
                       (xmax, "end")):
        x = px(xv)
        svg.append(f'<text x="{x:.1f}" y="{pad_t+plot_h+16:.1f}" class="tick" '
                   f'text-anchor="{anchor}">{_axis_tick(xv, xkey)}</text>')
    svg.append(f'<text x="{pad_l+plot_w/2:.1f}" y="{height-4}" class="axlabel" text-anchor="middle">{html.escape(xlabel)}</text>')
    svg.append(f'<text x="14" y="{pad_t+plot_h/2:.1f}" class="axlabel" text-anchor="middle" transform="rotate(-90 14 {pad_t+plot_h/2:.1f})">correct %</text>')
    for r in pts:
        svg.append(_marker_svg(_ARM_MARKER.get(r["arm"], "circle"),
                               px(r[xkey]), py(r["correct_rate"]), colors[r["model"]]))
    svg.append("</svg>")
    return "".join(svg)


def _legend(models, colors):
    items = []
    for m in sorted(models):
        items.append(f'<span class="lg"><span class="sw" style="background:{colors[m]}"></span>{html.escape(m)}</span>')
    for arm, shape in _ARM_MARKER.items():
        glyph = {"circle": "●", "square": "■", "triangle": "▲"}[shape]
        items.append(f'<span class="lg"><span class="mk">{glyph}</span>{arm}</span>')
    return '<div class="legend">' + " ".join(items) + "</div>"


def _recommendation(rows):
    """Per skill, pick the strongest process result, then the cheapest successful model."""
    out = []
    by_skill = defaultdict(list)
    for r in rows:
        if r["arm"] == "skill" and r["model"] != "default":
            by_skill[r["skill"]].append(r)
    for skill, rs in sorted(by_skill.items()):
        def key(r):
            return (-(r["correct_rate"] or 0),
                    -(r.get("applied_rate") or 0),
                    r.get("cost_usd_per_success") if r.get("cost_usd_per_success") is not None else float("inf"),
                    r["premium_reqs_per_success"] if r["premium_reqs_per_success"] is not None else float("inf"),
                    r["seconds_per_success"] if r["seconds_per_success"] is not None else float("inf"))
        best = sorted(rs, key=key)[0]
        out.append((skill, best))
    return out


def _winner_key(r):
    return (-(r["correct_rate"] or 0),
            -(r.get("applied_rate") or 0),
            r.get("cost_usd_per_success") if r.get("cost_usd_per_success") is not None else float("inf"),
            r["premium_reqs_per_success"] if r["premium_reqs_per_success"] is not None else float("inf"),
            r["seconds_per_success"] if r["seconds_per_success"] is not None else float("inf"),
            r.get("out_tokens_per_success") if r.get("out_tokens_per_success") is not None else float("inf"),
            r["arm"],
            r["model"])


def _best_observed(rows):
    """Pick highest correctness/application, then lowest USD, requests, and time per success."""
    out = []
    by_task = defaultdict(list)
    for r in rows:
        by_task[r["task"]].append(r)
    for task, rs in sorted(by_task.items()):
        best = sorted(rs, key=_winner_key)[0]
        all_same_quality = len({r.get("correct_rate") for r in rs}) == 1
        all_perfect = all((r.get("correct_rate") or 0) == 1 for r in rs)
        out.append((task, best, all_same_quality, all_perfect))
    return out


def write_report(rows, results, out_dir):
    out_dir = Path(out_dir)
    pricing = None
    pricing_path = out_dir / "pricing.json"
    if pricing_path.exists():
        try:
            pricing = json.loads(pricing_path.read_text(encoding="utf-8"))
        except Exception:
            pricing = None
    models = {r["model"] for r in rows}
    colors = _color_for(models)
    multi = len(models) > 1 or (models and next(iter(models)) != "default")
    tasks = sorted({r["task"] for r in rows})

    parts = ['<!doctype html><html><head><meta charset="utf-8">',
             '<meta name="viewport" content="width=device-width, initial-scale=1">',
             '<title>skill-bench sweep report</title>', _CSS, '</head><body>']
    parts.append('<h1>skill-bench model sweep</h1>')
    parts.append('<p class="note"><b>Winner rule:</b> highest correct%, then highest applied%, '
                 'then lowest USD/win, premium requests/win, and seconds/win. Quality = '
                 '<b>correct%</b> (artifact sound); process = '
                 '<b>applied%</b> (the requested skill discipline appeared). Copilot token '
                 'columns include uncached input, cached input, cache writes, and output. '
                 'Direct Copilot session totals are authoritative for <b>USD</b> and '
                 '<b>AI credits</b>; the official pricing snapshot checks those totals and '
                 'supplies fallback estimates when one pricing tier applies. Unresolved '
                 'tiered or multi-model sessions are flagged rather than guessed. '
                 '1 AI credit = $0.01. Premium requests remain '
                 'visible only as a separate legacy-billing metric. '
                 'Values ending in <code>/win</code> include failed attempts by dividing total '
                 'usage by successful outcomes.</p>')
    min_n = min((r.get("n") or 0 for r in rows), default=0)
    if min_n and min_n < 3:
        detail = ("100% at n=1 means one passing cell, not certainty."
                  if min_n == 1 else f"The smallest row has only n={min_n} cells.")
        parts.append(f'<p class="warn"><b>Directional only:</b> {detail} Increase '
                     '<code>--runs</code> before treating the winner as stable.</p>')
    if pricing and pricing.get("source_url"):
        source = html.escape(pricing["source_url"], quote=True)
        fetched = html.escape(str(pricing.get("retrieved_at") or "unknown"))
        parts.append(f'<p class="source">Pricing source: <a href="{source}">GitHub Copilot '
                     f'model pricing</a> (snapshot fetched {fetched}).</p>')
    else:
        parts.append('<p class="warn">No pricing snapshot was available; token counts remain '
                     'valid but USD/AI-credit estimates are blank.</p>')

    rate_deltas = [abs(r["website_cost_delta_usd"]) for r in results
                   if isinstance(r.get("website_cost_delta_usd"), (int, float))]
    if rate_deltas:
        max_delta = max(rate_deltas)
        if max_delta <= 0.00000001:
            parts.append(f'<p class="ok">Pricing check passed: {len(rate_deltas)} direct Copilot '
                         'session total(s) match the saved website token rates.</p>')
        else:
            parts.append(f'<p class="warn">Pricing check mismatch: the largest direct-session '
                         f'versus website-rate difference is {_fmt_usd(max_delta)}. Use the '
                         'direct Copilot session total; the snapshot may be newer than the run.</p>')
    tiered_unresolved = sum(r.get("website_cost_status") == "unresolved_tiered_pricing"
                            for r in results)
    if tiered_unresolved:
        parts.append(f'<p class="warn">Website pricing check skipped for {tiered_unresolved} '
                     'cell(s): the model has multiple pricing tiers and aggregate session '
                     'telemetry cannot safely select one.</p>')
    multi_model_unresolved = sum(
        r.get("website_cost_status") == "unresolved_multi_model_session" for r in results
    )
    if multi_model_unresolved:
        parts.append(f'<p class="warn">Website pricing check skipped for '
                     f'{multi_model_unresolved} cell(s): the session used multiple models but '
                     'reported only aggregate token totals.</p>')

    best = _best_observed(rows)
    if best:
        parts.append('<h2>Winner by task</h2><ul class="best">')
        for task, b, all_same_quality, all_perfect in best:
            parts.append(f'<li><b>{html.escape(task)}</b>: <b>{html.escape(b["arm"])} / '
                         f'{html.escape(b["model"])}</b> — correct {int((b["correct_rate"] or 0)*100)}%, '
                         f'applied {int((b.get("applied_rate") or 0)*100)}%, '
                         f'{_fmt_usd(b.get("cost_usd_per_success"))}/win, '
                         f'{_fmt(b.get("ai_credits_per_success"), 3)} AI credits/win, '
                         f'{_fmt(b["premium_reqs_per_success"])} pr/win, '
                         f'{_fmt(b["seconds_per_success"],1)} s/win')
            if b.get("out_tokens_per_success") is not None:
                parts.append(f', {_fmt_count(b["out_tokens_per_success"])} output tokens/win')
            if all_perfect:
                parts.append(' <span class="tie">(All rows for this task are at 100% correct; '
                             'tie broken by applied%, then USD cost, premium-requests, seconds, '
                             'and output tokens.)</span>')
            elif all_same_quality:
                parts.append(' <span class="tie">(Rows tied on correct%; tie broken by '
                             'applied%, then USD cost, premium-requests, seconds, and output '
                             'tokens.)</span>')
            parts.append('</li>')
        parts.append('</ul>')
        if not any(r.get("arm") == "skill" for r in rows):
            parts.append('<p class="warn">No <b>skill</b> arm rows were captured in this run, so this '
                         'report can pick the best observed row but cannot say whether the skill '
                         'beats baseline or prompt.</p>')

    if multi:
        rec = _recommendation(rows)
        if rec:
            parts.append('<h2>Recommendation (skill arm)</h2><ul class="rec">')
            for skill, b in rec:
                parts.append(f'<li><b>{html.escape(skill)}</b>: <b>{html.escape(b["model"])}</b> '
                             f'— correct {int((b["correct_rate"] or 0)*100)}%, '
                             f'applied {int((b.get("applied_rate") or 0)*100)}%, '
                             f'{_fmt_usd(b.get("cost_usd_per_success"))}/win, '
                             f'{_fmt(b["premium_reqs_per_success"])} pr/win, '
                             f'{_fmt(b["seconds_per_success"],1)} s/win</li>')
            parts.append('</ul>')

    if multi:
        parts.append(_legend(models, colors))
        for task in tasks:
            trows = [r for r in rows if r["task"] == task]
            parts.append(f'<h2>{html.escape(task)}</h2><div class="plots">')
            parts.append('<div>' + _scatter(trows, "cost_usd_per_task", "USD / task", colors) + '</div>')
            parts.append('<div>' + _scatter(trows, "out_tokens_per_task", "output tokens / task", colors) + '</div>')
            parts.append('<div>' + _scatter(trows, "seconds_per_task", "seconds / task", colors) + '</div>')
            parts.append('</div>')

    # data table
    parts.append('<h2>Aggregated benchmark rows</h2><p class="tablehint">Within each task, '
                 'rows are ordered by cheapest USD/task first; missing costs appear last.</p>'
                 '<div class="tablewrap"><table>')
    parts.append('<tr><th>task</th><th>arm</th><th>model</th><th>n</th><th>applied%</th>'
                 '<th>correct%</th><th aria-sort="ascending">USD/task ↑</th><th>USD/win</th>'
                 '<th>AI credits/task</th>'
                 '<th>cost basis</th>'
                 '<th>input tokens/task</th><th>cached input/task</th><th>cache write/task</th>'
                 '<th>output tokens/task</th><th>pr/task</th><th>pr/win</th><th>s/task</th>'
                 '<th>s/win</th><th>p50 s</th></tr>')
    def table_key(row):
        cost = row.get("cost_usd_per_task")
        return (row["task"], cost if cost is not None else float("inf"),
                row["model"], row["arm"])

    for r in sorted(rows, key=table_key):
        parts.append(
            "<tr>"
            f'<td>{html.escape(r["task"])}</td><td>{html.escape(r["arm"])}</td>'
            f'<td>{html.escape(r["model"])}</td><td>{r["n"]}</td>'
            f'<td>{int(r["applied_rate"]*100)}</td><td>{int(r["correct_rate"]*100)}</td>'
            f'<td>{_fmt_usd(r.get("cost_usd_per_task"))}</td>'
            f'<td>{_fmt_usd(r.get("cost_usd_per_success"))}</td>'
            f'<td>{_fmt(r.get("ai_credits_per_task"),3)}</td>'
            f'<td>{html.escape(_cost_basis(r.get("cost_basis")))}</td>'
            f'<td>{_fmt_count(r.get("input_tokens_per_task"))}</td>'
            f'<td>{_fmt_count(r.get("cached_input_tokens_per_task"))}</td>'
            f'<td>{_fmt_count(r.get("cache_write_tokens_per_task"))}</td>'
            f'<td>{_fmt_count(r.get("out_tokens_per_task"))}</td>'
            f'<td>{_fmt(r["premium_reqs_per_task"])}</td>'
            f'<td>{_fmt(r["premium_reqs_per_success"])}</td>'
            f'<td>{_fmt(r["seconds_per_task"],1)}</td><td>{_fmt(r["seconds_per_success"],1)}</td>'
            f'<td>{_fmt(r["p50_seconds"],1)}</td>'
            "</tr>")
    parts.append('</table></div>')
    parts.append(f'<p class="foot">{len(results)} cells.</p>')
    parts.append('</body></html>')

    dest = out_dir / "sweep_report.html"
    dest.write_text("".join(parts), encoding="utf-8")
    return dest


_CSS = """<style>
:root { color-scheme: light dark; }
body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 24px; max-width: 1400px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; }
.note { color: #555; } @media (prefers-color-scheme: dark){ .note{color:#aaa;} }
code { background: rgba(127,127,127,.18); padding: 1px 4px; border-radius: 3px; }
.rec, .best { margin: 4px 0; } .rec li, .best li { margin: 2px 0; }
.tie, .warn { color: #666; } .ok { color: #067647; }
@media (prefers-color-scheme: dark){ .tie,.warn{color:#aaa;} .ok{color:#6ce9a6;} }
.plots { display: flex; gap: 16px; flex-wrap: wrap; }
.legend { margin: 8px 0; font-size: 12px; }
.lg { margin-right: 12px; white-space: nowrap; }
.sw { display: inline-block; width: 11px; height: 11px; border-radius: 2px; vertical-align: -1px; margin-right: 3px; }
.mk { margin-right: 3px; }
svg .axis { stroke: #888; stroke-width: 1; }
svg .grid { stroke: rgba(127,127,127,.25); stroke-width: 1; }
svg .tick { fill: #777; font-size: 10px; }
svg .axlabel { fill: #777; font-size: 11px; }
.nodata { color: #999; font-style: italic; }
.tablehint { color: #666; font-size: 12px; margin: -8px 0 8px; }
@media (prefers-color-scheme: dark){ .tablehint{color:#aaa;} }
.tablewrap { max-width: 100%; overflow-x: auto; }
table { border-collapse: collapse; font-size: 10px; font-variant-numeric: tabular-nums;
        table-layout: fixed; width: 100%; }
th, td { border: 1px solid rgba(127,127,127,.3); overflow-wrap: anywhere;
         padding: 3px 4px; text-align: right; }
th:nth-child(-n+3), td:nth-child(-n+3) { text-align: left; }
tr:hover td { background: rgba(127,127,127,.08); }
.foot { color: #999; font-size: 12px; margin-top: 16px; }
</style>"""
