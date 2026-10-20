#!/usr/bin/env python3
"""Shard the LlamenosUITests target across CI runners, and report what ran.

    ui-tests.py shard --index I --total N [--include-quarantined]
        Print the xcodebuild selection arguments for shard I of N, one per line.
        Every XCTestCase subclass under Tests/UI is assigned to exactly one
        shard, so a new class can never fall through the cracks between shards.
        Shards are balanced by expected WALL-CLOCK on the host each one runs on
        (--mac-shards names the shards routed to the self-hosted Mac; every
        other shard is a GitHub-hosted runner): costliest class first, into the
        shard where it would finish earliest. A class costs the tests the shard
        will actually run times its measured seconds per test ON THAT HOST from
        Tests/UI/ci-timings.json — see `expected_seconds` for what is used when
        the class was never measured there. Tests listed in
        Tests/UI/ci-quarantine.txt are skipped unless --include-quarantined.

    ui-tests.py plan --total N [--mac-shards ...]
        Print each shard's expected wall-clock under the current timings.

    ui-tests.py timings --host mac|hosted REPORT.json...
        Fold `report --json` outputs from shards that ran on HOST into that
        host's section of Tests/UI/ci-timings.json: each class's median, across
        the reports, of its mean seconds per passed test. Classes the reports
        do not mention keep their previous figure.

    ui-tests.py check-quarantine
        Fail unless every quarantine entry names an existing test method and
        the issue that owns its failure.

    ui-tests.py report LOG [--json OUT]
        Parse a raw `xcodebuild test` log and print a Markdown summary: every
        test case with its result and duration, per-class totals, and the
        slowest tests. Exits 1 if the log shows zero executed test cases —
        a run that collects nothing is a failure, not a pass.

    ui-tests.py nightly-report RESULTS_DIR --shards N [--failed-jobs A|B] [--run-url URL]
        Fold the per-shard `report --json` files of a scheduled run into the
        Markdown body of the "iOS nightly is red" issue. Failures are split
        into the ones no filed defect owns (new, untriaged) and the ones
        ci-quarantine.txt already names; quarantined tests that PASSED are
        listed because their entry is stale. A shard that wrote no results is
        named, not skipped. The first line is a signature of the failing set,
        so the workflow can tell a repeat of last night from a change.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

IOS_ROOT = Path(__file__).resolve().parents[1]
UI_TESTS_DIR = IOS_ROOT / "Tests" / "UI"
TARGET = "LlamenosUITests"

CLASS_RE = re.compile(r"^\s*(?:final\s+)?class\s+(\w+)\s*:\s*(\w+)", re.MULTILINE)
TEST_RE = re.compile(r"^\s*func\s+(test\w+)\s*\(", re.MULTILINE)
QUARANTINE_FILE = UI_TESTS_DIR / "ci-quarantine.txt"
SMOKE_FILE = UI_TESTS_DIR / "ci-smoke.txt"
NON_GATING_FILE = UI_TESTS_DIR / "ci-non-gating.txt"
MAC_SHARDS_FILE = UI_TESTS_DIR / "ci-mac-shards.txt"
TIMINGS_FILE = UI_TESTS_DIR / "ci-timings.json"
MAC, HOSTED = "mac", "hosted"
HOSTS = (MAC, HOSTED)
# Whole-shard wall-clock, hosted over Mac, on the same classes (#1873: 1.51x).
# Only the fallback for a timings file with no class measured on both hosts;
# `host_factor` derives the real figure from the file as soon as there is one.
FALLBACK_HOSTED_FACTOR = 1.5
QUARANTINE_RE = re.compile(r"^(?P<cls>\w+)/(?P<test>test\w+)\s+#\s*(?P<why>.*\S)\s*$")
SMOKE_RE = re.compile(r"^(?P<cls>\w+)\s+#\s*(?P<why>.*\S)\s*$")
ISSUE_RE = re.compile(r"(?:^|[^\w&/])#\d+\b")
CASE_RE = re.compile(
    r"Test Case '-\[(?P<target>\w+)\.(?P<cls>\w+) (?P<test>\w+)\]' "
    r"(?P<status>passed|failed|skipped) \((?P<secs>[\d.]+) seconds\)"
)

# A test killed for exceeding its execution time allowance is STILL followed by
# a "passed (N seconds)" line from xcodebuild, so CASE_RE alone records it as a
# pass. One of these turned a dead shard into a summary that read
# "62 passed, 0 failed" while the job itself had failed — the gate held (it
# keys on xcodebuild's exit code) but every human reading the summary saw
# green.
TIMEOUT_RE = re.compile(
    r"Test Case '-\[(?P<target>\w+)\.(?P<cls>\w+) (?P<test>\w+)\]' "
    r"exceeded execution time allowance"
)

# xcodebuild's own verdict. Printed when the test run failed for a reason that
# is not an assertion — a timeout, a crash, a runner that had to be restarted.
EXECUTE_FAILED = "** TEST EXECUTE FAILED **"


def test_classes() -> dict[str, int]:
    """Map every concrete XCTestCase subclass in Tests/UI to its test count.

    A class counts when it inherits (directly or through BaseUITest) from
    XCTestCase. BaseUITest itself declares no tests and is excluded.
    """
    bases: dict[str, str] = {}
    counts: dict[str, int] = {}
    for path in sorted(UI_TESTS_DIR.rglob("*.swift")):
        text = path.read_text(encoding="utf-8")
        for m in CLASS_RE.finditer(text):
            bases[m.group(1)] = m.group(2)
        # Test methods belong to the file's (single) test class.
        classes = [m.group(1) for m in CLASS_RE.finditer(text)]
        if classes:
            counts[classes[0]] = counts.get(classes[0], 0) + len(TEST_RE.findall(text))

    def is_test_case(name: str) -> bool:
        seen = set()
        while name in bases and name not in seen:
            seen.add(name)
            name = bases[name]
            if name == "XCTestCase":
                return True
        return False

    return {c: n for c, n in counts.items() if n > 0 and is_test_case(c)}


def quarantine() -> list[tuple[str, str, str]]:
    """(class, test, why) for every entry in ci-quarantine.txt."""
    if not QUARANTINE_FILE.is_file():
        return []
    entries = []
    for n, line in enumerate(QUARANTINE_FILE.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = QUARANTINE_RE.match(line)
        if not m:
            raise SystemExit(f"{QUARANTINE_FILE.name}:{n}: expected '<Class>/<testMethod>  # <why> — #<issue>'")
        entries.append((m["cls"], m["test"], m["why"]))
    return entries


def check_quarantine() -> int:
    tests: dict[str, set[str]] = {}
    for path in UI_TESTS_DIR.rglob("*.swift"):
        text = path.read_text(encoding="utf-8")
        classes = [m.group(1) for m in CLASS_RE.finditer(text)]
        if classes:
            tests.setdefault(classes[0], set()).update(TEST_RE.findall(text))
    problems = []
    for cls, test, why in quarantine():
        if test not in tests.get(cls, set()):
            problems.append(f"{cls}/{test}: no such test — remove the entry")
        if not ISSUE_RE.search(" " + why):
            problems.append(f"{cls}/{test}: names no issue — a quarantine entry must link the defect that owns it")
    for p in problems:
        print(p)
    print(f"{len(quarantine())} quarantined test(s), {len(problems)} problem(s)")
    return 1 if problems else 0


def smoke_classes() -> dict[str, str]:
    """{class: why} for every entry in ci-smoke.txt — the SMOKE tier's whitelist."""
    if not SMOKE_FILE.is_file():
        return {}
    out: dict[str, str] = {}
    for n, line in enumerate(SMOKE_FILE.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = SMOKE_RE.match(line)
        if not m:
            raise SystemExit(f"{SMOKE_FILE.name}:{n}: expected '<Class>  # <why it is day-one critical>'")
        out[m["cls"]] = m["why"]
    return out


def non_gating_classes() -> dict[str, str]:
    """{class: why} for every entry in ci-non-gating.txt — classes the merge
    gate does not run. Same one-class-per-line shape as ci-smoke.txt."""
    if not NON_GATING_FILE.is_file():
        return {}
    out: dict[str, str] = {}
    for n, line in enumerate(NON_GATING_FILE.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        cls, sep, why = line.partition("#")
        if not sep or not why.strip():
            raise SystemExit(f"{NON_GATING_FILE.name}:{n}: expected '<Class>  # <why it does not gate>'")
        out[cls.strip()] = why.strip()
    return out


def mac_shard_classes() -> dict[str, str]:
    """{class: evidence} for every entry in ci-mac-shards.txt — classes that
    must land on a shard the workflow routes to the self-hosted Mac."""
    if not MAC_SHARDS_FILE.is_file():
        return {}
    out: dict[str, str] = {}
    for n, line in enumerate(MAC_SHARDS_FILE.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        cls, sep, why = line.partition("#")
        if not sep or not why.strip():
            raise SystemExit(f"{MAC_SHARDS_FILE.name}:{n}: expected '<Class>  # <evidence it needs the faster host>'")
        out[cls.strip()] = why.strip()
    return out


def check_mac_shards() -> int:
    """An entry naming a class that no longer exists would silently stop
    pinning it — the class would drift back onto hosted runners and start
    failing again, with nothing pointing at this file."""
    entries = mac_shard_classes()
    known = test_classes()
    problems = [f"{c}: names no existing test class" for c in entries if c not in known]
    for p in problems:
        print(f"  {p}")
    print(f"{len(entries)} Mac-pinned class(es), {len(problems)} problem(s)")
    return 1 if problems else 0


def check_non_gating() -> int:
    """A class excused from the gate must make no claims. If it contains an
    XCTAssert it is a real test, and parking it here hides a verdict nobody
    reads — the exact failure this file exists to prevent, not create."""
    entries = non_gating_classes()
    known = test_classes()
    problems: list[str] = []
    for cls in entries:
        if cls not in known:
            problems.append(f"{cls}: names no existing test class")
            continue
        src = next((p for p in UI_TESTS_DIR.rglob("*.swift")
                    if f"class {cls}" in p.read_text(encoding="utf-8")), None)
        if src is None:
            problems.append(f"{cls}: no source file found")
            continue
        asserts = src.read_text(encoding="utf-8").count("XCTAssert")
        if asserts:
            problems.append(
                f"{cls}: contains {asserts} XCTAssert(s) — a class that asserts "
                f"something may not be excused from the gate")
    for p in problems:
        print(f"  {p}")
    skipped = sum(known.get(c, 0) for c in entries)
    print(f"{len(entries)} non-gating class(es), {skipped} test(s) excluded, {len(problems)} problem(s)")
    return 1 if problems else 0


def check_smoke() -> int:
    """A smoke entry naming a class that no longer exists would shrink the tier
    silently — the same failure mode `check-quarantine` exists to prevent."""
    known = test_classes()
    entries = smoke_classes()
    problems = [f"{cls}: no such XCUITest class — remove the entry" for cls in entries if cls not in known]
    if not entries:
        problems.append("ci-smoke.txt lists no classes — the smoke tier would run nothing")
    for p in problems:
        print(p)
    covered = sum(known.get(c, 0) for c in entries)
    total = sum(known.values())
    pct = (100 * covered / total) if total else 0
    print(f"{len(entries)} smoke class(es), {covered}/{total} tests ({pct:.0f}%), {len(problems)} problem(s)")
    return 1 if problems else 0


def load_timings() -> dict[str, dict[str, float]]:
    """{host: {class: seconds per test}} from ci-timings.json."""
    if not TIMINGS_FILE.is_file():
        return {h: {} for h in HOSTS}
    raw = json.loads(TIMINGS_FILE.read_text(encoding="utf-8"))
    if set(raw) - set(HOSTS) or not all(isinstance(raw.get(h, {}), dict) for h in HOSTS):
        raise SystemExit(f"{TIMINGS_FILE.name}: expected {{'mac': {{class: s}}, 'hosted': {{class: s}}}}, "
                         f"found keys {sorted(raw)}")
    return {h: dict(raw.get(h, {})) for h in HOSTS}


def host_factor(prices: dict[str, dict[str, float]]) -> float:
    """How many times slower a GitHub-hosted runner is than the Mac: the median
    over the classes measured on both."""
    ratios = [prices[HOSTED][c] / prices[MAC][c]
              for c in prices[MAC] if c in prices[HOSTED] and prices[MAC][c] > 0]
    return statistics.median(ratios) if ratios else FALLBACK_HOSTED_FACTOR


def expected_seconds(prices: dict[str, dict[str, float]], cls: str, host: str) -> float:
    """Seconds one test of `cls` is expected to take on `host`.

    The class's own measurement on that host when there is one. Otherwise its
    measurement on the other host, scaled by `host_factor`. A class measured
    nowhere (new, or never run) costs the median class on that host: the
    previous behaviour, but per host, so a class added since the last refresh
    is no longer priced at a figure from the wrong hardware.
    """
    scale = {MAC: 1.0, HOSTED: host_factor(prices)}
    if cls in prices[host]:
        return prices[host][cls]
    other = HOSTED if host == MAC else MAC
    if cls in prices[other]:
        return prices[other][cls] * scale[host] / scale[other]
    own = sorted(prices[host].values())
    if own:
        return own[len(own) // 2]
    borrowed = sorted(prices[other].values())
    return borrowed[len(borrowed) // 2] * scale[host] / scale[other] if borrowed else 1.0


def selection(include_quarantined: bool, only_smoke: bool,
              include_non_gating: bool) -> tuple[dict[str, int], dict[str, int]]:
    """(class -> test count, class -> quarantined tests skipped) for this run."""
    skipped: dict[str, int] = defaultdict(int)
    if not include_quarantined:
        for cls, _, _ in quarantine():
            skipped[cls] += 1
    selected = test_classes()
    # Excused from the gate unless explicitly asked for. These produce an
    # artefact rather than a verdict (check-non-gating enforces that they
    # contain no XCTAssert), so running them on every merge spends critical
    # path on output nobody collects — ScreenshotAuditTests alone was 42
    # methods and ~20 minutes, 44-48% of its shard.
    if not include_non_gating:
        excused = non_gating_classes()
        unknown = [c for c in excused if c not in selected]
        if unknown:
            raise SystemExit(f"ci-non-gating.txt names unknown class(es): {', '.join(sorted(unknown))}")
        selected = {c: n for c, n in selected.items() if c not in excused}
        if not selected:
            raise SystemExit("every class is non-gating — refusing to report a vacuous pass")
    if only_smoke:
        smoke = smoke_classes()
        missing = [c for c in smoke if c not in selected]
        if missing:
            raise SystemExit(f"ci-smoke.txt names unknown class(es): {', '.join(sorted(missing))}")
        selected = {c: n for c, n in selected.items() if c in smoke}
        if not selected:
            raise SystemExit("smoke tier selected no classes — refusing to report a vacuous pass")
    return selected, skipped


def shard(index: int, total: int, include_quarantined: bool, only_smoke: bool = False,
          include_non_gating: bool = False, mac_shards: list[int] | None = None) -> list[str]:
    """Balanced by expected seconds ON THE HOST EACH SHARD RUNS ON, not by test
    count and not by one host-blind figure: the admin classes cost ~50s a test
    and the rest ~20-30s, so count-balanced shards ran 29-43 min in run
    36368999711, and the 43-min shard hit the 45-min step timeout after its last
    test had passed. And a single per-class average priced the Mac and the
    hosted runners identically, which predicted a 20s spread across four shards
    that actually ran 834s apart (#1873) — the hosted pair absorbing the error."""
    if not 0 <= index < total:
        raise SystemExit(f"shard index {index} out of range for {total} shards")
    selected, skipped = selection(include_quarantined, only_smoke, include_non_gating)
    prices = load_timings()
    unpriced = sorted(c for c in selected if not any(c in prices[h] for h in HOSTS))
    if unpriced:
        # Priced at the host's median class, which is how AdminNavigationUITests
        # (~40s a test) ran as a 24.9s one for two weeks and set its shard's
        # wall-clock. Visible, not fatal: a new class cannot be measured before
        # it has run once.
        print(f"::warning::ci-timings.json has no measurement for {', '.join(unpriced)}; "
              f"packed at the median class. Refresh with `ui-tests.py timings --host ...`.",
              file=sys.stderr)
    bins, _ = pack(selected, skipped, prices, total, mac_shards or [])
    mine = sorted(bins[index])
    args = [f"-only-testing:{TARGET}/{cls}" for cls in mine]
    if not include_quarantined:
        args += [f"-skip-testing:{TARGET}/{cls}/{test}" for cls, test, _ in quarantine() if cls in mine]
    return args


def pack(selected: dict[str, int], skipped: dict[str, int], prices: dict[str, dict[str, float]],
         total: int, mac_shards: list[int]) -> tuple[list[list[str]], list[float]]:
    """Assign every class to a shard. Returns (classes per shard, expected
    wall-clock seconds per shard)."""
    mac_targets = [i for i in mac_shards if 0 <= i < total]
    host_of = [MAC if i in mac_targets else HOSTED for i in range(total)]
    # Seconds the class costs on each shard's host.
    cost = {
        cls: [(n - skipped[cls]) * expected_seconds(prices, cls, host_of[i]) for i in range(total)]
        for cls, n in selected.items()
    }

    bins: list[list[str]] = [[] for _ in range(total)]
    loads = [0.0] * total

    # Classes pinned to the Mac are placed FIRST, and only into the shard
    # indices the workflow routes there. Everything else is balanced across all
    # shards afterwards, so the pinning constrains placement without abandoning
    # cost balance for the rest.
    #
    # Without this, which classes land on the Mac is an accident of
    # ci-timings.json: the packer is positional, so a timings refresh silently
    # re-targets the routing. That is not hypothetical — #1428 justified
    # sending shard 3 to the Mac by SecurityUITests' 313s PIN test, while
    # SecurityUITests sat in shard 2, which goes to GitHub.
    pinned = mac_shard_classes() if mac_shards else {}
    if pinned and not mac_targets:
        raise SystemExit(
            f"--mac-shards {mac_shards} names no valid index for --total {total}; "
            f"refusing to silently run Mac-pinned classes on hosted runners")

    def place(cls: str, candidates: list[int]) -> None:
        # Earliest finish, not lightest bin: with unequal hosts the bin that is
        # lightest NOW is not the one that finishes the class first. On equal
        # hosts the two coincide, so this is the old rule there.
        best = min(candidates, key=lambda i: (loads[i] + cost[cls][i], i))
        bins[best].append(cls)
        loads[best] += cost[cls][best]

    for cls in sorted((c for c in pinned if c in cost), key=lambda c: (-max(cost[c]), c)):
        place(cls, mac_targets)
    for cls in sorted((c for c in cost if not (c in pinned and mac_targets)), key=lambda c: (-max(cost[c]), c)):
        place(cls, list(range(total)))
    return bins, loads


def timings(host: str, reports: list[Path]) -> int:
    per_run: dict[str, list[float]] = defaultdict(list)
    for path in reports:
        by_class: dict[str, list[float]] = defaultdict(list)
        for case in json.loads(path.read_text(encoding="utf-8")):
            # A failed or killed test's duration is how long it took to fail,
            # which says nothing about what the class costs.
            if case["status"] == "passed":
                by_class[case["class"]].append(case["seconds"])
        for cls, secs in by_class.items():
            per_run[cls].append(sum(secs) / len(secs))
    if not per_run:
        raise SystemExit("no passed test cases in the given reports")
    current = load_timings()
    # Median across runs: one contended run must not set a class's price.
    current[host].update({cls: round(statistics.median(v), 1) for cls, v in per_run.items()})
    out = {h: dict(sorted(current[h].items())) for h in HOSTS}
    TIMINGS_FILE.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"{TIMINGS_FILE.name}: {host} now prices {len(out[host])} classes "
          f"({len(per_run)} refreshed from {len(reports)} report(s)); hosted/mac = {host_factor(out):.2f}x")
    return 0


def plan(total: int, mac_shards: list[int], include_quarantined: bool, only_smoke: bool,
         include_non_gating: bool) -> int:
    """Print the wall-clock each shard is expected to take under the timings."""
    selected, skipped = selection(include_quarantined, only_smoke, include_non_gating)
    bins, loads = pack(selected, skipped, load_timings(), total, mac_shards)
    for i in range(total):
        host = MAC if i in mac_shards else HOSTED
        print(f"shard {i} ({host:6}) {loads[i]:6.0f}s  {len(bins[i]):2} classes")
    print(f"slowest {max(loads):.0f}s, fastest {min(loads):.0f}s, spread {max(loads) / min(loads):.2f}x")
    return 0


def report(log_path: Path, json_out: Path | None) -> int:
    if not log_path.is_file():
        print(f"**No test log at `{log_path}`** — the test step never ran (see the failed step above).")
        return 1
    text = log_path.read_text(encoding="utf-8", errors="replace")

    # Tests XCTest killed for running too long. Collected first so the status
    # recorded below is the true one rather than the trailing "passed" line.
    timed_out = {
        (m.group("cls"), m.group("test"))
        for m in TIMEOUT_RE.finditer(text)
        if m.group("target") == TARGET
    }

    cases = []
    for m in CASE_RE.finditer(text):
        if m.group("target") != TARGET:
            continue
        key = (m.group("cls"), m.group("test"))
        cases.append(
            {
                "class": m.group("cls"),
                "test": m.group("test"),
                "status": "timed-out" if key in timed_out else m.group("status"),
                "seconds": float(m.group("secs")),
            }
        )

    execute_failed = EXECUTE_FAILED in text

    if json_out:
        json_out.write_text(json.dumps(cases, indent=2) + "\n", encoding="utf-8")

    if not cases:
        print("**No test cases executed.** A shard that collects zero tests is a failure.")
        return 1

    by_status: dict[str, int] = defaultdict(int)
    per_class: dict[str, list[dict]] = defaultdict(list)
    for c in cases:
        by_status[c["status"]] += 1
        per_class[c["class"]].append(c)
    total_secs = sum(c["seconds"] for c in cases)

    print(f"### {TARGET}: {len(cases)} test cases, {total_secs / 60:.1f} min of test time")
    print()
    # "timed-out" is listed alongside the rest so the counts reconcile; a row
    # whose columns do not sum to its test count is how a killed test hides.
    statuses = ("passed", "failed", "timed-out", "skipped")
    print(" · ".join(f"{s}: **{by_status[s]}**" for s in statuses if by_status[s]))
    print()
    print("| class | tests | passed | failed | timed out | skipped | seconds |")
    print("|---|---:|---:|---:|---:|---:|---:|")
    for cls in sorted(per_class):
        rows = per_class[cls]
        n = lambda s: sum(1 for r in rows if r["status"] == s)  # noqa: E731
        print(
            f"| {cls} | {len(rows)} | {n('passed')} | {n('failed')} | {n('timed-out')} | {n('skipped')} "
            f"| {sum(r['seconds'] for r in rows):.1f} |"
        )
    failed = [c for c in cases if c["status"] in ("failed", "timed-out")]
    if failed:
        print()
        print("#### Failed")
        for c in failed:
            why = " — **killed for exceeding its execution time allowance**" if c["status"] == "timed-out" else ""
            print(f"- `{c['class']}.{c['test']}` ({c['seconds']:.1f}s){why}")
    print()
    print("#### Slowest 15")
    for c in sorted(cases, key=lambda c: -c["seconds"])[:15]:
        print(f"- `{c['class']}.{c['test']}` {c['status']} {c['seconds']:.1f}s")

    # Report a failure for anything that failed the RUN, not only anything that
    # failed an assertion. Without this a timeout or a crash-restart is
    # summarised as a clean pass, because xcodebuild still prints a trailing
    # "passed (N seconds)" for the test it just killed.
    if execute_failed or timed_out:
        print()
        if timed_out:
            names = ", ".join(f"`{c}.{t}`" for c, t in sorted(timed_out))
            print(f"**Killed for exceeding the execution time allowance:** {names}")
        if execute_failed:
            print(f"**xcodebuild reported `{EXECUTE_FAILED}`** — the run failed for a reason other than an assertion.")
        return 1
    return 0


RESULTS_FILE_RE = re.compile(r"ui-test-results-shard-(?P<shard>\d+)\.json$")
ISSUE_NUMBER_RE = re.compile(r"#(\d+)")
SIGNATURE_PREFIX = "<!-- ios-nightly-signature:"


def nightly_report(results_dir: Path, shards: int, failed_jobs: list[str], run_url: str = "") -> str:
    """Markdown body for the scheduled run's issue; line 1 is the failing-set signature.

    Reads every `ui-test-results-shard-N.json` under `results_dir` (the files
    `report --json` writes). Three things are kept apart on purpose, because
    only the first is news:

    * failures no quarantine entry owns   -> a new regression or an untriaged flake
    * failures a quarantine entry owns    -> known; shown so they stay visible daily
    * quarantined tests that passed       -> the entry is stale

    A shard with no results file is listed as such. A dead shard (runner
    refused, hub unreachable, Xcode out of date) otherwise contributes nothing
    and a run that lost half its tests reads as a short list of failures.
    """
    seen: dict[int, list[dict]] = {}
    for path in sorted(results_dir.rglob("*.json")) if results_dir.is_dir() else []:
        m = RESULTS_FILE_RE.search(path.name)
        if m:
            seen[int(m["shard"])] = json.loads(path.read_text(encoding="utf-8"))
    missing = [i for i in range(shards) if i not in seen]

    owners = {(c, t): ISSUE_NUMBER_RE.findall(why) for c, t, why in quarantine()}
    failing: dict[tuple[str, str], int] = {}
    passed: set[tuple[str, str]] = set()
    for shard_index, cases in seen.items():
        for case in cases:
            key = (case["class"], case["test"])
            if case["status"] in ("failed", "timed-out"):
                failing[key] = shard_index
            elif case["status"] == "passed":
                passed.add(key)
    new = sorted(k for k in failing if k not in owners)
    known = sorted(k for k in failing if k in owners)
    stale = sorted(k for k in owners if k in passed and k not in failing)

    def label(key: tuple[str, str]) -> str:
        return f"`{key[0]}.{key[1]}`"

    def tag(key: tuple[str, str]) -> str:
        n = failing[key]
        return f"shard {n}" + (" — killed for exceeding its time allowance" if any(
            c["class"] == key[0] and c["test"] == key[1] and c["status"] == "timed-out" for c in seen[n]) else "")

    signature = hashlib.sha1(json.dumps(
        [[f"{c}.{t}" for c, t in new], [f"{c}.{t}" for c, t in known], missing, sorted(failed_jobs)]
    ).encode()).hexdigest()[:16]

    out = [f"{SIGNATURE_PREFIX}{signature} -->"]
    total = sum(len(v) for v in seen.values())
    out.append(f"{len(failing)} failing test(s) of {total} executed on {len(seen)} of {shards} shard(s)"
               + (f" — [run]({run_url})" if run_url else "") + ".")
    if failed_jobs:
        out += ["", "**Failed or cancelled jobs:** " + ", ".join(f"`{j}`" for j in sorted(failed_jobs))]
    if missing:
        out += ["", f"**Shard(s) {', '.join(map(str, missing))} wrote no results** — the job died before or during "
                    "the test step (runner refusal, unreachable hub, toolchain). That is not a test verdict; read "
                    "the failed job, and note this run covered fewer tests than a full one."]
    out += ["", f"### Not owned by any filed defect ({len(new)})"]
    out += [f"- {label(k)} — {tag(k)}" for k in new] or ["_none_"]
    if new:
        out += ["", "Nothing in `apps/ios/Tests/UI/ci-quarantine.txt` covers these. Treat each as a real defect "
                    "until shown otherwise: the failures this suite's authors first called flaky turned out to be races "
                    "in the app or the test."]
    out += ["", f"### Quarantined and still failing ({len(known)})"]
    out += [f"- {label(k)} — {tag(k)} — " + ", ".join(f"#{n}" for n in owners[k]) for k in known] or ["_none_"]
    if stale:
        out += ["", f"### Quarantined but passing ({len(stale)}) — the entry is stale",
                "Remove the entry in the PR that proves the test passes; until then the merge gate skips a test that works."]
        out += [f"- {label(k)} — " + ", ".join(f"#{n}" for n in owners[k]) for k in stale]
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sel = argparse.ArgumentParser(add_help=False)
    sel.add_argument("--total", type=int, required=True)
    sel.add_argument("--include-quarantined", action="store_true")
    sel.add_argument("--only-smoke", action="store_true",
                     help="restrict selection to the classes in ci-smoke.txt (SMOKE tier)")
    sel.add_argument("--mac-shards", default="",
                     help="comma-separated shard indices the workflow routes to the self-hosted Mac; "
                          "classes in ci-mac-shards.txt are confined to these, and every shard not "
                          "listed is priced as a GitHub-hosted runner")
    sel.add_argument("--include-non-gating", action="store_true",
                     help="also select the classes in ci-non-gating.txt (asset generation; "
                          "excluded by default because nothing consumes their output)")
    s = sub.add_parser("shard", parents=[sel])
    s.add_argument("--index", type=int, required=True)
    sub.add_parser("plan", parents=[sel], help="print each shard's expected wall-clock under the timings")
    sub.add_parser("check-quarantine")
    sub.add_parser("check-smoke")
    sub.add_parser("check-non-gating")
    sub.add_parser("check-mac-shards")
    t = sub.add_parser("timings")
    t.add_argument("--host", choices=HOSTS, required=True,
                   help="the kind of runner the reports' shards ran on")
    t.add_argument("reports", type=Path, nargs="+")
    r = sub.add_parser("report")
    r.add_argument("log", type=Path)
    r.add_argument("--json", type=Path)
    n = sub.add_parser("nightly-report", help="Markdown issue body for a scheduled run's failures")
    n.add_argument("results_dir", type=Path)
    n.add_argument("--shards", type=int, required=True, help="how many ui shards the run had")
    n.add_argument("--failed-jobs", default="", help="'|'-separated names of the jobs that failed")
    n.add_argument("--run-url", default="")
    args = ap.parse_args()

    if args.cmd in ("shard", "plan"):
        mac_shards = [int(x) for x in args.mac_shards.split(",") if x.strip()]
        if args.cmd == "plan":
            return plan(args.total, mac_shards, args.include_quarantined, args.only_smoke,
                        args.include_non_gating)
        print("\n".join(shard(args.index, args.total, args.include_quarantined, args.only_smoke,
                              args.include_non_gating, mac_shards)))
        return 0
    if args.cmd == "check-quarantine":
        return check_quarantine()
    if args.cmd == "check-smoke":
        return check_smoke()
    if args.cmd == "check-non-gating":
        return check_non_gating()
    if args.cmd == "check-mac-shards":
        return check_mac_shards()
    if args.cmd == "timings":
        return timings(args.host, args.reports)
    if args.cmd == "nightly-report":
        print(nightly_report(args.results_dir, args.shards,
                             [j for j in args.failed_jobs.split("|") if j], args.run_url), end="")
        return 0
    return report(args.log, args.json)


if __name__ == "__main__":
    sys.exit(main())
