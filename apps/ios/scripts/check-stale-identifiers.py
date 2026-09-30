#!/usr/bin/env python3
"""Repository-wide check: every accessibility identifier an XCUITest looks up
must exist somewhere in the app's Sources.

Why this exists (issue #755): `BaseUITest.find(_:)` returns a valid, queryable
`XCUIElement` for *any* string — including an identifier that was deleted from
the app months ago. `element.waitForExistence(timeout:)` on that element just
returns `false`, indistinguishable from "not rendered yet". A test written as
`if el.waitForExistence(timeout: 5) { el.tap() } ` (no `else`/`XCTFail`)
degrades into something that can pass without ever exercising the behavior it
claims to cover. `find()` itself cannot "fail loudly" — it's constrained by
the XCTest API and used in hundreds of places that legitimately poll for an
element that hasn't rendered *yet*. This script is the static, loud-failing
equivalent: it inspects the identifier *strings* at rest, before any
simulator runs, and fails the build the moment a test references an
identifier the app source no longer defines anywhere.

Usage:
    python3 apps/ios/scripts/check-stale-identifiers.py

Exit code 0: every identifier referenced by a test resolves to a literal (or
             a matching dynamic pattern, e.g. "pin-\\(digit)") in Sources/, or
             is listed in stale-identifiers-baseline.txt (see below).
Exit code 1: a stale identifier was found that isn't in the baseline — i.e. a
             NEW regression, not a previously-known one; details on stderr.

Baseline (stale-identifiers-baseline.txt, next to this script): when this
check was introduced (#755) it found identifiers stale independently of the
device-key migration this issue covers (recovery/events/hubs/calls/settings
screens) — a real but separate cleanup, the same relationship the issue's
"Out of scope" section describes for the desktop probe sweeps (#681/#687/
#688/#689: same defect class, different suite, tracked separately). Those are
recorded in the baseline so this check can ship as a hard gate today without
blocking on unrelated pre-existing debt. The baseline should only ever
shrink: fixing one of its entries and leaving it in the baseline is harmless
(a stale baseline line that no longer reproduces is reported below, not
silently ignored), but referencing a *new* identifier not already in the
baseline fails the check immediately, exactly like any other stale reference.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

IOS_ROOT = Path(__file__).resolve().parents[1]  # apps/ios
SOURCES_DIR = IOS_ROOT / "Sources"
TESTS_DIR = IOS_ROOT / "Tests"
BASELINE_FILE = Path(__file__).resolve().parent / "stale-identifiers-baseline.txt"

STRING_LITERAL_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')

# Calls whose first argument is a single accessibility identifier literal.
# A test may name an identifier precisely to assert it is GONE — that is the
# opposite of a stale reference, and flagging it inverts the check's meaning.
# #1300 removes the device-link entry points from the pilot build, and the
# tests that prove it stays removed read:
#
#     XCTAssertFalse(find("link-device").exists, "Login must not offer linking")
#
# Without this, deleting a feature and asserting it stays deleted is
# unrepresentable: the assertion that guards the removal is itself reported as
# debt. Matched before the general scan and excluded from it.
ASSERTED_ABSENT_RE = re.compile(
    r'XCTAssertFalse\(\s*(?:find|app\.\w+)\(?\s*"([^"]+)"\s*\)?[^)]*?\.exists',
    re.DOTALL,
)

SCALAR_CALL_RE = re.compile(
    r'\b(?:find|waitForElement|scrollToFind|scrollToVisible|scrollAndTap)\(\s*'
    r'"((?:[^"\\]|\\.)*)"'
)
# Calls whose argument is an array literal of accessibility identifiers.
ARRAY_CALL_RE = re.compile(r"\banyElementExists\(\s*\[(?P<body>.*?)\]", re.DOTALL)

# Identifiers are hyphenated/underscored slugs with no whitespace. Filtering
# on that shape excludes prose (NSLocalizedString comments, log messages,
# URLs) from the Sources literal pool without needing full call-site parsing.
IDENTIFIER_SHAPE_RE = re.compile(r"^[A-Za-z0-9_.\\()-]+$")


def swift_files(directory: Path) -> list[Path]:
    return sorted(directory.rglob("*.swift"))


def strip_comments(text: str) -> str:
    """Blank out `//` and `/* */` comments, preserving line numbers and
    leaving string literals untouched (so a URL like "https://..." inside a
    string is not mistaken for a line comment). Swift `/* */` can nest;
    tracked via a depth counter. Good enough for this codebase — it doesn't
    need to be a full lexer, just not trip over comments or string quoting."""
    out = []
    i = 0
    n = len(text)
    in_string = False
    block_depth = 0
    while i < n:
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                in_string = False
            i += 1
            continue
        if block_depth > 0:
            if text[i : i + 2] == "/*":
                block_depth += 1
                out.append("  ")
                i += 2
                continue
            if text[i : i + 2] == "*/":
                block_depth -= 1
                out.append("  ")
                i += 2
                continue
            out.append("\n" if c == "\n" else " ")
            i += 1
            continue
        if text[i : i + 2] == "//":
            while i < n and text[i] != "\n":
                out.append(" ")
                i += 1
            continue
        if text[i : i + 2] == "/*":
            block_depth = 1
            out.append("  ")
            i += 2
            continue
        if c == '"':
            in_string = True
            out.append(c)
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


def normalize_interpolated(literal: str) -> str:
    """Collapse every \\(...\\) interpolation in `literal` into a single `<X>`
    placeholder, so "pin-\\(digit)" and "pin-\\(char)" — or a test literal
    "pin-3" against a source pattern "pin-\\(digit)" — can be compared."""
    out: list[str] = []
    i = 0
    n = len(literal)
    while i < n:
        if literal[i] == "\\" and i + 1 < n and literal[i + 1] == "(":
            depth = 1
            i += 2
            while i < n and depth > 0:
                if literal[i] == "(":
                    depth += 1
                elif literal[i] == ")":
                    depth -= 1
                i += 1
            out.append("<X>")
            continue
        out.append(literal[i])
        i += 1
    return "".join(out)


def pattern_from_skeleton(skeleton: str) -> re.Pattern[str]:
    parts = re.split(r"(<X>)", skeleton)
    return re.compile(
        "^" + "".join(".*" if p == "<X>" else re.escape(p) for p in parts) + "$"
    )


def has_literal_anchor(skeleton: str) -> bool:
    """A skeleton like "pin-<X>" anchors on real text ("pin-") and is a
    meaningful identifier pattern. A skeleton that is *only* "<X>" (e.g. from
    `Text("\\(count)")`, pure interpolated display text with no static part)
    would collapse to the regex ^.*$ and silently swallow every identifier —
    that bug previously made this checker a no-op. Reject those."""
    return skeleton.replace("<X>", "") != ""


def collect_source_identifiers() -> tuple[set[str], list[re.Pattern[str]]]:
    """Every string literal in Sources/ that looks like an identifier slug.
    Returns (exact static literals, regexes for interpolated/dynamic ones)."""
    exact: set[str] = set()
    patterns: list[re.Pattern[str]] = []
    for f in swift_files(SOURCES_DIR):
        text = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
        for m in STRING_LITERAL_RE.finditer(text):
            lit = m.group(1)
            if not lit or " " in lit or not IDENTIFIER_SHAPE_RE.match(lit):
                continue
            if "\\(" in lit:
                skeleton = normalize_interpolated(lit)
                if has_literal_anchor(skeleton):
                    patterns.append(pattern_from_skeleton(skeleton))
            else:
                exact.add(lit)
    return exact, patterns


def collect_test_references() -> dict[str, list[str]]:
    """Map identifier literal -> list of "file:line" sites referencing it."""
    refs: dict[str, list[str]] = {}

    def record(identifier: str, site: str) -> None:
        refs.setdefault(identifier, []).append(site)

    for f in swift_files(TESTS_DIR):
        # Helper bodies (e.g. BaseUITest.completeOnboarding()) are scanned
        # like any other file — they can go stale exactly like test bodies.
        # Only the accessor functions' own parameter names (`find(identifier)`)
        # are naturally excluded, because those aren't quoted literals.
        text = strip_comments(f.read_text(encoding="utf-8", errors="replace"))
        rel = f.relative_to(IOS_ROOT)

        # Spans asserting an identifier is absent, so the scan below can skip
        # them: the identifier being undefined in Sources/ is what the test is
        # there to prove.
        absent_spans = [(m.start(), m.end()) for m in ASSERTED_ABSENT_RE.finditer(text)]

        def asserted_absent(pos: int) -> bool:
            return any(start <= pos < end for start, end in absent_spans)

        for m in SCALAR_CALL_RE.finditer(text):
            if asserted_absent(m.start()):
                continue
            line_no = text.count("\n", 0, m.start()) + 1
            record(m.group(1), f"{rel}:{line_no}")

        for m in ARRAY_CALL_RE.finditer(text):
            line_no = text.count("\n", 0, m.start()) + 1
            for lit_m in STRING_LITERAL_RE.finditer(m.group("body")):
                record(lit_m.group(1), f"{rel}:{line_no}")

    return refs


def identifier_exists(identifier: str, exact: set[str], patterns: list[re.Pattern[str]]) -> bool:
    if "\\(" in identifier:
        skeleton = normalize_interpolated(identifier)
        if not has_literal_anchor(skeleton):
            # A test identifier that is *itself* purely dynamic with no
            # static anchor (e.g. find("\\(x)")) can't be statically verified
            # either way — don't false-flag it as stale.
            return True
        target = pattern_from_skeleton(skeleton).pattern
        return any(p.pattern == target for p in patterns)
    if identifier in exact:
        return True
    return any(p.fullmatch(identifier) for p in patterns)


def load_baseline() -> set[str]:
    if not BASELINE_FILE.is_file():
        return set()
    entries = set()
    for line in BASELINE_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        entries.add(line)
    return entries


def main() -> int:
    if not SOURCES_DIR.is_dir() or not TESTS_DIR.is_dir():
        print(f"ERROR: expected {SOURCES_DIR} and {TESTS_DIR} to exist", file=sys.stderr)
        return 1

    exact, patterns = collect_source_identifiers()
    refs = collect_test_references()
    baseline = load_baseline()

    stale: dict[str, list[str]] = {}
    for identifier, sites in sorted(refs.items()):
        if not identifier_exists(identifier, exact, patterns):
            stale[identifier] = sites

    new_stale = {k: v for k, v in stale.items() if k not in baseline}
    known_stale = {k: v for k, v in stale.items() if k in baseline}
    resolved_baseline_entries = sorted(baseline - set(stale))

    if resolved_baseline_entries:
        print(
            "NOTE: these baseline entries no longer reproduce — please remove "
            f"them from {BASELINE_FILE.name}:",
        )
        for identifier in resolved_baseline_entries:
            print(f'  "{identifier}"')

    if new_stale:
        print(
            "STALE ACCESSIBILITY IDENTIFIERS — referenced by tests, "
            "not defined anywhere in Sources/, and not in the baseline:",
            file=sys.stderr,
        )
        for identifier, sites in new_stale.items():
            print(f'  "{identifier}"', file=sys.stderr)
            for site in sites:
                print(f"      {site}", file=sys.stderr)
        print(
            f"\n{len(new_stale)} new stale identifier(s) across "
            f"{sum(len(v) for v in new_stale.values())} call site(s). "
            f"({len(known_stale)} additional known/baselined stale identifier(s) "
            "not shown as failures — see stale-identifiers-baseline.txt.)",
            file=sys.stderr,
        )
        return 1

    if known_stale:
        print(
            f"OK: no NEW stale identifiers. {len(known_stale)} pre-existing "
            "baselined stale identifier(s) remain (see "
            "stale-identifiers-baseline.txt) — unrelated to this check's "
            "introduction, tracked separately:"
        )
        for identifier, sites in known_stale.items():
            print(f'  "{identifier}"')
            for site in sites:
                print(f"      {site}")
        return 0

    print(
        f"OK: {len(refs)} distinct accessibility identifiers referenced by "
        f"tests all resolve to Sources/."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
