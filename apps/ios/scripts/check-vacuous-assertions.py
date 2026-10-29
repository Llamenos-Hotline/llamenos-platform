#!/usr/bin/env python3
r"""Reject XCUITest assertions that cannot fail (issue #1888).

An assertion whose outcome is decided by its own arguments passes no matter
what the app does:

    XCTAssertTrue(true)              // a boolean literal
    XCTAssertFalse(false)
    XCTAssert(true)
    XCTAssertTrue(1 == 1)            // a comparison of two literals
    XCTAssertEqual("a", "a")
    XCTAssertNotEqual(1, 2)
    XCTAssertGreaterThan(2, 1)
    XCTAssertNil(nil)
    XCTAssertNotNil("x")
    let alwaysOn = true              // a constant: a name bound once, in the
    XCTAssertTrue(alwaysOn)          // file, to a literal

These showed up as the "success" branch of tests that could not reach the
state they claimed to verify, and each conversion in #1884/#1888 that could
fail did fail — meaning every one of them had been silently passing while the
behavior was broken. Swift has no linter in this repo (#1876), so this script
is the gate: it scans apps/ios/Tests for these forms and fails the build if
any come back.

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
newline is kept, so offsets and line numbers stay exact. Assertion calls are
then found by regex over the whole sanitized text, where `\s` spans newlines,
and each call's argument list is split by bracket depth rather than by line, so
wrapping, interleaved comments and redundant parentheses cannot hide the
literal, while a banned spelling that merely appears in a comment or a string
(e.g. the explanation of why it is banned) is not code and is not flagged. A
second view keeps the strings (blanking only comments), so string literals can
be compared by value.

A lexer was chosen over joining physical lines because joining has to
re-derive, line by line, whether a `//` is a comment or sits inside a string —
exactly the bookkeeping the lexer does once, correctly.

An argument counts as constant only when the WHOLE argument is a literal
(bool, number, nil, or a plain string without escapes or interpolation), `!` of
a boolean constant, one comparison between two constants of the same kind, or
a name the file binds exactly once with `let NAME = <constant>` and never
rebinds (a parameter, closure or loop variable of that name leaves it
unresolved). So `XCTAssertTrue(true && ready)` and `XCTAssertEqual(count, 1)` —
which can fail — are not flagged. Assertions that can never PASS
(`XCTAssertTrue(false)`, `XCTAssertEqual(1, 2)`) are not flagged either: a run
shows those; this gate is for the silent kind. Equality `accuracy:` tolerances
are not modelled, so such calls are never flagged.

Usage:
    python3 apps/ios/scripts/check-vacuous-assertions.py

Exit code 0: no vacuous assertions found.
Exit code 1: one or more found; each is printed with file and line number.
"""
from __future__ import annotations

import re
import sys
import unicodedata
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parents[1] / "Tests"

# The assertions whose outcome can be decided from their arguments alone.
ASSERTION = re.compile(
    r"(?<![\w.])(?:XCTest\s*\.\s*)?(XCTAssert(?:True|False|Nil|NotNil|Equal|NotEqual"
    r"|GreaterThanOrEqual|GreaterThan|LessThanOrEqual|LessThan)?)\s*\("
)
_NUMBER = re.compile(r"-?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?")
# A plain one-line string with no escape or interpolation, so its value is
# exactly the text between the quotes.
_STRING = re.compile(r'"([^"\\\n]*)"')
_IDENT = re.compile(r"[A-Za-z_]\w*")
_COMPARISON = re.compile(r"==|!=|<=|>=|<|>")
_CLOSERS = {"(": ")", "[": "]", "{": "}"}
_ORDER = {
    "<": lambda a, b: a < b, "<=": lambda a, b: a <= b,
    ">": lambda a, b: a > b, ">=": lambda a, b: a >= b,
}
# assertion -> (operator applied to the first two constant arguments, kinds it
# is decided for); the assertion cannot fail when the operator yields True.
_BINARY = {
    "XCTAssertEqual": ("==", None),
    "XCTAssertNotEqual": ("!=", None),
    "XCTAssertGreaterThan": (">", ("num", "str")),
    "XCTAssertGreaterThanOrEqual": (">=", ("num", "str")),
    "XCTAssertLessThan": ("<", ("num", "str")),
    "XCTAssertLessThanOrEqual": ("<=", ("num", "str")),
}

