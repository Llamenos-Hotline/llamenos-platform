"""Tests for the shard packer in ui-tests.py (#1873).

    python3 -m unittest discover -s apps/ios/scripts -p "test_*.py"

The behaviour under test is that the packer balances the wall-clock each shard
will take on the host it runs on, instead of one host-blind figure per class.
"""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from collections import defaultdict
from pathlib import Path
from unittest import mock

_spec = importlib.util.spec_from_file_location("ui_tests", Path(__file__).with_name("ui-tests.py"))
assert _spec is not None and _spec.loader is not None
ui = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ui)


def wall_clock(bins: list[list[str]], counts: dict[str, int], prices: dict, hosts: list[str]) -> list[float]:
    return [sum(counts[c] * ui.expected_seconds(prices, c, hosts[i]) for c in classes)
            for i, classes in enumerate(bins)]


class ExpectedSeconds(unittest.TestCase):
    PRICES = {
        "mac": {"A": 10.0, "B": 20.0, "OnlyMac": 8.0},
        "hosted": {"A": 15.0, "B": 30.0, "OnlyHosted": 45.0},
    }

    def test_prefers_the_measurement_on_the_same_host(self):
        self.assertEqual(ui.expected_seconds(self.PRICES, "A", "mac"), 10.0)
        self.assertEqual(ui.expected_seconds(self.PRICES, "A", "hosted"), 15.0)

    def test_scales_the_other_hosts_measurement_by_the_measured_factor(self):
        # Classes measured on both are 1.5x slower hosted, so that is the factor.
        self.assertEqual(ui.host_factor(self.PRICES), 1.5)
        self.assertEqual(ui.expected_seconds(self.PRICES, "OnlyMac", "hosted"), 12.0)
        self.assertEqual(ui.expected_seconds(self.PRICES, "OnlyHosted", "mac"), 30.0)

    def test_unmeasured_class_costs_the_median_class_of_that_host(self):
        self.assertEqual(ui.expected_seconds(self.PRICES, "New", "mac"), 10.0)
        self.assertEqual(ui.expected_seconds(self.PRICES, "New", "hosted"), 30.0)

    def test_no_overlap_falls_back_to_the_documented_factor(self):
        prices = {"mac": {"A": 10.0}, "hosted": {"B": 30.0}}
        self.assertEqual(ui.host_factor(prices), ui.FALLBACK_HOSTED_FACTOR)

    def test_empty_timings_do_not_divide_by_zero(self):
        self.assertEqual(ui.expected_seconds({"mac": {}, "hosted": {}}, "A", "mac"), 1.0)


class Pack(unittest.TestCase):
    def setUp(self):
        # No Mac pins: these tests are about the weighting alone.
        patcher = mock.patch.object(ui, "mac_shard_classes", return_value={})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_slow_host_gets_proportionally_less_work(self):
        counts = {f"C{i}": 4 for i in range(12)}
        prices = {"mac": {c: 10.0 for c in counts}, "hosted": {c: 20.0 for c in counts}}
        bins, loads = ui.pack(counts, defaultdict(int), prices, 4, [0, 3])
        macs = len(bins[0]) + len(bins[3])
        hosted = len(bins[1]) + len(bins[2])
        # Hosted runners are twice as slow, so the Macs carry twice the classes.
        self.assertEqual((macs, hosted), (8, 4))
        self.assertLess(max(loads) / min(loads), 1.05)

    def test_a_host_blind_pack_of_the_same_input_is_the_imbalance_we_fixed(self):
        counts = {f"C{i}": 4 for i in range(12)}
        prices = {"mac": {c: 10.0 for c in counts}, "hosted": {c: 20.0 for c in counts}}
        # Price every shard as a Mac (what the old packer effectively did) ...
        blind, _ = ui.pack(counts, defaultdict(int), prices, 4, [0, 1, 2, 3])
        # ... then run it on the real hosts.
        hosts = ["mac", "hosted", "hosted", "mac"]
        blind_wall = wall_clock(blind, counts, prices, hosts)
        aware, _ = ui.pack(counts, defaultdict(int), prices, 4, [0, 3])
        aware_wall = wall_clock(aware, counts, prices, hosts)
        self.assertGreater(max(blind_wall) / min(blind_wall), 1.5)
        self.assertLess(max(aware_wall) / min(aware_wall), 1.05)

    def test_equal_hosts_balance_like_the_old_rule(self):
        counts = {"Big": 10, "Mid": 5, "Small": 1, "Tiny": 1}
        prices = {"mac": {c: 10.0 for c in counts}, "hosted": {c: 10.0 for c in counts}}
        bins, loads = ui.pack(counts, defaultdict(int), prices, 2, [])
        self.assertEqual(sorted(map(len, bins)), [1, 3])
        self.assertEqual(sorted(loads), [70.0, 100.0])

    def test_every_class_lands_in_exactly_one_shard(self):
        counts = {f"C{i}": i + 1 for i in range(9)}
        prices = {"mac": {c: 5.0 + i for i, c in enumerate(counts)}, "hosted": {}}
        bins, _ = ui.pack(counts, defaultdict(int), prices, 4, [0, 3])
        placed = [c for b in bins for c in b]
        self.assertEqual(sorted(placed), sorted(counts))

    def test_quarantined_tests_are_not_priced(self):
        counts = {"A": 3}
        prices = {"mac": {"A": 10.0}, "hosted": {"A": 10.0}}
        _, loads = ui.pack(counts, defaultdict(int, {"A": 1}), prices, 2, [])
        self.assertEqual(max(loads), 20.0)


