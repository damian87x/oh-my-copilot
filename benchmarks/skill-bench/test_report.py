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


if __name__ == "__main__":
    unittest.main()
