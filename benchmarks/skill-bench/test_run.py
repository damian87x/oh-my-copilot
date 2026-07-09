#!/usr/bin/env python3
import json
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import run
from tasks import TASKS


class SkillBenchRunTests(unittest.TestCase):
    def _good_workspace_with_status(self, task_id, status):
        task = TASKS[task_id]
        temp = tempfile.TemporaryDirectory()
        workdir = Path(temp.name)
        run.seed_workspace(task, workdir, ref_kind="good", for_selftest=True)
        (workdir / "_status.json").write_text(json.dumps(status), encoding="utf-8")
        return temp, workdir

    def test_score_workspace_honesty_gate_forces_timeout_to_failure(self):
        temp, workdir = self._good_workspace_with_status("tdd-slugify", {"timed_out": 1})
        with temp:
            score = run.score_workspace("tdd-slugify", "skill", "copilot", workdir)

        self.assertEqual(score["applied"], 0)
        self.assertEqual(score["correct"], 0)
        self.assertEqual(score["timed_out"], 1)
        self.assertIn("honesty gate", score["reason"])

    def test_score_workspace_honesty_gate_forces_spawn_error_to_failure(self):
        temp, workdir = self._good_workspace_with_status("tdd-slugify", {"spawn_error": "boom"})
        with temp:
            score = run.score_workspace("tdd-slugify", "skill", "copilot", workdir)

        self.assertEqual(score["applied"], 0)
        self.assertEqual(score["correct"], 0)
        self.assertEqual(score["error"], "boom")
        self.assertIn("honesty gate", score["reason"])

    @mock.patch("run.shutil.which", return_value="/bin/copilot")
    @mock.patch("run.subprocess.run")
    def test_probe_model_drops_entitlement_failures(self, mock_run, _mock_which):
        mock_run.return_value = subprocess.CompletedProcess(
            ["copilot"], 1, stdout="", stderr="user does not have access to this model"
        )

        self.assertEqual(run.probe_model("copilot", "nope"), ("unavailable", "not entitled"))

    @mock.patch("run.shutil.which", return_value="/bin/copilot")
    @mock.patch("run.subprocess.run")
    def test_probe_model_keeps_timeout_with_stdout_as_available(self, mock_run, _mock_which):
        mock_run.side_effect = subprocess.TimeoutExpired(["copilot"], timeout=run.PROBE_TIMEOUT, output=b"ok\n")

        self.assertEqual(run.probe_model("copilot", "slow"), ("available", "ok"))

    @mock.patch("run.shutil.which", return_value="/bin/copilot")
    @mock.patch("run.subprocess.run")
    def test_probe_model_keeps_timeout_without_output_as_unknown(self, mock_run, _mock_which):
        mock_run.side_effect = subprocess.TimeoutExpired(["copilot"], timeout=run.PROBE_TIMEOUT)

        status, why = run.probe_model("copilot", "slow")

        self.assertEqual(status, "unknown")
        self.assertIn("kept unverified", why)

    @mock.patch("run.probe_model", return_value=("unavailable", "not entitled"))
    def test_filter_available_models_exits_when_all_models_unavailable(self, _mock_probe):
        with self.assertRaisesRegex(SystemExit, "no requested models are available"):
            run.filter_available_models("copilot", ["bad-model"])

    @mock.patch("run.probe_model")
    def test_filter_available_models_keeps_available_and_unknown_only(self, mock_probe):
        statuses = {
            "available-model": ("available", "ok"),
            "unknown-model": ("unknown", "no output"),
            "unavailable-model": ("unavailable", "not entitled"),
        }
        mock_probe.side_effect = lambda _engine, model: statuses[model]

        kept = run.filter_available_models(
            "copilot",
            ["available-model", "unknown-model", "unavailable-model"],
        )

        self.assertEqual(kept, ["available-model", "unknown-model"])

    def test_main_rejects_unsafe_model_slugs_before_creating_runs(self):
        for slug in ("../x", "bad/name", "a__b"):
            with self.subTest(slug=slug), tempfile.TemporaryDirectory() as d, \
                    mock.patch.object(run, "RUNS_DIR", Path(d)), \
                    mock.patch.object(sys, "argv", ["run.py", "--task", "code-review-sqli", "--models", slug, "--no-probe"]):
                with self.assertRaisesRegex(SystemExit, "invalid model slug"):
                    run.main()
                self.assertEqual(list(Path(d).iterdir()), [])

    def test_aggregate_treats_absent_scores_and_telemetry_as_missing_not_zero(self):
        rows = run.aggregate([{
            "task": "tdd-slugify",
            "skill": "tdd",
            "arm": "skill",
            "model": "gpt-5-mini",
            # correct/applied/duration_ms/premium_requests intentionally absent.
        }])

        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["applied_rate"], 0)
        self.assertEqual(row["correct_rate"], 0)
        self.assertIsNone(row["premium_reqs_per_task"])
        self.assertIsNone(row["premium_reqs_per_success"])
        self.assertIsNone(row["seconds_per_task"])
        self.assertIsNone(row["seconds_per_success"])
        self.assertIsNone(row["p50_seconds"])
        self.assertIsNone(row["time_s_mean"])

    def test_aggregate_reports_zero_success_cost_as_no_per_success_not_zero(self):
        rows = run.aggregate([{
            "task": "tdd-slugify",
            "skill": "tdd",
            "arm": "skill",
            "model": "gpt-5-mini",
            "applied": 1,
            "correct": 0,
            "premium_requests": 2,
            "duration_ms": 4000,
        }])

        row = rows[0]
        self.assertEqual(row["premium_reqs_per_task"], 2)
        self.assertEqual(row["seconds_per_task"], 4)
        self.assertEqual(row["p50_seconds"], 4)
        self.assertIsNone(row["premium_reqs_per_success"])
        self.assertIsNone(row["seconds_per_success"])


if __name__ == "__main__":
    unittest.main()
