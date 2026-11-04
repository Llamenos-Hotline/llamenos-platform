#!/usr/bin/env python3
"""Tells a broken CI runner apart from broken code (#2446).

Every verdict this prints is meant to be READ by a workflow step that then
retries ONCE, loudly. It is deliberately a CLASSIFIER OF INFRASTRUCTURE
SIGNATURES, not of failures: the only way to get a retry out of it is for the
evidence to name the runner as the thing that broke. Anything it cannot place
confidently comes back `genuine`, and the caller leaves the job failing.

    classify-infra-failure.py ios <xcodebuild-log>
    classify-infra-failure.py ios-merge <attempt1-log> <attempt2-log> <out-log> <Class/test>...
    classify-infra-failure.py android <gradle-log|-> <script-started-marker> <androidTest-results-dir>

Output is `key=value` lines (shell-friendly; no JSON parsing in bash):

    kind=<zero-tests|infra-partial|script-never-started|infra|genuine|passed>
    signatures=<comma separated names>
    retest=<Class/test Class/test ...>          (ios infra-partial only)
    detail=<one line a human can read in the job output>

Python 3.9 compatible: the macOS runners ship the Xcode-bundled interpreter.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

# ---------------------------------------------------------------- iOS --------

# Messages that are the runner telling us it could not START or QUERY the thing
# under test. Matched against the FIRST line of an XCTest issue message, anchored
# at its start: a genuine assertion (`XCTAssertTrue failed - ...`, a custom
# failure string, `Failed to ...` from our own helpers) never begins this way.
IOS_INFRA_MESSAGES = (
    # The app could not be launched (SpringBoard busy, simulator wedged, ...).
    ("launch-progress", re.compile(r"^Failed to get launch progress for ")),
    # XCUITest's own accessibility-snapshot timeout: the app (or the simulator
    # under it) stopped answering queries.
    ("ui-snapshot-timeout", re.compile(r"^Failed to get matching snapshots: Timed out while evaluating UI query")),
)

CASE_ANY_RE = re.compile(r"Test Case '-\[")
CASE_STARTED_RE = re.compile(r"Test Case '-\[(?P<target>\w+)\.(?P<cls>\w+) (?P<test>\w+)\]' started")
CASE_RESULT_RE = re.compile(
    r"Test Case '-\[(?P<target>\w+)\.(?P<cls>\w+) (?P<test>\w+)\]' (?P<status>passed|failed|skipped) \("
)
CASE_TIMEOUT_RE = re.compile(r"Test Case '-\[(?P<target>\w+)\.(?P<cls>\w+) (?P<test>\w+)\]' exceeded execution time allowance")
# `<file>:<line>: error: -[Target.Class test] : <message>` — xcodebuild prints one
# per recorded XCTest issue, naming the test, so attribution does not depend on
# where in the log the line sits.
ISSUE_RE = re.compile(r"^(?P<loc>.*?): error: -\[(?P<target>\w+)\.(?P<cls>\w+) (?P<test>\w+)\] : (?P<msg>.*)$")
# `Failing tests:` summary, one `\tClass.test()` per line. xcodebuild's own
# list of what failed; used to cross-check ours.
FAILING_ITEM_RE = re.compile(r"^\s+(?P<cls>\w+)\.(?P<test>\w+)\(\)\s*$")

EXECUTE_FAILED = "** TEST EXECUTE FAILED **"


def ios_message_signature(msg: str) -> str | None:
    for name, rx in IOS_INFRA_MESSAGES:
        if rx.search(msg):
            return name
    return None


def classify_ios(text: str) -> dict[str, str]:
    """Verdict on ONE failed xcodebuild attempt (the caller has already seen a
    non-zero exit; a zero exit is never classified)."""
    if not CASE_ANY_RE.search(text):
        # No `Test Case '-[` line at all: no test ever started, so there is no
        # assertion result to lose. (The #2403 criterion, unchanged.)
        return {"kind": "zero-tests", "signatures": "zero-tests-executed", "retest": "",
                "detail": "xcodebuild started no test"}

    def genuine(why: str) -> dict[str, str]:
        return {"kind": "genuine", "signatures": "", "retest": "", "detail": why}

    started: set[tuple[str, str, str]] = set()
    result: dict[tuple[str, str, str], str] = {}
    for m in CASE_STARTED_RE.finditer(text):
        started.add((m["target"], m["cls"], m["test"]))
    for m in CASE_RESULT_RE.finditer(text):
        result[(m["target"], m["cls"], m["test"])] = m["status"]
    if CASE_TIMEOUT_RE.search(text):
        return genuine("a test exceeded its execution time allowance")
    unfinished = started - set(result)
    if unfinished:
        return genuine("a test started and never reported a result (crash or killed run): "
                       + ", ".join(sorted(f"{c}.{t}" for _, c, t in unfinished)))

    failed = sorted(k for k, s in result.items() if s == "failed")
    if not failed:
        return genuine("non-zero exit but no test case failed")

    # xcodebuild's own `Failing tests:` list must agree with ours; if it names a
    # test we did not see fail, something else went wrong and we do not guess.
    summary: set[tuple[str, str]] = set()
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip() == "Failing tests:":
            for item in lines[i + 1:]:
                fm = FAILING_ITEM_RE.match(item)
                if not fm:
                    break
                summary.add((fm["cls"], fm["test"]))
    if summary and summary != {(c, t) for _, c, t in failed}:
        return genuine("xcodebuild's `Failing tests:` list disagrees with the failed Test Case lines")

    issues: dict[tuple[str, str, str], list[str]] = {}
    for line in lines:
        im = ISSUE_RE.match(line)
        if im:
            issues.setdefault((im["target"], im["cls"], im["test"]), []).append(im["msg"])

    sigs: list[str] = []
    for key in failed:
        msgs = issues.get(key, [])
        if not msgs:
            return genuine(f"{key[1]}.{key[2]} failed with no recorded issue message")
        for msg in msgs:
            sig = ios_message_signature(msg)
            if sig is None:
                return genuine(f"{key[1]}.{key[2]} failed with a non-infrastructure message: {msg[:160]}")
            if sig not in sigs:
                sigs.append(sig)

    targets = {t for t, _, _ in failed}
    if len(targets) != 1:
        return genuine("failed tests span more than one test target")
    target = next(iter(targets))
    retest = " ".join(f"{target}/{c}/{t}" for _, c, t in failed)
    return {"kind": "infra-partial", "signatures": ",".join(sigs), "retest": retest,
            "detail": f"{len(failed)} test(s) failed and every one of them reported only an infrastructure message"}


def merge_ios(attempt1: str, attempt2: str, superseded: list[str]) -> str:
    """The log `ui-tests.py report` parses after a partial retry: attempt 1's
    results EXCEPT for the infra-failed tests, followed by attempt 2.

    Attempt 1's verdict (`** TEST EXECUTE FAILED **`) and the failed Test Case
    lines of the superseded tests are rewritten so the report cannot read them
    as results of the final run; nothing is deleted, and the untouched attempt-1
    log is kept in the results artifact as well.
    """
    sup = {tuple(s.split("/")[-2:]) for s in superseded}  # (Class, test)
    out = [
        f"=== ios-e2e infra retry: {len(sup)} test(s) of attempt 1 failed only with infrastructure "
        "signatures and were re-run in attempt 2; their attempt-1 result lines are marked SUPERSEDED ==="
    ]
    for line in attempt1.splitlines():
        rm = CASE_RESULT_RE.search(line)
        if rm and rm["status"] == "failed" and (rm["cls"], rm["test"]) in sup:
            line = line.replace("Test Case '-[", "Test Case (SUPERSEDED by infra retry) '-[", 1)
        if EXECUTE_FAILED in line:
            line = line.replace(EXECUTE_FAILED, "[attempt 1: TEST EXECUTE FAILED - superseded by infra retry]")
        out.append(line)
    out.append("=== attempt 2 (infra retry of the superseded tests) ===")
    out.extend(attempt2.splitlines())
    return "\n".join(out) + "\n"


# ------------------------------------------------------------- Android -------

# Seen verbatim in a failed hosted shard (run 41779683568, android-e2e (3)).
ANDROID_INFRA_LINES = (
    ("adb-device-not-found", re.compile(r"adb: device '[^']+' not found")),
    ("emulator-boot-timeout", re.compile(r"Timeout waiting for emulator to boot")),
    ("emulator-no-disk-space", re.compile(r"FATAL\s*\|\s*Your device does not have enough disk space")),
)
# A per-test failure line Gradle prints for connected tests:
# `Feature > scenario[Pixel_5(AVD) - 14] FAILED`, and the summary sentence.
ANDROID_TEST_FAILED_RE = re.compile(r"^\S.* > .*\[[^\]]*\] FAILED\s*$", re.MULTILINE)
ANDROID_FAILING_TESTS_RE = re.compile(r"There were failing tests", re.IGNORECASE)
ANDROID_XML_FAILURE_RE = re.compile(r"<(failure|error)\b")


def classify_android(log: str, marker_exists: bool, results_dir: Path | None) -> dict[str, str]:
    """Verdict on ONE failed android-e2e test step.

    `marker_exists` is the file the test script writes as its first action. If
    it is absent the emulator never came up and not one test ran — there is no
    assertion result to lose, whatever the action's own log said.
    """
    if not marker_exists:
        return {"kind": "script-never-started", "signatures": "emulator-did-not-boot", "retest": "",
                "detail": "the test script never started, so no test executed (emulator did not come up)"}

    def genuine(why: str) -> dict[str, str]:
        return {"kind": "genuine", "signatures": "", "retest": "", "detail": why}

    if ANDROID_FAILING_TESTS_RE.search(log) or ANDROID_TEST_FAILED_RE.search(log):
        return genuine("Gradle reported failing tests")
    if results_dir is not None and results_dir.is_dir():
        for xml in results_dir.rglob("*.xml"):
            try:
                if ANDROID_XML_FAILURE_RE.search(xml.read_text(encoding="utf-8", errors="replace")):
                    return genuine(f"{xml.name} records a failing test")
            except OSError:
                return genuine(f"could not read {xml.name}")
    sigs = [name for name, rx in ANDROID_INFRA_LINES if rx.search(log)]
    if not sigs:
        return genuine("no infrastructure signature in the Gradle output")
    return {"kind": "infra", "signatures": ",".join(sigs), "retest": "",
            "detail": "Gradle failed with an infrastructure signature and no failing test"}


# ---------------------------------------------------------------- CLI --------

def emit(verdict: dict[str, str]) -> None:
    for key in ("kind", "signatures", "retest", "detail"):
        print(f"{key}={verdict.get(key, '')}")


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "ios":
        emit(classify_ios(Path(argv[2]).read_text(encoding="utf-8", errors="replace")))
        return 0
    if len(argv) >= 5 and argv[1] == "ios-merge":
        a1 = Path(argv[2]).read_text(encoding="utf-8", errors="replace")
        a2 = Path(argv[3]).read_text(encoding="utf-8", errors="replace")
        Path(argv[4]).write_text(merge_ios(a1, a2, argv[5:]), encoding="utf-8")
        return 0
    if len(argv) == 5 and argv[1] == "android":
        log = "" if argv[2] == "-" or not Path(argv[2]).is_file() else Path(argv[2]).read_text(encoding="utf-8", errors="replace")
        emit(classify_android(log, Path(argv[3]).exists(), Path(argv[4])))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