class PinnedClasses(unittest.TestCase):
    def test_pinned_classes_only_land_on_mac_shards_whatever_they_cost(self):
        counts = {"Pinned": 1, **{f"C{i}": 10 for i in range(8)}}
        # Pinned is cheap on hosted, so a free placement would send it there.
        prices = {"mac": {"Pinned": 50.0}, "hosted": {"Pinned": 1.0}}
        with mock.patch.object(ui, "mac_shard_classes", return_value={"Pinned": "evidence"}):
            bins, _ = ui.pack(counts, defaultdict(int), prices, 4, [0, 3])
        self.assertTrue("Pinned" in bins[0] or "Pinned" in bins[3])

    def test_pins_with_no_valid_mac_shard_refuse_to_run_hosted(self):
        with mock.patch.object(ui, "mac_shard_classes", return_value={"Pinned": "evidence"}):
            with self.assertRaises(SystemExit):
                ui.pack({"Pinned": 1}, defaultdict(int), {"mac": {}, "hosted": {}}, 2, [7])


class Timings(unittest.TestCase):
    def run_timings(self, host: str, reports: list[list[dict]], existing: dict | None = None) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            timings_file = tmp_path / "ci-timings.json"
            if existing is not None:
                timings_file.write_text(json.dumps(existing), encoding="utf-8")
            paths = []
            for i, cases in enumerate(reports):
                path = tmp_path / f"r{i}.json"
                path.write_text(json.dumps(cases), encoding="utf-8")
                paths.append(path)
            with mock.patch.object(ui, "TIMINGS_FILE", timings_file):
                ui.timings(host, paths)
            return json.loads(timings_file.read_text(encoding="utf-8"))

    @staticmethod
    def case(cls: str, secs: float, status: str = "passed") -> dict:
        return {"class": cls, "test": "testX", "status": status, "seconds": secs}

    def test_takes_the_median_across_runs_so_one_contended_run_cannot_set_the_price(self):
        out = self.run_timings("hosted", [
            [self.case("A", 20)], [self.case("A", 22)], [self.case("A", 90)],
        ])
        self.assertEqual(out["hosted"]["A"], 22.0)

    def test_a_failed_test_does_not_count_towards_the_class_price(self):
        out = self.run_timings("mac", [[self.case("A", 10), self.case("A", 300, "failed")]])
        self.assertEqual(out["mac"]["A"], 10.0)

    def test_only_the_named_host_is_rewritten_and_unmentioned_classes_survive(self):
        out = self.run_timings(
            "mac", [[self.case("A", 12)]],
            existing={"mac": {"A": 99.0, "Kept": 7.0}, "hosted": {"A": 30.0}},
        )
        self.assertEqual(out["mac"], {"A": 12.0, "Kept": 7.0})
        self.assertEqual(out["hosted"], {"A": 30.0})

    def test_reports_with_no_passed_cases_are_refused(self):
        with self.assertRaises(SystemExit):
            self.run_timings("mac", [[self.case("A", 10, "failed")]])


class Report(unittest.TestCase):
    """`** TEST EXECUTE FAILED **` is what xcodebuild prints for ANY failing test."""

    def run_report(self, log: str) -> tuple[int, str]:
        import contextlib
        import io

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "xcodebuild-test.log"
            path.write_text(log, encoding="utf-8")
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                rc = ui.report(path, None)
            return rc, out.getvalue()

    CASES = (
        "Test Case '-[LlamenosUITests.AUITests testOk]' passed (1.0 seconds).\n"
        "Test Case '-[LlamenosUITests.AUITests testBad]' failed (2.0 seconds).\n"
    )

    def test_an_ordinary_assertion_failure_is_not_called_a_harness_failure(self):
        rc, out = self.run_report(self.CASES + "** TEST EXECUTE FAILED **\n")
        self.assertEqual(rc, 1)
        self.assertIn("`AUITests.testBad`", out)
        self.assertNotIn("other than an assertion", out)

    def test_execute_failed_with_every_case_green_is_a_harness_failure(self):
        rc, out = self.run_report(
            "Test Case '-[LlamenosUITests.AUITests testOk]' passed (1.0 seconds).\n"
            "** TEST EXECUTE FAILED **\n"
        )
        self.assertEqual(rc, 1)
        self.assertIn("other than an assertion", out)


