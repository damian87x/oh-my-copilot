#!/usr/bin/env python3
"""Self-contained HTML report for the skill-bench model sweep.

Kept separate from run.py (per the rightmodel sweep guidance): the runner writes
summary.json; this plotter globs the rows and draws. Regenerating the report costs nothing
and never re-spends. Plots are inline SVG (no matplotlib dependency) so the file opens in any
browser and is trivial to share.

Cost currency note: on the Copilot host there are no tokens or USD -- only premium-requests
and seconds -- so the plots put quality (correct%) on Y against premium-requests/task and
seconds/task on X. `*_per_success` fold quality and cost into one number.
"""
import html
from collections import defaultdict
from pathlib import Path

# One stable colour per model family; markers distinguish the three arms.
_PALETTE = ["#2563eb", "#dc2626", "#059669", "#d97706", "#7c3aed", "#0891b2", "#be185d"]
_ARM_MARKER = {"baseline": "circle", "skill": "square", "prompt": "triangle"}


def _color_for(models):
    return {m: _PALETTE[i % len(_PALETTE)] for i, m in enumerate(sorted(models))}


def _fmt(v, nd=2):
    return "-" if v is None else format(v, f".{nd}f")


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
    for xv in (xmin, (xmin + xmax) / 2, xmax):
        x = px(xv)
        svg.append(f'<text x="{x:.1f}" y="{pad_t+plot_h+16:.1f}" class="tick" text-anchor="middle">{_fmt(xv,1)}</text>')
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
    """Per skill, pick the best model on the 'skill' arm: highest correct_rate, tie-broken by
    lowest premium_reqs_per_success, then lowest seconds_per_success."""
    out = []
    by_skill = defaultdict(list)
    for r in rows:
        if r["arm"] == "skill" and r["model"] != "default":
            by_skill[r["skill"]].append(r)
    for skill, rs in sorted(by_skill.items()):
        def key(r):
            return (-(r["correct_rate"] or 0),
                    r["premium_reqs_per_success"] if r["premium_reqs_per_success"] is not None else float("inf"),
                    r["seconds_per_success"] if r["seconds_per_success"] is not None else float("inf"))
        best = sorted(rs, key=key)[0]
        out.append((skill, best))
    return out


def write_report(rows, results, out_dir):
    out_dir = Path(out_dir)
    models = {r["model"] for r in rows}
    colors = _color_for(models)
    multi = len(models) > 1 or (models and next(iter(models)) != "default")
    tasks = sorted({r["task"] for r in rows})

    parts = ['<!doctype html><html><head><meta charset="utf-8">',
             '<meta name="viewport" content="width=device-width, initial-scale=1">',
             '<title>skill-bench sweep report</title>', _CSS, '</head><body>']
    parts.append('<h1>skill-bench model sweep</h1>')
    parts.append('<p class="note">Quality = <b>correct%</b> (artifact sound). Cost currency is '
                 '<b>premium-requests</b> and <b>seconds</b> — the Copilot host reports no tokens or USD. '
                 '<code>pr/win</code> and <code>s/win</code> are premium-requests and seconds '
                 '<i>per success</i> (quality and cost folded into one number).</p>')

    if multi:
        rec = _recommendation(rows)
        if rec:
            parts.append('<h2>Recommendation (skill arm)</h2><ul class="rec">')
            for skill, b in rec:
                parts.append(f'<li><b>{html.escape(skill)}</b>: <b>{html.escape(b["model"])}</b> '
                             f'— correct {int((b["correct_rate"] or 0)*100)}%, '
                             f'{_fmt(b["premium_reqs_per_success"])} pr/win, '
                             f'{_fmt(b["seconds_per_success"],1)} s/win</li>')
            parts.append('</ul>')

    if multi:
        parts.append(_legend(models, colors))
        for task in tasks:
            trows = [r for r in rows if r["task"] == task]
            parts.append(f'<h2>{html.escape(task)}</h2><div class="plots">')
            parts.append('<div>' + _scatter(trows, "premium_reqs_per_task", "premium-requests / task", colors) + '</div>')
            parts.append('<div>' + _scatter(trows, "seconds_per_task", "seconds / task", colors) + '</div>')
            parts.append('</div>')

    # data table
    parts.append('<h2>Per-cell data</h2><div class="tablewrap"><table>')
    parts.append('<tr><th>task</th><th>arm</th><th>model</th><th>n</th><th>applied%</th>'
                 '<th>correct%</th><th>pr/task</th><th>pr/win</th><th>s/task</th><th>s/win</th>'
                 '<th>p50 s</th></tr>')
    for r in sorted(rows, key=lambda x: (x["task"], x["arm"], x["model"])):
        parts.append(
            "<tr>"
            f'<td>{html.escape(r["task"])}</td><td>{html.escape(r["arm"])}</td>'
            f'<td>{html.escape(r["model"])}</td><td>{r["n"]}</td>'
            f'<td>{int(r["applied_rate"]*100)}</td><td>{int(r["correct_rate"]*100)}</td>'
            f'<td>{_fmt(r["premium_reqs_per_task"])}</td><td>{_fmt(r["premium_reqs_per_success"])}</td>'
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
body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: 24px; max-width: 1000px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin-top: 24px; }
.note { color: #555; } @media (prefers-color-scheme: dark){ .note{color:#aaa;} }
code { background: rgba(127,127,127,.18); padding: 1px 4px; border-radius: 3px; }
.rec { margin: 4px 0; } .rec li { margin: 2px 0; }
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
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; font-size: 12px; width: 100%; }
th, td { border: 1px solid rgba(127,127,127,.3); padding: 3px 8px; text-align: right; }
th:nth-child(-n+3), td:nth-child(-n+3) { text-align: left; }
tr:hover td { background: rgba(127,127,127,.08); }
.foot { color: #999; font-size: 12px; margin-top: 16px; }
</style>"""
