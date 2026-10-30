"""Break-it tests for check-vacuous-assertions.py (#1888, #2044 review).

    python3 -m unittest discover -s apps/ios/scripts -p "test_*.py"

The gate exists to catch assertions that cannot fail, so these tests pin that it
cannot itself be evaded by wrapping, and does not flag assertions that can fail.
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "check_vacuous", Path(__file__).with_name("check-vacuous-assertions.py")
)
assert _spec is not None and _spec.loader is not None
gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate)


def lines_hit(src: str) -> list[int]:
    return [line for line, _ in gate.find_vacuous(src)]


class OriginallyBannedForms(unittest.TestCase):
    def test_single_line_forms_are_caught(self):
        for call in (
            "XCTAssertTrue(true)",
            "XCTAssertFalse(false)",
            "XCTAssert(true)",
            'XCTAssertTrue(true, "reached")',
            "XCTAssertTrue( true )",
            "XCTAssertTrue (true)",
            "XCTest.XCTAssertTrue(true)",
        ):
            with self.subTest(call=call):
                self.assertEqual(lines_hit(f"func t() {{\n    {call}\n}}\n"), [2])


class WrappedFormsAreCaught(unittest.TestCase):
    def test_literal_on_next_line(self):
        self.assertEqual(lines_hit("XCTAssertTrue(\n    true\n)\n"), [1])

    def test_argument_split_mid_expression(self):
        self.assertEqual(lines_hit("XCTAssertFalse(\n\n    false,\n    \"msg\"\n)\n"), [1])
        self.assertEqual(lines_hit("XCTAssert\n(\ntrue\n)\n"), [1])

    def test_trailing_and_interleaved_comments(self):
        self.assertEqual(lines_hit("XCTAssertTrue( // always passes\n    true\n)\n"), [1])
        self.assertEqual(lines_hit("XCTAssertTrue(/* why */ true /* because */)\n"), [1])
        self.assertEqual(lines_hit("XCTAssertTrue(\n    /* a /* nested */ b */\n    true // c\n)\n"), [1])

    def test_redundant_parentheses(self):
        self.assertEqual(lines_hit("XCTAssertTrue((true))\n"), [1])
        self.assertEqual(lines_hit("XCTAssertFalse(\n  (\n   false\n  )\n)\n"), [1])

    def test_line_numbers_point_at_the_assertion(self):
        src = "a()\n\nb()\nXCTAssertTrue(\n    true\n)\n"
        self.assertEqual(lines_hit(src), [4])

    def test_after_a_string_containing_comment_markers(self):
        # A `//` inside a string must not be mistaken for a comment that
        # swallows the rest of the line (and the real call after it).
        self.assertEqual(lines_hit('let u = "http://x"; XCTAssertTrue(\n true)\n'), [1])


class LegitimateAssertionsAreNotFlagged(unittest.TestCase):
    def test_falsifiable_multiline_assertions(self):
        for src in (
            "XCTAssertTrue(\n    element.exists,\n    \"should exist\"\n)\n",
            "XCTAssertTrue(\n    true && ready\n)\n",
            "XCTAssertTrue(\n    trueValue\n)\n",
            "XCTAssertFalse(true)\n",
            "XCTAssertTrue(false)\n",
            "XCTAssertEqual(\n    count,\n    true\n)\n",
            "XCTAssertTrue(\n    items.contains(true)\n)\n",
            "XCTAssertTrue(isTrue(true))\n",
            "MyXCTAssertTrue(true)\n",
        ):
            with self.subTest(src=src):
                self.assertEqual(lines_hit(src), [])

    def test_mentions_in_comments_and_strings_are_not_code(self):
        for src in (
            "// XCTAssertTrue(true) is banned\n",
            "/* XCTAssertTrue(\n true) */\n",
            "/// XCTAssertFalse(false)\n",
            'let s = "XCTAssertTrue(true)"\n',
            'let s = """\nXCTAssertTrue(\n  true)\n"""\n',
            'let s = #"XCTAssertTrue(true) \\#(x)"#\n',
            'let s = "\\(x) XCTAssertTrue(true)"\n',
        ):
            with self.subTest(src=src):
                self.assertEqual(lines_hit(src), [])

    def test_code_inside_string_interpolation_is_still_code(self):
        self.assertEqual(lines_hit('let s = "\\(foo(XCTAssertTrue(true)))"\n'), [1])


class ComparisonsOfLiteralsAreCaught(unittest.TestCase):
    def test_assertions_decided_by_two_literals(self):
        for call in (
            "XCTAssertTrue(1 == 1)",
            "XCTAssertTrue(2 > 1)",
            "XCTAssertFalse(1 == 2)",
            'XCTAssertTrue("a" != "b")',
            "XCTAssert((3) >= 3)",
            "XCTAssertTrue(!false)",
            "XCTAssertEqual(1, 1)",
            "XCTAssertEqual(1, 1.0)",
            'XCTAssertEqual("ready", "ready", "message")',
            "XCTAssertEqual(true, true)",
            "XCTAssertNotEqual(1, 2)",
            'XCTAssertNotEqual("a", "b")',
            "XCTAssertGreaterThan(2, 1)",
            "XCTAssertGreaterThanOrEqual(1_000, 1000)",
            "XCTAssertLessThan(-1, 0)",
            "XCTAssertLessThanOrEqual(0.5, 0.5)",
            "XCTAssertNil(nil)",
            "XCTAssertNotNil(0)",
            'XCTAssertNotNil("x")',
        ):
            with self.subTest(call=call):
                self.assertEqual(lines_hit(f"func t() {{\n    {call}\n}}\n"), [2])

    def test_wrapped_comparison_with_comments(self):
        src = 'XCTAssertEqual(\n    "a", // left\n    /* right */ "a",\n    "msg"\n)\n'
        self.assertEqual(lines_hit(src), [1])

    def test_assertions_that_always_fail_are_not_vacuous(self):
        # They can never pass, so a run shows them; this gate is for the silent kind.
        for call in (
            "XCTAssertTrue(1 == 2)",
            "XCTAssertEqual(1, 2)",
            'XCTAssertEqual("a", "b")',
            "XCTAssertNotEqual(1, 1)",
            "XCTAssertGreaterThan(1, 2)",
            "XCTAssertNil(0)",
            "XCTAssertNotNil(nil)",
        ):
            with self.subTest(call=call):
                self.assertEqual(lines_hit(call + "\n"), [])

    def test_falsifiable_comparisons_are_not_flagged(self):
        for call in (
            "XCTAssertEqual(count, 1)",
            "XCTAssertEqual(1, count)",
            "XCTAssertTrue(1 == count)",
            'XCTAssertEqual("".truncatedNpub(), "")',
            'XCTAssertEqual("\\(x)", "1")',
            'XCTAssertNotEqual("a\\n", "b")',
            "XCTAssertEqual(1.0, 1.0 + x)",
            "XCTAssertNotEqual(1.0, 1.1, accuracy: 0.5)",
            "XCTAssertTrue(a < b && 1 < 2)",
            "XCTAssertEqual(Set<Int>(), [])",
            "XCTAssertNil(value)",
            "XCTAssertNotNil(element.value)",
            "XCTAssertEqual(f(1, 1), 2)",
        ):
            with self.subTest(call=call):
                self.assertEqual(lines_hit(call + "\n"), [])


class AssertionsOnConstantsAreCaught(unittest.TestCase):
    def test_a_name_bound_once_to_a_literal(self):
        src = "let alwaysOn = true\nfunc t() {\n    XCTAssertTrue(alwaysOn)\n}\n"
        self.assertEqual(lines_hit(src), [3])
        src = "let expected: Int = 3\nfunc t() {\n    XCTAssertEqual(expected, 3)\n}\n"
        self.assertEqual(lines_hit(src), [3])
        src = 'private let name = "x"\nfunc t() {\n    XCTAssertNotNil(name)\n}\n'
        self.assertEqual(lines_hit(src), [3])

    def test_a_name_that_may_be_rebound_is_not_resolved(self):
        for src in (
            "let ok = true\nfunc t() {\n    var ok = check()\n    XCTAssertTrue(ok)\n}\n",
            "let ok = true\nfunc t(ok: Bool) {\n    XCTAssertTrue(ok)\n}\n",
            "let ok = true\nfunc t() {\n    items.forEach { ok in XCTAssertTrue(ok) }\n}\n",
            "let ok = true\nfunc t() {\n    for ok in flags { XCTAssertTrue(ok) }\n}\n",
            "let ok = true\nfunc t() {\n    if let ok = maybe { XCTAssertTrue(ok) }\n}\n",
            "let ok = check()\nfunc t() {\n    XCTAssertTrue(ok)\n}\n",
            "let ok = false\nfunc t() {\n    XCTAssertTrue(ok)\n}\n",
        ):
            with self.subTest(src=src):
                self.assertEqual(lines_hit(src), [])


class Sanitizer(unittest.TestCase):
    def test_preserves_length_and_newlines(self):
        src = 'a // c\n/* x\ny */ "s\\(1)t"\n"""\nm\n"""\n'
        clean = gate.sanitize(src)
        self.assertEqual(len(clean), len(src))
        self.assertEqual([i for i, c in enumerate(src) if c == "\n"],
                         [i for i, c in enumerate(clean) if c == "\n"])


if __name__ == "__main__":
    unittest.main()