_RAW_STRING_START = re.compile(r'#+"')


def _blank(text: str) -> str:
    """Replace every non-newline character with a space."""
    return "".join(c if c == "\n" else " " for c in text)


def sanitize(src: str, keep_strings: bool = False) -> str:
    """Return `src` with comments and string contents blanked.

    Length and newline positions are preserved, so an offset into the result is
    an offset into `src`. With `keep_strings`, only comments are blanked: that
    view is what literal values are read from.
    """
    out: list[str] = []
    n = len(src)

    def lit(text: str) -> str:
        return text if keep_strings else _blank(text)

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
        out.append(lit(src[i : quote_at + len(opener)]))
        j = quote_at + len(opener)
        while j < n:
            if src.startswith(closer, j):
                out.append(lit(closer))
                return j + len(closer)
            if src.startswith(interp, j):
                out.append(lit(interp[:-1]))
                out.append("(")
                j = scan_code(j + len(interp), True)
                continue
            if hashes == 0 and src[j] == "\\" and j + 1 < n:
                out.append(lit(src[j : j + 2]))
                j += 2
                continue
            if not triple and src[j] == "\n":
                return j  # unterminated single-line string: resync at EOL
            out.append(lit(src[j]))
            j += 1
        return j

    scan_code(0, False)
    return "".join(out)


Const = tuple[str, object]  # (kind, value): kind is "bool" | "num" | "str" | "nil"


def _split_top_level(clean: str, start: int, end: int, sep: re.Pattern) -> list[tuple[int, int]]:
    """Split clean[start:end] at `sep` matches outside any bracket pair."""
    parts, depth, i, last = [], 0, start, start
    while i < end:
        c = clean[i]
        if c in "([{":
            depth += 1
        elif c in ")]}":
            depth -= 1
        elif depth == 0:
            m = sep.match(clean, i, end)
            if m:
                parts.append((last, i))
                last = i = m.end()
                continue
        i += 1
    parts.append((last, end))
    return parts


def _closing_paren(clean: str, open_at: int) -> int:
    """Index of the bracket closing clean[open_at], or -1 if unbalanced."""
    stack = []
    for i in range(open_at, len(clean)):
        c = clean[i]
        if c in _CLOSERS:
            stack.append(_CLOSERS[c])
        elif c in ")]}":
            if not stack or stack.pop() != c:
                return -1
            if not stack:
                return i
    return -1


class _Evaluator:
    """Decides the constant value of an argument expression, if it has one.

    Works on two aligned views of one file: `clean` (comments and string
    contents blanked, for structure) and `code` (comments blanked, strings kept,
    for literal values).
    """

    def __init__(self, clean: str, code: str) -> None:
        self.clean, self.code = clean, code
        self.constants = self._file_constants()

    def _file_constants(self) -> dict[str, Const]:
        """Names bound exactly once in the file, by `let NAME = <constant>`.

        A name declared anywhere else (another let/var, a parameter, a closure or
        loop variable, a pattern binding) is left unresolved: it may be shadowed.
        """
        clean = self.clean
        declared: dict[str, int] = {}
        for m in re.finditer(r"(?<![\w.])(?:let|var)\s+([A-Za-z_]\w*)", clean):
            declared[m.group(1)] = declared.get(m.group(1), 0) + 1
        found: dict[str, Const] = {}
        for m in re.finditer(
            r"(?<![\w.])let\s+([A-Za-z_]\w*)\s*(?::\s*[\w?]+\s*)?=([^\n;]*)", clean
        ):
            name = m.group(1)
            if declared[name] != 1 or _rebound(clean, name):
                continue
            value = self.evaluate(m.start(2), m.end(2), resolve=False)
            if value is not None:
                found[name] = value
        return found

    def evaluate(self, start: int, end: int, resolve: bool = True) -> Const | None:
        clean, code = self.clean, self.code
        # Trim on `code`: in `clean` a string literal is all blanks.
        while start < end and code[start].isspace():
            start += 1
        while end > start and code[end - 1].isspace():
            end -= 1
        if start == end:
            return None
        if clean[start] == "(" and _closing_paren(clean, start) == end - 1:
            return self.evaluate(start + 1, end - 1, resolve)

        sides = _split_top_level(clean, start, end, _COMPARISON)
        if len(sides) == 2:
            op = _COMPARISON.match(clean, sides[0][1]).group(0)
            left, right = self.evaluate(*sides[0], resolve), self.evaluate(*sides[1], resolve)
            result = _compare(op, left, right)
            return None if result is None else ("bool", result)
        if len(sides) > 2:
            return None

        text = code[start:end]
        if text in ("true", "false"):
            return ("bool", text == "true")
        if text == "nil":
            return ("nil", None)
        if _NUMBER.fullmatch(text):
            return ("num", float(text.replace("_", "")))
        string = _STRING.fullmatch(text)
        if string:
            # Swift compares strings by canonical equivalence.
            return ("str", unicodedata.normalize("NFC", string.group(1)))
        if text.startswith("!"):
            inner = self.evaluate(start + 1, end, resolve)
            return ("bool", not inner[1]) if inner and inner[0] == "bool" else None
        if resolve and _IDENT.fullmatch(text):
            return self.constants.get(text)
        return None


