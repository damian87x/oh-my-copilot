#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

import report


class SkillBenchReportTests(unittest.TestCase):
    def test_write_report_escapes_labels_and_reports_missing_telemetry(self):
        rows = [
            {
                "task": "task<&>",
                "skill": "skill<&>",
                "arm": "skill",
                "model": "default",
                "n": 1,
                "applied_rate": 1,
                "correct_rate": 1,
                "premium_reqs_per_task": None,
                "premium_reqs_per_success": None,
                "seconds_per_task": None,
                "seconds_per_success": None,
                "p50_seconds": None,
            },
            {
                "task": "task<&>",
                "skill": "skill<&>",
                "arm": "skill",
                "model": "skill-model<&>",
                "n": 1,
                "applied_rate": 1,
                "correct_rate": 0.5,
                "premium_reqs_per_task": None,
                "premium_reqs_per_success": None,
                "seconds_per_task": None,
                "seconds_per_success": None,
                "p50_seconds": None,
            },
            {
                "task": "task<&>",
                "skill": "skill<&>",
                "arm": "baseline",
                "model": "baseline-model<&>",
                "n": 1,
                "applied_rate": 1,
                "correct_rate": 1,
                "premium_reqs_per_task": None,
                "premium_reqs_per_success": None,
                "seconds_per_task": None,
                "seconds_per_success": None,
                "p50_seconds": None,
            },
        ]
        with tempfile.TemporaryDirectory() as d:
            dest = report.write_report(rows, [], Path(d))
            html = dest.read_text(encoding="utf-8")

        self.assertIn("sweep_report.html", str(dest))
        self.assertIn("task&lt;&amp;&gt;", html)
        self.assertIn("skill&lt;&amp;&gt;", html)
        self.assertIn("skill-model&lt;&amp;&gt;", html)
        self.assertIn("baseline-model&lt;&amp;&gt;", html)
        self.assertIn("no USD / task data", html)
        self.assertIn("no seconds / task data", html)
        recommendation = html.split("<h2>Recommendation (skill arm)</h2>", 1)[1].split("<h2>task&lt;&amp;&gt;</h2>", 1)[0]
        self.assertIn("<b>skill-model&lt;&amp;&gt;</b>", recommendation)
        self.assertNotIn("<b>baseline-model&lt;&amp;&gt;</b>", recommendation)
        self.assertNotIn("<b>default</b>", recommendation)

    def test_write_report_names_best_observed_row_and_tie_break(self):
        rows = [
            {
                "task": "code-review-sqli",
                "skill": "code-review",
                "arm": "baseline",
                "model": "claude-haiku-4.5",
                "n": 1,
                "applied_rate": 1,
                "correct_rate": 1,
                "premium_reqs_per_task": 0.33,
                "premium_reqs_per_success": 0.33,
                "seconds_per_task": 50.1,
                "seconds_per_success": 50.1,
                "p50_seconds": 50.1,
            },
            {
                "task": "code-review-sqli",
                "skill": "code-review",
                "arm": "baseline",
                "model": "gpt-5-mini",
                "n": 1,
                "applied_rate": 1,
                "correct_rate": 1,
                "premium_reqs_per_task": 0,
                "premium_reqs_per_success": 0,
                "seconds_per_task": 23.3,
                "seconds_per_success": 23.3,
                "p50_seconds": 23.3,
            },
            {
                "task": "code-review-sqli",
                "skill": "code-review",
                "arm": "prompt",
                "model": "claude-haiku-4.5",
                "n": 1,
                "applied_rate": 1,
                "correct_rate": 1,
                "premium_reqs_per_task": 0.33,
                "premium_reqs_per_success": 0.33,
                "seconds_per_task": 26.0,
                "seconds_per_success": 26.0,
                "p50_seconds": 26.0,
            },
            {
                "task": "code-review-sqli",
                "skill": "code-review",
                "arm": "prompt",
                "model": "gpt-5-mini",
                "n": 1,
                "applied_rate": 1,
                "correct_rate": 1,
                "premium_reqs_per_task": 0,
                "premium_reqs_per_success": 0,
                "seconds_per_task": 21.6,
                "seconds_per_success": 21.6,
                "p50_seconds": 21.6,
                "out_tokens_per_task": 372,
                "out_tokens_per_success": 372,
            },
        ]
        with tempfile.TemporaryDirectory() as d:
            dest = report.write_report(rows, rows, Path(d))
            html = dest.read_text(encoding="utf-8")

        self.assertIn("<h2>Winner by task</h2>", html)
        self.assertIn("<b>code-review-sqli</b>: <b>prompt / gpt-5-mini</b>", html)
        self.assertIn("372 output tokens/win", html)
        self.assertIn("output tokens / task", html)
        self.assertIn("output tokens/task", html)
        self.assertIn("All rows for this task are at 100% correct", html)
        self.assertIn("tie broken by applied%, then USD cost", html)
        self.assertIn("No <b>skill</b> arm rows were captured", html)
        self.assertNotIn("reports no tokens or USD", html)
        self.assertIn(
            "Copilot token columns include uncached input, cached input, cache writes, and output",
            html,
        )

    def test_write_report_prefers_applied_row_and_shows_source_backed_costs(self):
        common = {
            "task": "code-review-sqli", "skill": "code-review", "n": 1,
            "correct_rate": 1, "premium_reqs_per_task": 0,
            "premium_reqs_per_success": 0, "seconds_per_task": 30,
            "seconds_per_success": 30, "p50_seconds": 30,
            "cost_basis": "copilot_session",
            "website_cost_delta_usd": 0,
            "input_tokens_per_task": 1000, "input_tokens_per_success": 1000,
            "cached_input_tokens_per_task": 2000,
            "cached_input_tokens_per_success": 2000,
            "cache_write_tokens_per_task": 0,
            "cache_write_tokens_per_success": 0,
            "out_tokens_per_task": 3000, "out_tokens_per_success": 3000,
        }
        rows = [
            {**common, "arm": "prompt", "model": "gpt-5-mini", "applied_rate": 0,
             "cost_usd_per_task": 0.00616135, "cost_usd_per_success": 0.00616135,
             "ai_credits_per_task": 0.616135, "ai_credits_per_success": 0.616135},
            {**common, "arm": "skill", "model": "gpt-5-mini", "applied_rate": 1,
             "cost_usd_per_task": 0.00931895, "cost_usd_per_success": 0.00931895,
             "ai_credits_per_task": 0.931895, "ai_credits_per_success": 0.931895},
            {**common, "arm": "baseline", "model": "claude-haiku-4.5", "applied_rate": 1,
             "cost_usd_per_task": 0.04653105, "cost_usd_per_success": 0.04653105,
             "ai_credits_per_task": 4.653105, "ai_credits_per_success": 4.653105},
        ]
        pricing = {
            "source_url": "https://docs.github.com/example-pricing",
            "retrieved_at": "2026-07-10T10:00:00+00:00",
        }
        with tempfile.TemporaryDirectory() as d:
            out_dir = Path(d)
            (out_dir / "pricing.json").write_text(
                json.dumps(pricing), encoding="utf-8"
            )
            dest = report.write_report(rows, rows, out_dir)
            html = dest.read_text(encoding="utf-8")

        self.assertIn("<h2>Winner by task</h2>", html)
        self.assertIn("<b>code-review-sqli</b>: <b>skill / gpt-5-mini</b>", html)
        self.assertIn("applied 100%", html)
        self.assertIn("$0.00931895/win", html)
        self.assertIn("tie broken by applied%, then USD cost", html)
        self.assertIn("USD / task", html)
        self.assertIn('text-anchor="start">$0.006<', html)
        self.assertIn('text-anchor="end">$0.047<', html)
        self.assertIn("USD/task", html)
        self.assertIn('<th aria-sort="ascending">USD/task ↑</th>', html)
        self.assertIn("table-layout: fixed", html)
        self.assertIn("input tokens/task", html)
        self.assertIn("cached input/task", html)
        self.assertIn("cache write/task", html)
        self.assertIn("cost basis", html)
        self.assertIn("Copilot session total", html)
        self.assertIn("Direct Copilot session totals are authoritative", html)
        self.assertIn("Pricing check passed", html)
        self.assertIn("Directional only", html)
        self.assertIn("100% at n=1 means one passing cell", html)
        self.assertIn("Aggregated benchmark rows", html)
        self.assertIn("cheapest USD/task first", html)
        self.assertIn('href="https://docs.github.com/example-pricing"', html)
        table = html.split("<h2>Aggregated benchmark rows</h2>", 1)[1]
        prompt_gpt = "<td>code-review-sqli</td><td>prompt</td><td>gpt-5-mini</td>"
        skill_gpt = "<td>code-review-sqli</td><td>skill</td><td>gpt-5-mini</td>"
        baseline_claude = (
            "<td>code-review-sqli</td><td>baseline</td>"
            "<td>claude-haiku-4.5</td>"
        )
        self.assertLess(table.index(prompt_gpt), table.index(skill_gpt))
        self.assertLess(table.index(skill_gpt), table.index(baseline_claude))

    def test_write_report_calls_out_unresolved_tiered_pricing(self):
        row = {
            "task": "tdd-slugify", "skill": "tdd", "arm": "skill",
            "model": "gpt-5.5", "n": 1, "applied_rate": 1,
            "correct_rate": 1, "cost_usd_per_task": 0.01,
            "cost_usd_per_success": 0.01, "ai_credits_per_task": 1,
            "ai_credits_per_success": 1, "cost_basis": "copilot_session",
            "premium_reqs_per_task": 0, "premium_reqs_per_success": 0,
            "seconds_per_task": 1, "seconds_per_success": 1,
            "p50_seconds": 1,
        }
        pricing = {
            "source_url": "https://docs.github.com/example-pricing",
            "retrieved_at": "2026-07-10T10:00:00+00:00",
        }
        with tempfile.TemporaryDirectory() as d:
            out_dir = Path(d)
            (out_dir / "pricing.json").write_text(
                json.dumps(pricing), encoding="utf-8"
            )
            dest = report.write_report(
                [row], [{**row, "website_cost_status": "unresolved_tiered_pricing"}],
                out_dir,
            )
            rendered = dest.read_text(encoding="utf-8")

        self.assertIn("Website pricing check skipped for 1 cell", rendered)
        self.assertIn("multiple pricing tiers", rendered)


if __name__ == "__main__":
    unittest.main()