class RealTimings(unittest.TestCase):
    def test_the_checked_in_timings_have_both_hosts_and_a_sane_factor(self):
        prices = ui.load_timings()
        self.assertTrue(prices["mac"] and prices["hosted"])
        self.assertTrue(all(v > 0 for h in prices.values() for v in h.values()))
        self.assertTrue(1.0 < ui.host_factor(prices) < 3.0, ui.host_factor(prices))


class NightlyReport(unittest.TestCase):
    """The body of the issue a red scheduled run opens (#2057)."""

    QUARANTINE = [("OwnedUITests", "testKnown", "a filed defect — #1240"),
                  ("OwnedUITests", "testFixedSince", "was broken — #1410")]

    def report(self, shards: dict[int, list[dict]], total: int = 4, failed_jobs: list[str] | None = None) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            for index, cases in shards.items():
                # download-artifact puts each artifact in its own directory.
                d = Path(tmp) / f"ios-e2e-results-json-shard-{index}"
                d.mkdir()
                (d / f"ui-test-results-shard-{index}.json").write_text(json.dumps(cases), encoding="utf-8")
            with mock.patch.object(ui, "quarantine", return_value=self.QUARANTINE):
                return ui.nightly_report(Path(tmp), total, failed_jobs or [], "https://run")

    @staticmethod
    def case(cls: str, test: str, status: str = "passed") -> dict:
        return {"class": cls, "test": test, "status": status, "seconds": 1.0}

    def section(self, body: str, heading: str) -> str:
        return body.split(heading, 1)[1].split("###", 1)[0]

    def test_a_failure_no_quarantine_entry_owns_is_reported_as_new(self):
        body = self.report({0: [self.case("FreshUITests", "testBroken", "failed")], 1: [], 2: [], 3: []})
        new = self.section(body, "### Not owned by any filed defect (1)")
        self.assertIn("`FreshUITests.testBroken` — shard 0", new)

    def test_a_quarantined_failure_is_known_and_names_its_issue(self):
        body = self.report({0: [self.case("OwnedUITests", "testKnown", "failed")], 1: [], 2: [], 3: []})
        self.assertIn("### Not owned by any filed defect (0)\n_none_", body)
        self.assertIn("`OwnedUITests.testKnown` — shard 0 — #1240", self.section(body, "### Quarantined and still failing (1)"))

    def test_a_quarantined_test_that_passed_is_flagged_stale(self):
        body = self.report({0: [self.case("OwnedUITests", "testFixedSince")], 1: [], 2: [], 3: []})
        self.assertIn("`OwnedUITests.testFixedSince` — #1410", self.section(body, "the entry is stale"))

    def test_a_quarantined_test_that_did_not_run_is_not_called_stale(self):
        body = self.report({0: [], 1: [], 2: [], 3: []})
        self.assertNotIn("stale", body)

    def test_a_shard_that_wrote_no_results_is_named_not_skipped(self):
        body = self.report({0: [self.case("A", "testOk")], 2: [], 3: []})
        self.assertIn("Shard(s) 1 wrote no results", body)

    def test_a_timed_out_test_counts_as_failing_and_says_so(self):
        body = self.report({0: [self.case("FreshUITests", "testSlow", "timed-out")], 1: [], 2: [], 3: []})
        self.assertIn("killed for exceeding its time allowance", body)

    def test_failed_jobs_are_listed(self):
        body = self.report({}, failed_jobs=["build (mac)"])
        self.assertIn("`build (mac)`", body)
        self.assertIn("Shard(s) 0, 1, 2, 3 wrote no results", body)

    def test_the_signature_is_stable_for_the_same_failures_and_changes_with_them(self):
        def signature(body: str) -> str:
            return body.splitlines()[0]
        a = self.report({0: [self.case("FreshUITests", "testBroken", "failed")], 1: [], 2: [], 3: []})
        again = self.report({0: [self.case("FreshUITests", "testBroken", "failed"), self.case("Z", "testOk")],
                             1: [], 2: [], 3: []})
        other = self.report({0: [self.case("FreshUITests", "testOther", "failed")], 1: [], 2: [], 3: []})
        self.assertEqual(signature(a), signature(again))
        self.assertNotEqual(signature(a), signature(other))
        self.assertTrue(signature(a).startswith(ui.SIGNATURE_PREFIX))

    def test_an_empty_results_directory_still_produces_a_report(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(ui, "quarantine", return_value=[]):
            body = ui.nightly_report(Path(tmp) / "never-downloaded", 4, ["ui (1)"])
        self.assertIn("0 failing test(s) of 0 executed on 0 of 4 shard(s)", body)
        self.assertIn("Shard(s) 0, 1, 2, 3 wrote no results", body)


if __name__ == "__main__":
    unittest.main()
