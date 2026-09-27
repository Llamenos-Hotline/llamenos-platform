#!/usr/bin/env python3
"""Shard the LlamenosUITests target across CI runners, and report what ran.

    ui-tests.py shard --index I --total N [--include-quarantined]
        Print the xcodebuild selection arguments for shard I of N, one per line.
        Every XCTestCase subclass under Tests/UI is assigned to exactly one
        shard; shards are balanced by test-method count (largest class first,
        into the lightest shard), so the assignment is deterministic and a new
        class can never fall through the cracks between shards. Tests listed in
        Tests/UI/ci-quarantine.txt are skipped unless --include-quarantined.

    ui-tests.py check-quarantine
        Fail unless every quarantine entry names an existing test method and
        the issue that owns its failure.

    ui-tests.py report LOG [--json OUT]
        Parse a raw `xcodebuild test` log and print a Markdown summary: every
        test case with its result and duration, per-class totals, and the
        slowest tests. Exits 1 if the log shows zero executed test cases —
        a run that collects nothing is a failure, not a pass.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

IOS_ROOT = Path(__file__).resolve().parents[1]
UI_TESTS_DIR = IOS_ROOT / "Tests" / "UI"
TARGET = "LlamenosUITests"

CLASS_RE = re.compile(r"^\s*(?:final\s+)?class\s+(\w+)\s*:\s*(\w+)", re.MULTILINE)
TEST_RE = re.compile(r"^\s*func\s+(test\w+)\s*\(", re.MULTILINE)
QUARANTINE_FILE = UI_TESTS_DIR / "ci-quarantine.txt"
QUARANTINE_RE = re.compile(r"^(?P<cls>\w+)/(?P<test>test\w+)\s+#\s*(?P<why>.*\S)\s*$")
ISSUE_RE = re.compile(r"(?:^|[^\w&/])#\d+\b")
CASE_RE = re.compile(
    r"Test Case '-\[(?P<target>\w+)\.(?P<cls>\w+) (?P<test>\w+)\]' "
    r"(?P<status>passed|failed|skipped) \((?P<secs>[\d.]+) seconds\)"
)


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


def shard(index: int, total: int, include_quarantined: bool) -> list[str]:
    if not 0 <= index < total:
        raise SystemExit(f"shard index {index} out of range for {total} shards")
    bins: list[list[str]] = [[] for _ in range(total)]
    loads = [0] * total
    for cls, n in sorted(test_classes().items(), key=lambda kv: (-kv[1], kv[0])):
        lightest = loads.index(min(loads))
        bins[lightest].append(cls)
        loads[lightest] += n
    mine = sorted(bins[index])
    args = [f"-only-testing:{TARGET}/{cls}" for cls in mine]
    if not include_quarantined:
        args += [f"-skip-testing:{TARGET}/{cls}/{test}" for cls, test, _ in quarantine() if cls in mine]
    return args


def report(log_path: Path, json_out: Path | None) -> int:
    if not log_path.is_file():
        print(f"**No test log at `{log_path}`** — the test step never ran (see the failed step above).")
        return 1
    cases = []
    for m in CASE_RE.finditer(log_path.read_text(encoding="utf-8", errors="replace")):
        if m.group("target") != TARGET:
            continue
        cases.append(
            {
                "class": m.group("cls"),
                "test": m.group("test"),
                "status": m.group("status"),
                "seconds": float(m.group("secs")),
            }
        )

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
    print(" · ".join(f"{s}: **{by_status[s]}**" for s in ("passed", "failed", "skipped") if by_status[s]))
    print()
    print("| class | tests | passed | failed | skipped | seconds |")
    print("|---|---:|---:|---:|---:|---:|")
    for cls in sorted(per_class):
        rows = per_class[cls]
        n = lambda s: sum(1 for r in rows if r["status"] == s)  # noqa: E731
        print(
            f"| {cls} | {len(rows)} | {n('passed')} | {n('failed')} | {n('skipped')} "
            f"| {sum(r['seconds'] for r in rows):.1f} |"
        )
    failed = [c for c in cases if c["status"] == "failed"]
    if failed:
        print()
        print("#### Failed")
        for c in failed:
            print(f"- `{c['class']}.{c['test']}` ({c['seconds']:.1f}s)")
    print()
    print("#### Slowest 15")
    for c in sorted(cases, key=lambda c: -c["seconds"])[:15]:
        print(f"- `{c['class']}.{c['test']}` {c['status']} {c['seconds']:.1f}s")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("shard")
    s.add_argument("--index", type=int, required=True)
    s.add_argument("--total", type=int, required=True)
    s.add_argument("--include-quarantined", action="store_true")
    sub.add_parser("check-quarantine")
    r = sub.add_parser("report")
    r.add_argument("log", type=Path)
    r.add_argument("--json", type=Path)
    args = ap.parse_args()

    if args.cmd == "shard":
        print("\n".join(shard(args.index, args.total, args.include_quarantined)))
        return 0
    if args.cmd == "check-quarantine":
        return check_quarantine()
    return report(args.log, args.json)


if __name__ == "__main__":
    sys.exit(main())
