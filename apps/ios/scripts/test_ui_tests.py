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


class RealTimings(unittest.TestCase):
    def test_the_checked_in_timings_have_both_hosts_and_a_sane_factor(self):
        prices = ui.load_timings()
        self.assertTrue(prices["mac"] and prices["hosted"])
        self.assertTrue(all(v > 0 for h in prices.values() for v in h.values()))
        self.assertTrue(1.0 < ui.host_factor(prices) < 3.0, ui.host_factor(prices))


if __name__ == "__main__":
    unittest.main()
