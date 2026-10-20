#!/usr/bin/env python3
"""Reject XCUITest assertions that cannot fail (issue #1888).

An assertion whose expected value is a boolean literal is true no matter what
the app does:

    XCTAssertTrue(true)      // passes always
    XCTAssertFalse(false)    // passes always
    XCTAssert(true)          // passes always

These showed up as the "success" branch of tests that could not reach the
state they claimed to verify, and each conversion in #1884/#1888 that could
fail did fail — meaning every one of them had been silently passing while the
behavior was broken. Swift has no linter in this repo (#1876), so this script
is the gate: it scans apps/ios/Tests for the three forms and fails the build
if any come back.

Lines that are entirely comments (after leading whitespace they start with
`//`, `*`, or `/*`) are ignored — mentioning the pattern in a comment that
explains why it is banned is not the defect.

Usage:
    python3 apps/ios/scripts/check-vacuous-assertions.py

Exit code 0: no vacuous assertions found.
Exit code 1: one or more found; each is printed with file and line number.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parents[1] / "Tests"

# XCTAssertTrue(true / XCTAssertFalse(false / XCTAssert(true, allowing
# whitespace inside the parentheses. XCTAssertFalse(true) and
# XCTAssertTrue(false) are odd but falsifiable, so they are not flagged.
VACUOUS = re.compile(
    r"XCTAssertTrue\s*\(\s*true\b"
    r"|XCTAssertFalse\s*\(\s*false\b"
    r"|XCTAssert\s*\(\s*true\b"
)

COMMENT_LINE = re.compile(r"^\s*(//|\*|/\*)")


def main() -> int:
    failures: list[str] = []
    for path in sorted(TESTS_DIR.rglob("*.swift")):
        for lineno, line in enumerate(path.read_text().splitlines(), start=1):
            if COMMENT_LINE.match(line):
                continue
            if VACUOUS.search(line):
                failures.append(f"{path.relative_to(TESTS_DIR.parent)}:{lineno}: {line.strip()}")

    if failures:
        print(
            "vacuous assertion(s) that cannot fail found under apps/ios/Tests "
            "(issue #1888 bans XCTAssertTrue(true), XCTAssertFalse(false), "
            "XCTAssert(true)):",
            file=sys.stderr,
        )
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        print(
            "Assert the state the test claims to verify instead — see "
            "apps/ios/scripts/check-vacuous-assertions.py.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
