#!/usr/bin/env python3
import contextlib
import io
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

    def test_aggregate_blanks_partially_reported_telemetry(self):
        base = {
            "task": "tdd-slugify", "skill": "tdd", "arm": "skill",
            "model": "gpt-5-mini", "applied": 1, "correct": 1,
        }

        row = run.aggregate([
            {**base, "premium_requests": 1, "duration_ms": 1000,
             "input_tokens": 10, "cached_input_tokens": 20,
             "cache_write_tokens": 30, "out_tokens": 40},
            base,
        ])[0]

        for field in (
            "premium_reqs_per_task", "premium_reqs_per_success",
            "input_tokens_per_task", "input_tokens_per_success",
            "cached_input_tokens_per_task", "cached_input_tokens_per_success",
            "cache_write_tokens_per_task", "cache_write_tokens_per_success",
            "out_tokens_per_task", "out_tokens_per_success",
            "seconds_per_task", "seconds_per_success", "p50_seconds", "time_s_mean",
        ):
            with self.subTest(field=field):
                self.assertIsNone(row[field])

    def test_meta_copilot_collects_output_tokens_from_message_events(self):
        raw = "\n".join([
            json.dumps({
                "type": "assistant.message",
                "data": {"content": "first", "outputTokens": 12},
            }),
            json.dumps({
                "type": "assistant.message",
                "data": {"content": "final", "outputTokens": 8},
            }),
            json.dumps({
                "type": "result",
                "sessionId": "session-1",
                "exitCode": 0,
                "usage": {"premiumRequests": 0, "sessionDurationMs": 2100},
            }),
        ])

        meta, result_text = run._meta_copilot(raw)

        self.assertEqual(result_text, "final")
        self.assertEqual(meta["session_id"], "session-1")
        self.assertEqual(meta["out_tokens"], 20)

    def test_aggregate_reports_output_tokens_per_task_and_success(self):
        rows = run.aggregate([{
            "task": "tdd-slugify",
            "skill": "tdd",
            "arm": "skill",
            "model": "gpt-5-mini",
            "applied": 1,
            "correct": 1,
            "out_tokens": 123,
        }])

        row = rows[0]
        self.assertEqual(row["out_tokens_per_task"], 123)
        self.assertEqual(row["out_tokens_per_success"], 123)

    def test_parse_pricing_markdown_extracts_openai_and_anthropic_rates(self):
        markdown = """
### OpenAI

| Model | Release status | Category | Tier | Threshold (input tokens) | Input | Cached input | Output |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| GPT-5 mini | GA | Lightweight | Default | Not applicable | $0.25 | $0.025 | $2.00 |

### Anthropic

| Model | Release status | Category | Input | Cached input | Cache write | Output |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| Claude Haiku 4.5 | GA | Versatile | $1.00 | $0.10 | $1.25 | $5.00 |
"""

        rates = run.parse_pricing_markdown(markdown)

        self.assertEqual(rates["gpt-5-mini"], [{
            "display_name": "GPT-5 mini",
            "provider": "OpenAI",
            "tier": "Default",
            "threshold": "Not applicable",
            "input_usd_per_million": 0.25,
            "cached_input_usd_per_million": 0.025,
            "cache_write_usd_per_million": None,
            "output_usd_per_million": 2.0,
        }])
        self.assertEqual(rates["claude-haiku-4.5"][0]["cache_write_usd_per_million"], 1.25)

    def test_load_or_fetch_pricing_snapshots_once_and_reuses_it(self):
        markdown = """
### OpenAI
| Model | Release status | Category | Tier | Threshold (input tokens) | Input | Cached input | Output |
| --- | --- | --- | --- | --- | ---: | ---: | ---: |
| GPT-5 mini | GA | Lightweight | Default | Not applicable | $0.25 | $0.025 | $2.00 |
"""
        calls = []

        def fetch_text(url):
            calls.append(url)
            return markdown

        with tempfile.TemporaryDirectory() as d:
            run_dir = Path(d)
            first = run.load_or_fetch_pricing(run_dir, fetch_text=fetch_text)
            second = run.load_or_fetch_pricing(
                run_dir,
                fetch_text=lambda _url: self.fail("cached pricing should be reused"),
            )
            stored = json.loads((run_dir / "pricing.json").read_text(encoding="utf-8"))

        self.assertEqual(len(calls), 1)
        self.assertEqual(first, second)
        self.assertEqual(second, stored)
        self.assertEqual(second["source_url"], run.PRICING_PAGE_URL)
        self.assertEqual(second["rates"]["gpt-5-mini"][0]["output_usd_per_million"], 2.0)

    def test_read_meta_caches_full_copilot_session_usage(self):
        session_id = "11111111-2222-3333-4444-555555555555"
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as copilot_home:
            workdir = Path(d)
            (workdir / "_cli.json").write_text(json.dumps({
                "type": "result",
                "sessionId": session_id,
                "exitCode": 0,
                "usage": {"premiumRequests": 0.33, "sessionDurationMs": 2100},
            }) + "\n", encoding="utf-8")
            session_dir = Path(copilot_home) / "session-state" / session_id
            session_dir.mkdir(parents=True)
            shutdown = {
                "type": "session.shutdown",
                "data": {
                    "tokenDetails": {
                        "input": {"tokenCount": 38},
                        "cache_read": {"tokenCount": 98068},
                        "cache_write": {"tokenCount": 21573},
                        "output": {"tokenCount": 1944},
                    },
                    "totalNanoAiu": 4653105000,
                    "currentModel": "claude-haiku-4.5",
                    "modelMetrics": {"claude-haiku-4.5": {}},
                },
            }
            (session_dir / "events.jsonl").write_text(
                json.dumps(shutdown) + "\n", encoding="utf-8"
            )

            with mock.patch.dict("os.environ", {"COPILOT_HOME": copilot_home}):
                meta, _result_text = run.read_meta(workdir, "copilot")
            cached = json.loads((workdir / "_usage.json").read_text(encoding="utf-8"))

        self.assertEqual(meta["input_tokens"], 38)
        self.assertEqual(meta["cached_input_tokens"], 98068)
        self.assertEqual(meta["cache_write_tokens"], 21573)
        self.assertEqual(meta["out_tokens"], 1944)
        self.assertEqual(meta["reported_nano_aiu"], 4653105000)
        self.assertEqual(meta["reported_model"], "claude-haiku-4.5")
        self.assertEqual(meta["models_used"], ["claude-haiku-4.5"])
        self.assertEqual(cached["session_id"], session_id)

    def test_price_usage_uses_published_token_categories(self):
        pricing = {"source_url": run.PRICING_PAGE_URL, "rates": {
            "gpt-5-mini": [{
                "input_usd_per_million": 0.25,
                "cached_input_usd_per_million": 0.025,
                "cache_write_usd_per_million": None,
                "output_usd_per_million": 2.0,
            }],
            "claude-haiku-4.5": [{
                "input_usd_per_million": 1.0,
                "cached_input_usd_per_million": 0.1,
                "cache_write_usd_per_million": 1.25,
                "output_usd_per_million": 5.0,
            }],
        }}
        gpt_usage = {
            "input_tokens": 6623,
            "cached_input_tokens": 56064,
            "cache_write_tokens": 0,
            "out_tokens": 1552,
        }
        claude_usage = {
            "input_tokens": 38,
            "cached_input_tokens": 98068,
            "cache_write_tokens": 21573,
            "out_tokens": 1944,
        }

        gpt = run.price_usage(gpt_usage, "gpt-5-mini", pricing)
        claude = run.price_usage(claude_usage, "claude-haiku-4.5", pricing)

        self.assertAlmostEqual(gpt["cost_usd"], 0.00616135)
        self.assertAlmostEqual(gpt["ai_credits"], 0.616135)
        self.assertAlmostEqual(claude["cost_usd"], 0.04653105)
        self.assertAlmostEqual(claude["ai_credits"], 4.653105)
        self.assertEqual(gpt["cost_source"], run.PRICING_PAGE_URL)

    def test_price_usage_prefers_copilot_reported_ai_credits(self):
        pricing = {"source_url": run.PRICING_PAGE_URL, "rates": {
            "gpt-5-mini": [{
                "input_usd_per_million": 0.25,
                "cached_input_usd_per_million": 0.025,
                "cache_write_usd_per_million": None,
                "output_usd_per_million": 2.0,
            }],
        }}
        usage = {
            "input_tokens": 1000,
            "cached_input_tokens": 2000,
            "cache_write_tokens": 0,
            "out_tokens": 3000,
            "reported_nano_aiu": 700_000_000,
        }

        priced = run.price_usage(usage, "gpt-5-mini", pricing)

        self.assertAlmostEqual(priced["cost_usd"], 0.007)
        self.assertAlmostEqual(priced["ai_credits"], 0.7)
        self.assertEqual(priced["cost_source"], "copilot_session")
        self.assertAlmostEqual(priced["website_cost_usd"], 0.0063)
        self.assertAlmostEqual(priced["website_cost_delta_usd"], 0.0007)

    def test_price_usage_marks_tiered_website_reconciliation_unresolved(self):
        pricing = {"source_url": run.PRICING_PAGE_URL, "rates": {
            "gpt-5.5": [
                {"tier": "Default"},
                {"tier": "Long context"},
            ],
        }}
        usage = {
            "input_tokens": 1000, "cached_input_tokens": 2000,
            "cache_write_tokens": 0, "out_tokens": 3000,
            "reported_nano_aiu": 700_000_000,
        }

        priced = run.price_usage(usage, "gpt-5.5", pricing)

        self.assertAlmostEqual(priced["cost_usd"], 0.007)
        self.assertEqual(priced["website_cost_status"], "unresolved_tiered_pricing")
        self.assertNotIn("website_cost_usd", priced)
        self.assertNotIn("website_cost_delta_usd", priced)

    def test_score_workspace_prices_cached_usage_without_a_model_call(self):
        pricing = {"source_url": run.PRICING_PAGE_URL, "rates": {
            "gpt-5-mini": [{
                "input_usd_per_million": 0.25,
                "cached_input_usd_per_million": 0.025,
                "cache_write_usd_per_million": None,
                "output_usd_per_million": 2.0,
            }],
        }}
        temp, workdir = self._good_workspace_with_status("tdd-slugify", {})
        with temp:
            (workdir / "_cli.json").write_text(json.dumps({
                "type": "result", "sessionId": "session-1", "exitCode": 0, "usage": {}
            }) + "\n", encoding="utf-8")
            (workdir / "_usage.json").write_text(json.dumps({
                "session_id": "session-1",
                "input_tokens": 1000,
                "cached_input_tokens": 2000,
                "cache_write_tokens": 0,
                "out_tokens": 3000,
            }), encoding="utf-8")

            score = run.score_workspace(
                "tdd-slugify", "skill", "copilot", workdir,
                model="gpt-5-mini", pricing=pricing,
            )

        self.assertAlmostEqual(score["cost_usd"], 0.0063)
        self.assertAlmostEqual(score["ai_credits"], 0.63)

    def test_score_workspace_uses_resolved_model_for_default_session(self):
        pricing = {"source_url": run.PRICING_PAGE_URL, "rates": {
            "gpt-5-mini": [{
                "input_usd_per_million": 0.25,
                "cached_input_usd_per_million": 0.025,
                "cache_write_usd_per_million": None,
                "output_usd_per_million": 2.0,
            }],
        }}
        temp, workdir = self._good_workspace_with_status("tdd-slugify", {})
        with temp:
            (workdir / "_cli.json").write_text(json.dumps({
                "type": "result", "sessionId": "session-1", "exitCode": 0, "usage": {}
            }) + "\n", encoding="utf-8")
            (workdir / "_usage.json").write_text(json.dumps({
                "session_id": "session-1", "input_tokens": 1000,
                "cached_input_tokens": 2000, "cache_write_tokens": 0,
                "out_tokens": 3000, "reported_model": "gpt-5-mini",
                "models_used": ["gpt-5-mini"],
            }), encoding="utf-8")

            score = run.score_workspace(
                "tdd-slugify", "skill", "copilot", workdir,
                model=run.DEFAULT_MODEL, pricing=pricing,
            )

        self.assertEqual(score["model"], "gpt-5-mini")
        self.assertEqual(score["requested_model"], run.DEFAULT_MODEL)
        self.assertAlmostEqual(score["cost_usd"], 0.0063)

    def test_score_workspace_skips_website_reconciliation_for_multi_model_session(self):
        pricing = {"source_url": run.PRICING_PAGE_URL, "rates": {
            "gpt-5-mini": [{
                "input_usd_per_million": 0.25,
                "cached_input_usd_per_million": 0.025,
                "cache_write_usd_per_million": None,
                "output_usd_per_million": 2.0,
            }],
        }}
        temp, workdir = self._good_workspace_with_status("tdd-slugify", {})
        with temp:
            (workdir / "_cli.json").write_text(json.dumps({
                "type": "result", "sessionId": "session-1", "exitCode": 0, "usage": {}
            }) + "\n", encoding="utf-8")
            (workdir / "_usage.json").write_text(json.dumps({
                "session_id": "session-1", "input_tokens": 1000,
                "cached_input_tokens": 2000, "cache_write_tokens": 0,
                "out_tokens": 3000, "reported_nano_aiu": 700_000_000,
                "reported_model": "gpt-5-mini",
                "models_used": ["gpt-5-mini", "claude-haiku-4.5"],
            }), encoding="utf-8")

            score = run.score_workspace(
                "tdd-slugify", "skill", "copilot", workdir,
                model="gpt-5-mini", pricing=pricing,
            )

        self.assertAlmostEqual(score["cost_usd"], 0.007)
        self.assertEqual(score["cost_source"], "copilot_session")
        self.assertNotIn("website_cost_usd", score)
        self.assertNotIn("website_cost_delta_usd", score)

    def test_aggregate_reports_full_token_and_usd_cost_per_task_and_success(self):
        base = {
            "task": "tdd-slugify", "skill": "tdd", "arm": "skill",
            "model": "gpt-5-mini", "applied": 1,
        }
        rows = run.aggregate([
            {**base, "correct": 1, "input_tokens": 100, "cached_input_tokens": 200,
             "cache_write_tokens": 50, "out_tokens": 300, "cost_usd": 0.01,
             "ai_credits": 1.0},
            {**base, "correct": 0, "input_tokens": 300, "cached_input_tokens": 400,
             "cache_write_tokens": 150, "out_tokens": 500, "cost_usd": 0.03,
             "ai_credits": 3.0},
        ])

        row = rows[0]
        self.assertEqual(row["input_tokens_per_task"], 200)
        self.assertEqual(row["input_tokens_per_success"], 400)
        self.assertEqual(row["cached_input_tokens_per_task"], 300)
        self.assertEqual(row["cache_write_tokens_per_task"], 100)
        self.assertEqual(row["out_tokens_per_task"], 400)
        self.assertEqual(row["cost_usd_per_task"], 0.02)
        self.assertEqual(row["cost_usd_per_success"], 0.04)
        self.assertEqual(row["ai_credits_per_task"], 2.0)
        self.assertEqual(row["ai_credits_per_success"], 4.0)

    def test_aggregate_blanks_partial_costs_instead_of_understating_them(self):
        base = {
            "task": "tdd-slugify", "skill": "tdd", "arm": "skill",
            "model": "gpt-5-mini", "applied": 1, "correct": 1,
        }

        row = run.aggregate([
            {**base, "cost_usd": 0.02, "ai_credits": 2,
             "cost_source": "copilot_session"},
            base,
        ])[0]

        self.assertIsNone(row["cost_usd_per_task"])
        self.assertIsNone(row["cost_usd_per_success"])
        self.assertIsNone(row["ai_credits_per_task"])
        self.assertIsNone(row["ai_credits_per_success"])
        self.assertIsNone(row["cost_mean"])
        self.assertEqual(row["cost_basis"], "partial")

    def test_aggregate_blanks_costs_with_mixed_provenance(self):
        base = {
            "task": "tdd-slugify", "skill": "tdd", "arm": "skill",
            "model": "gpt-5-mini", "applied": 1, "correct": 1,
        }

        row = run.aggregate([
            {**base, "cost_usd": 0.01, "ai_credits": 1,
             "cost_source": "copilot_session"},
            {**base, "cost_usd": 0.02, "ai_credits": 2,
             "cost_source": run.PRICING_PAGE_URL},
        ])[0]

        self.assertIsNone(row["cost_usd_per_task"])
        self.assertIsNone(row["cost_usd_per_success"])
        self.assertIsNone(row["ai_credits_per_task"])
        self.assertIsNone(row["ai_credits_per_success"])
        self.assertEqual(row["cost_basis"], "mixed")

    def test_aggregate_preserves_cost_basis(self):
        rows = run.aggregate([{
            "task": "tdd-slugify", "skill": "tdd", "arm": "skill",
            "model": "gpt-5-mini", "applied": 1, "correct": 1,
            "cost_usd": 0.01, "ai_credits": 1,
            "cost_source": "copilot_session",
        }])

        self.assertEqual(rows[0]["cost_basis"], "copilot_session")

    def test_print_table_shows_cost_and_all_token_categories(self):
        row = {
            "task": "tdd-slugify", "skill": "tdd", "arm": "skill",
            "model": "gpt-5-mini", "n": 1, "applied_rate": 1,
            "correct_rate": 1, "cost_usd_per_success": 0.0063,
            "ai_credits_per_success": 0.63, "input_tokens_per_task": 1000,
            "cached_input_tokens_per_task": 2000,
            "cache_write_tokens_per_task": 30, "out_tokens_per_task": 3000,
            "premium_reqs_per_success": 0, "seconds_per_success": 4,
        }

        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            run.print_table([row])
        rendered = stdout.getvalue()

        self.assertIn("USD/win", rendered)
        self.assertIn("AI/win", rendered)
        self.assertIn("in/task", rendered)
        self.assertIn("cache/task", rendered)
        self.assertIn("write/task", rendered)
        self.assertIn("out/task", rendered)
        self.assertIn("$0.00630000", rendered)

    def test_rescore_uses_saved_pricing_snapshot(self):
        pricing = {"source_url": run.PRICING_PAGE_URL, "rates": {
            "gpt-5-mini": [{
                "input_usd_per_million": 0.25,
                "cached_input_usd_per_million": 0.025,
                "cache_write_usd_per_million": None,
                "output_usd_per_million": 2.0,
            }],
        }}
        with tempfile.TemporaryDirectory() as d:
            run_dir = Path(d)
            (run_dir / "pricing.json").write_text(json.dumps(pricing), encoding="utf-8")
            workdir = run_dir / "tdd-slugify__skill__copilot__gpt-5-mini__0"
            workdir.mkdir()
            run.seed_workspace(TASKS["tdd-slugify"], workdir, ref_kind="good", for_selftest=True)
            (workdir / "_cli.json").write_text(json.dumps({
                "type": "result", "sessionId": "session-1", "exitCode": 0, "usage": {}
            }) + "\n", encoding="utf-8")
            (workdir / "_usage.json").write_text(json.dumps({
                "session_id": "session-1", "input_tokens": 1000,
                "cached_input_tokens": 2000, "cache_write_tokens": 0,
                "out_tokens": 3000,
            }), encoding="utf-8")
            (workdir / "_status.json").write_text("{}", encoding="utf-8")

            run.rescore(run_dir)
            summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))

        self.assertEqual(summary[0]["cost_usd_per_task"], 0.0063)

    def test_rescore_claude_run_does_not_fetch_copilot_pricing(self):
        with tempfile.TemporaryDirectory() as d:
            run_dir = Path(d)
            workdir = run_dir / "tdd-slugify__skill__claude__claude-haiku-4.5__0"
            workdir.mkdir()
            run.seed_workspace(TASKS["tdd-slugify"], workdir, ref_kind="good", for_selftest=True)
            (workdir / "_cli.json").write_text(json.dumps({
                "result": "", "usage": {"input_tokens": 10, "output_tokens": 20},
                "total_cost_usd": 0.01, "duration_ms": 1000, "num_turns": 1,
            }), encoding="utf-8")
            (workdir / "_status.json").write_text("{}", encoding="utf-8")

            with mock.patch("run.load_or_fetch_pricing") as fetch_pricing:
                run.rescore(run_dir)

        fetch_pricing.assert_not_called()

    def test_main_zero_pending_resume_rewrites_results_from_recorded_cells(self):
        with tempfile.TemporaryDirectory() as d:
            run_dir = Path(d)
            workdir = run_dir / "tdd-slugify__skill__copilot__gpt-5-mini__0"
            workdir.mkdir()
            run.seed_workspace(TASKS["tdd-slugify"], workdir,
                               ref_kind="good", for_selftest=True)
            (workdir / "_cli.json").write_text(json.dumps({
                "type": "result", "sessionId": "session-1", "exitCode": 0,
                "usage": {},
            }) + "\n", encoding="utf-8")
            (workdir / "_status.json").write_text("{}", encoding="utf-8")
            (run_dir / "results.json").write_text(json.dumps({
                "date": "stale", "engine": "copilot", "results": [],
            }), encoding="utf-8")
            argv = [
                "run.py", "--task", "tdd-slugify", "--arms", "skill",
                "--engine", "copilot", "--models", "gpt-5-mini", "--no-probe",
                "--resume", str(run_dir),
            ]

            with mock.patch.object(sys, "argv", argv), \
                    mock.patch("run.selftest", return_value=0), \
                    mock.patch("run.load_or_fetch_pricing", return_value=None), \
                    contextlib.redirect_stdout(io.StringIO()):
                run.main()
            persisted = json.loads((run_dir / "results.json").read_text(encoding="utf-8"))

        self.assertEqual(len(persisted["results"]), 1)
        self.assertEqual(persisted["results"][0]["task"], "tdd-slugify")

    def test_main_progress_prints_new_usd_field(self):
        result = {
            "task": "tdd-slugify", "skill": "tdd", "arm": "skill",
            "engine": "copilot", "model": "gpt-5-mini", "applied": 1,
            "correct": 1, "cost_usd": 0.0063,
        }
        with tempfile.TemporaryDirectory() as d:
            argv = [
                "run.py", "--task", "tdd-slugify", "--arms", "skill",
                "--engine", "copilot", "--models", "gpt-5-mini", "--no-probe",
                "--resume", d, "--workers", "1",
            ]
            stdout = io.StringIO()
            with mock.patch.object(sys, "argv", argv), \
                    mock.patch("run.selftest", return_value=0), \
                    mock.patch("run.load_or_fetch_pricing", return_value=None), \
                    mock.patch("run.run_cell", return_value=result), \
                    contextlib.redirect_stdout(stdout):
                run.main()

        rendered = stdout.getvalue()
        self.assertIn("cost=$0.00630000", rendered)
        self.assertNotIn("cost=$None", rendered)


if __name__ == "__main__":
    unittest.main()
