#!/usr/bin/env python3
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
        self.assertIn("no premium-requests / task data", html)
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

        self.assertIn("<h2>Best observed row</h2>", html)
        self.assertIn("<b>code-review-sqli</b>: <b>prompt / gpt-5-mini</b>", html)
        self.assertIn("372 output tokens/win", html)
        self.assertIn("output tokens / task", html)
        self.assertIn("output tokens/task", html)
        self.assertIn("All rows for this task are at 100% correct", html)
        self.assertIn("tie broken by premium-requests, then seconds", html)
        self.assertIn("No <b>skill</b> arm rows were captured", html)
        self.assertNotIn("reports no tokens or USD", html)
        self.assertIn("Input-token/USD columns are not captured by this report yet", html)


if __name__ == "__main__":
    unittest.main()