def _rebound(clean: str, name: str) -> bool:
    """True if `name` is also bound by a parameter or a closure/loop variable."""
    for m in re.finditer(rf"(?<![\w.]){name}\s*:", clean):
        if not re.search(r"(?<![\w.])(?:let|var)\s+$", clean[max(0, m.start() - 64) : m.start()]):
            return True  # a parameter (the `let NAME: Type` annotation is not)
    return re.search(rf"(?<![\w.]){name}\s*(?:,[^\n]*)?\bin\b", clean) is not None


def _compare(op: str, left: Const | None, right: Const | None) -> bool | None:
    """Value of `left op right` for two constants of one kind, else None."""
    if left is None or right is None or left[0] != right[0]:
        return None
    if op == "==":
        return left[1] == right[1]
    if op == "!=":
        return left[1] != right[1]
    if left[0] not in ("num", "str"):
        return None
    return _ORDER[op](left[1], right[1])


def _cannot_fail(name: str, args: list[Const | None], accuracy: bool) -> bool:
    first = args[0] if args else None
    if name in ("XCTAssert", "XCTAssertTrue"):
        return first == ("bool", True)
    if name == "XCTAssertFalse":
        return first == ("bool", False)
    if name == "XCTAssertNil":
        return first == ("nil", None)
    if name == "XCTAssertNotNil":
        return first is not None and first[0] != "nil"
    op, kinds = _BINARY[name]
    if accuracy:
        return False  # equality within a tolerance: not modelled
    if len(args) < 2 or (kinds and (first is None or first[0] not in kinds)):
        return False
    return _compare(op, first, args[1]) is True


def find_vacuous(src: str) -> list[tuple[int, str]]:
    """Return (1-based line of the assertion, description) for each ban hit."""
    clean = sanitize(src)
    ev = _Evaluator(clean, sanitize(src, keep_strings=True))
    found = []
    for m in ASSERTION.finditer(clean):
        close = _closing_paren(clean, m.end() - 1)
        if close == -1:
            continue
        spans = _split_top_level(clean, m.end(), close, re.compile(","))
        args = [ev.evaluate(a, b) for a, b in spans[:2]]
        accuracy = any(re.match(r"\s*accuracy\s*:", clean[a:b]) for a, b in spans[2:])
        if _cannot_fail(m.group(1), args, accuracy):
            line = clean.count("\n", 0, m.start()) + 1
            shown = " ".join(ev.code[m.start() : close + 1].split())
            found.append((line, shown))
    return found


def main() -> int:
    failures: list[str] = []
    for path in sorted(TESTS_DIR.rglob("*.swift")):
        src = path.read_text()
        for lineno, call in find_vacuous(src):
            failures.append(f"{path.relative_to(TESTS_DIR.parent)}:{lineno}: {call}")

    if failures:
        print(
            "vacuous assertion(s) that cannot fail found under apps/ios/Tests "
            "(issue #1888 bans assertions decided by a literal, a comparison of "
            "literals, or a constant, however the call is wrapped):",
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
