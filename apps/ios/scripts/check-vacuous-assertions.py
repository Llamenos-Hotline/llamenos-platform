#!/usr/bin/env python3
r"""Reject XCUITest assertions that cannot fail (issue #1888).

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

How it matches (and why not line-by-line)
-----------------------------------------
A guard that exists to catch assertions that cannot fail must not itself be
evadable by a line break, and Swift freely wraps a call across lines:

    XCTAssertTrue(
        true,   // always passes
        "x"
    )

So the file is NOT scanned a physical line at a time. It is first run through
a small Swift lexer (`sanitize`) that blanks out everything that is not code:
line comments, nested block comments, and string-literal contents (plain,
multi-line triple-quoted, raw `#"..."#`; code inside a `\( ... )` interpolation
is kept, because that IS code). Each blanked character becomes a space and every
newline is kept, so offsets and line numbers stay exact. The ban is then a regex
over the whole sanitized text, where `\s` spans newlines, so wrapping,
interleaved comments and redundant parentheses cannot hide the literal, while a
banned spelling that merely appears in a comment or a string (e.g. the
explanation of why it is banned) is not code and is not flagged.

A lexer was chosen over joining physical lines because joining has to
re-derive, line by line, whether a `//` is a comment or sits inside a string —
exactly the bookkeeping the lexer does once, correctly.

The literal must be the whole first argument (followed by `,` or `)`), so
`XCTAssertTrue(true && ready)` — which can fail — is not flagged.
`XCTAssertFalse(true)` and `XCTAssertTrue(false)` are odd but falsifiable, so
they are not flagged either.

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

# <assertion>( [parens] <literal> [parens] then `,` or `)`. `\s` spans newlines
# because this runs over sanitized whole-file text, not single lines.
CALL = re.compile(
    r"(?<!\w)(XCTAssertTrue|XCTAssertFalse|XCTAssert)\s*\(\s*(?:\(\s*)*"
    r"(true|false)\s*(?:\)\s*)*[,)]"
)
# assertion -> the literal that makes it unfalsifiable.
VACUOUS_LITERAL = {"XCTAssertTrue": "true", "XCTAssertFalse": "false", "XCTAssert": "true"}

_RAW_STRING_START = re.compile(r'#+"')


def _blank(text: str) -> str:
    """Replace every non-newline character with a space."""
    return "".join(c if c == "\n" else " " for c in text)


def sanitize(src: str) -> str:
    """Return `src` with comments and string contents blanked.

    Length and newline positions are preserved, so an offset into the result is
    an offset into `src`.
    """
    out: list[str] = []
    n = len(src)

    def scan_code(i: int, stop_at_close_paren: bool) -> int:
        """Lex code from i. With stop_at_close_paren, return the index just
        after the `)` that closes an interpolation (tracking nested parens)."""
        depth = 0
        while i < n:
            c = src[i]
            two = src[i : i + 2]
            if two == "//":
                j = src.find("\n", i)
                j = n if j == -1 else j
                out.append(_blank(src[i:j]))
                i = j
            elif two == "/*":
                j, nest = i + 2, 1
                while j < n and nest:
                    if src.startswith("/*", j):
                        nest += 1
                        j += 2
                    elif src.startswith("*/", j):
                        nest -= 1
                        j += 2
                    else:
                        j += 1
                out.append(_blank(src[i:j]))
                i = j
            elif c == '"' or (c == "#" and _RAW_STRING_START.match(src, i)):
                i = scan_string(i)
            else:
                if stop_at_close_paren:
                    if c == "(":
                        depth += 1
                    elif c == ")":
                        if depth == 0:
                            out.append(c)
                            return i + 1
                        depth -= 1
                out.append(c)
                i += 1
        return i

    def scan_string(i: int) -> int:
        hashes = 0
        while src[i + hashes] == "#":
            hashes += 1
        quote_at = i + hashes
        triple = src.startswith('"""', quote_at)
        opener = '"""' if triple else '"'
        closer = opener + "#" * hashes
        interp = "\\" + "#" * hashes + "("
        out.append(_blank(src[i : quote_at + len(opener)]))
        j = quote_at + len(opener)
        while j < n:
            if src.startswith(closer, j):
                out.append(_blank(closer))
                return j + len(closer)
            if src.startswith(interp, j):
                out.append(_blank(interp[:-1]))
                out.append("(")
                j = scan_code(j + len(interp), True)
                continue
            if hashes == 0 and src[j] == "\\" and j + 1 < n:
                out.append(_blank(src[j : j + 2]))
                j += 2
                continue
            if not triple and src[j] == "\n":
                return j  # unterminated single-line string: resync at EOL
            out.append(_blank(src[j]))
            j += 1
        return j

    scan_code(0, False)
    return "".join(out)


def find_vacuous(src: str) -> list[tuple[int, str]]:
    """Return (1-based line of the assertion, description) for each ban hit."""
    clean = sanitize(src)
    found = []
    for m in CALL.finditer(clean):
        if VACUOUS_LITERAL[m.group(1)] == m.group(2):
            found.append((clean.count("\n", 0, m.start()) + 1, f"{m.group(1)}({m.group(2)}...)"))
    return found


def main() -> int:
    failures: list[str] = []
    for path in sorted(TESTS_DIR.rglob("*.swift")):
        src = path.read_text()
        lines = src.splitlines()
        for lineno, what in find_vacuous(src):
            failures.append(
                f"{path.relative_to(TESTS_DIR.parent)}:{lineno}: {what}: {lines[lineno - 1].strip()}"
            )

    if failures:
        print(
            "vacuous assertion(s) that cannot fail found under apps/ios/Tests "
            "(issue #1888 bans XCTAssertTrue(true), XCTAssertFalse(false), "
            "XCTAssert(true), however the call is wrapped):",
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
