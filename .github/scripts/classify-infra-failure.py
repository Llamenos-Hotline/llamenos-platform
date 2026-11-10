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
    classify-infra-failure.py siblings <shard-index>

`siblings` is NOT an infrastructure signature, and is kept apart from them on
purpose (#2618). A hardware-timing flake inside a real assertion carries no
signature at all, so the iOS classifier correctly calls it `genuine`. What can
still be said is that the SAME run's other shards passed. That is evidence the
host, not the code, is at fault -- but only evidence, because a regression
confined to one shard's tests looks identical. So it never decides a verdict by
itself: the caller turns it into exactly ONE failed-tests-only retry, and a
second failure is `genuine`, full stop.

Output is `key=value` lines (shell-friendly; no JSON parsing in bash):

    kind=<zero-tests|infra-partial|script-never-started|infra|genuine|passed>
    signatures=<comma separated names>
    retest=<Class/test Class/test ...>          (ios infra-partial only)
    failed=<Target/Class/test ...>              (ios genuine only: the failed tests, when
                                                 every one of them is accounted for)
    detail=<one line a human can read in the job output>

`siblings` prints sibling_state=<passed|pending|none|unreadable>, siblings=<i:conclusion ...>
and detail=.

Python 3.9 compatible: the macOS runners ship the Xcode-bundled interpreter.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
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

    # Filled in once every failed test is accounted for (below). A genuine
    # verdict carries it as `failed=` so a caller holding independent evidence
    # that the HOST is at fault (#2618) can re-run exactly those tests; it is
    # never a reason to retry on its own, and is empty whenever a failure
    # cannot be fully enumerated.
    accounted = ""

    def genuine(why: str) -> dict[str, str]:
        return {"kind": "genuine", "signatures": "", "retest": "", "failed": accounted, "detail": why}

    started: set[tuple[str, str, str]] = set()
    result: dict[tuple[str, str, str], str] = {}
    for m in CASE_STARTED_RE.finditer(text):
        started.add((m["target"], m["cls"], m["test"]))
    for m in CASE_RESULT_RE.finditer(text):
        result[(m["target"], m["cls"], m["test"])] = m["status"]
    unfinished = started - set(result)
    failed = sorted(k for k, s in result.items() if s == "failed")
    lines = text.splitlines()

    # xcodebuild's own `Failing tests:` list must agree with ours; if it names a
    # test we did not see fail, something else went wrong and we do not guess.
    summary: set[tuple[str, str]] = set()
    for i, line in enumerate(lines):
        if line.strip() == "Failing tests:":
            for item in lines[i + 1:]:
                fm = FAILING_ITEM_RE.match(item)
                if not fm:
                    break
                summary.add((fm["cls"], fm["test"]))
    summary_agrees = not summary or summary == {(c, t) for _, c, t in failed}
    targets = {t for t, _, _ in failed}
    if failed and not unfinished and summary_agrees and len(targets) == 1:
        accounted = " ".join(f"{t}/{c}/{n}" for t, c, n in failed)

    if CASE_TIMEOUT_RE.search(text):
        return genuine("a test exceeded its execution time allowance")
    if unfinished:
        return genuine("a test started and never reported a result (crash or killed run): "
                       + ", ".join(sorted(f"{c}.{t}" for _, c, t in unfinished)))
    if not failed:
        return genuine("non-zero exit but no test case failed")
    if not summary_agrees:
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

    if len(targets) != 1:
        return genuine("failed tests span more than one test target")
    target = next(iter(targets))
    retest = " ".join(f"{target}/{c}/{t}" for _, c, t in failed)
    return {"kind": "infra-partial", "signatures": ",".join(sigs), "retest": retest,
            "detail": f"{len(failed)} test(s) failed and every one of them reported only an infrastructure message"}


def merge_ios(attempt1: str, attempt2: str, superseded: list[str], reason: str = "infra") -> str:
    """The log `ui-tests.py report` parses after a partial retry: attempt 1's
    results EXCEPT for the infra-failed tests, followed by attempt 2.

    Attempt 1's verdict (`** TEST EXECUTE FAILED **`) and the failed Test Case
    lines of the superseded tests are rewritten so the report cannot read them
    as results of the final run; nothing is deleted, and the untouched attempt-1
    log is kept in the results artifact as well.

    `reason` names WHY the tests were re-run ("infra" or "cross-shard", #2618)
    so a reader of the merged log is never told a sibling-evidence retry was
    an infrastructure signature.
    """
    sup = {tuple(s.split("/")[-2:]) for s in superseded}  # (Class, test)
    label = "cross-shard" if reason == "cross-shard" else "infra"
    why = ("while a sibling shard of the same run passed (a host problem is suspected, not proven)"
           if reason == "cross-shard" else "only with infrastructure signatures")
    out = [
        f"=== ios-e2e {label} retry: {len(sup)} test(s) of attempt 1 failed {why} "
        "and were re-run in attempt 2; their attempt-1 result lines are marked SUPERSEDED ==="
    ]
    for line in attempt1.splitlines():
        rm = CASE_RESULT_RE.search(line)
        if rm and rm["status"] == "failed" and (rm["cls"], rm["test"]) in sup:
            line = line.replace("Test Case '-[", f"Test Case (SUPERSEDED by {label} retry) '-[", 1)
        if EXECUTE_FAILED in line:
            line = line.replace(EXECUTE_FAILED, f"[attempt 1: TEST EXECUTE FAILED - superseded by {label} retry]")
        out.append(line)
    out.append(f"=== attempt 2 ({label} retry of the superseded tests) ===")
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


# ------------------------------------------------- sibling shards (#2618) -----

# `ios-e2e / ui (1)` when ci.yml calls the workflow, `ui (1)` when it runs alone.
SHARD_JOB_RE = re.compile(r"^(?:.* / )?ui \((?P<shard>\d+)\)$")
JOBS_PER_PAGE = 100


def sibling_state(jobs: list[dict], shard: str) -> dict[str, str]:
    """What this run's OTHER `ui` shards have concluded, as one verdict.

    passed      at least one sibling finished `success`. Evidence the host is at
                fault, not proof: a regression confined to this shard's tests
                looks the same, which is why the caller retries exactly once.
    pending     no sibling has passed yet, but at least one has not finished.
    none        every sibling finished and none passed (or there are none): no
                evidence, the failure stands.
    unreadable  this shard's own job is not in the listing, so the listing
                cannot be trusted to be this run's.

    `skipped` and `cancelled` are not passes -- a sibling that never reported
    says nothing about the host.
    """
    own = False
    sibs: dict[str, tuple[str, str]] = {}
    for job in jobs:
        m = SHARD_JOB_RE.match(str(job.get("name", "")))
        if not m:
            continue
        if m["shard"] == shard:
            own = True
            continue
        sibs[m["shard"]] = (str(job.get("status") or ""), str(job.get("conclusion") or ""))
    table = " ".join(f"{k}:{c or st or '?'}" for k, (st, c) in sorted(sibs.items())) or "(no siblings)"
    if not own:
        return {"sibling_state": "unreadable", "siblings": table,
                "detail": f"this shard's own job (ui ({shard})) is not in the run's job list, so it cannot be trusted"}
    if any(c == "success" for _, c in sibs.values()):
        return {"sibling_state": "passed", "siblings": table,
                "detail": "a sibling shard of this run passed"}
    if any(st != "completed" for st, _ in sibs.values()):
        return {"sibling_state": "pending", "siblings": table,
                "detail": "no sibling has passed yet and at least one is still running"}
    return {"sibling_state": "none", "siblings": table,
            "detail": "every sibling finished and none passed" if sibs else "this run has no sibling shards"}


def fetch_run_jobs() -> list[dict]:
    """This attempt's jobs, from the Actions API, all pages. Raises on any error
    -- the caller reports `unreadable` and the failure stands."""
    api = os.environ.get("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    repo, run, attempt = (os.environ.get(k, "") for k in ("GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"))
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN") or ""
    if not (repo and run and attempt and token):
        raise RuntimeError("GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_TOKEN must all be set")
    jobs: list[dict] = []
    for page in range(1, 11):
        req = urllib.request.Request(
            f"{api}/repos/{repo}/actions/runs/{run}/attempts/{attempt}/jobs?per_page={JOBS_PER_PAGE}&page={page}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            batch = json.load(resp).get("jobs", [])
        jobs.extend(batch)
        if len(batch) < JOBS_PER_PAGE:
            return jobs
    raise RuntimeError("more than 1000 jobs in one run attempt")


# ---------------------------------------------------------------- CLI --------

def emit(verdict: dict[str, str]) -> None:
    for key in ("kind", "signatures", "retest", "failed", "detail"):
        print(f"{key}={verdict.get(key, '')}")


def main(argv: list[str]) -> int:
    if len(argv) >= 3 and argv[1] == "ios":
        emit(classify_ios(Path(argv[2]).read_text(encoding="utf-8", errors="replace")))
        return 0
    if len(argv) >= 5 and argv[1] == "ios-merge":
        a1 = Path(argv[2]).read_text(encoding="utf-8", errors="replace")
        a2 = Path(argv[3]).read_text(encoding="utf-8", errors="replace")
        rest = argv[5:]
        reason = "infra"
        if rest and rest[0].startswith("--reason="):
            reason = rest[0].split("=", 1)[1]
            rest = rest[1:]
        Path(argv[4]).write_text(merge_ios(a1, a2, rest, reason), encoding="utf-8")
        return 0
    if len(argv) == 3 and argv[1] == "siblings":
        try:
            verdict = sibling_state(fetch_run_jobs(), argv[2])
        except (OSError, ValueError, RuntimeError, urllib.error.URLError) as e:
            verdict = {"sibling_state": "unreadable", "siblings": "", "detail": f"could not read the run's jobs: {e}"}
        for key in ("sibling_state", "siblings", "detail"):
            print(f"{key}={verdict.get(key, '')}")
        return 0
    if len(argv) == 5 and argv[1] == "android":
        log = "" if argv[2] == "-" or not Path(argv[2]).is_file() else Path(argv[2]).read_text(encoding="utf-8", errors="replace")
        emit(classify_android(log, Path(argv[3]).exists(), Path(argv[4])))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
