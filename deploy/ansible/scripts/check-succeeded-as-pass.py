#!/usr/bin/env python3
"""Reject Ansible result tests that read a SKIPPED task as a passing one.

Why this gate exists
--------------------
Ansible's `succeeded` test is defined as exactly `not failed`. A task that was
SKIPPED never ran, so it never failed, so it is `succeeded`. Measured, not
reasoned about — a skipped task's registered result is::

    {changed: false, skipped: true, skip_reason: "Conditional result was False"}

and `result is succeeded` on that returns **true**, while it carries no `rc`
and no `status` key at all.

So this, which appeared 21 times in `playbooks/smoke-check.yml` alone plus
four more times across preflight, security-update and the kamailio role::

    'PASS' if probe is succeeded else 'FAIL'

records **PASS** for a probe that took no measurement whatsoever (issue #1617).
The confirmed instance was the HSTS assert, which skips whenever the header
probe it reads did not succeed: the suite reported "HSTS header present"
precisely when nothing had looked for HSTS.

Nothing in CI could see it. `ansible-playbook --syntax-check` parses YAML and
task structure; `ansible-lint` lints task shape; neither evaluates a Jinja
expression's meaning, and the expression is valid Jinja naming a real test.
The bug was additionally masked by the dead `startswith` test in the same
file's summary (issue #1602 finding 4, fixed in #1615), which aborted the play
before any verdict was rendered — so the gate crashed instead of lying, and a
crash gets investigated.

The two rules
-------------
1. **`succeeded` / `success` / `successful` are banned outright.** They are
   aliases of `not failed` wearing a name that reads as "passed". There is no
   use for which `is not skipped and is not failed` is not clearer, and in a
   check the right-hand side should usually be the measurement itself (a status
   code, a header value, an exit status) rather than the task's self-report.

2. **`is not failed` / `is not failure` must be preceded, in the same
   expression, by a skip test on the same variable.** Negating `failed` is the
   same claim `succeeded` makes, so it needs the same guard.

   *Preceded*, not merely accompanied. Jinja evaluates a conditional chain left
   to right, so::

       {{ 'HEALTHY' if (h is not failed) else 'NOT CHECKED' if h is skipped }}

   mentions the skip test and is still broken: a skipped probe satisfies the
   FIRST branch and the skip branch is dead. This was caught by injecting it —
   an earlier version of this script, which only asked whether a skip test
   appeared somewhere in the expression, passed it.

Both rules are same-expression, position-aware checks, so there is no scope
analysis to get wrong, and there is no allowlist — an allowlist is the hole a
rail like this dies of. The cost of compliance is two words.

Scope note: this overlaps `check-jinja-tests.py` (added in #1615) only in
spirit. That one rejects Jinja filters naming a test that does **not exist**;
this one rejects a test that exists, resolves, and answers a different question
from the one the author asked. Neither subsumes the other.

Comments are not scanned: `.yml` files are read through the YAML parser, so
only real scalar values are examined. That matters because the playbooks
document this trap at length, quoting the banned form.

Verified by injection, per the repo rule that a gate nobody has seen fire is
not a control: reintroduce `is succeeded` into any playbook and this script
must exit non-zero and name the line.

Usage:
    python3 deploy/ansible/scripts/check-succeeded-as-pass.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

ANSIBLE_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = ANSIBLE_DIR.parent.parent

YAML_SUFFIXES = (".yml", ".yaml")
TEMPLATE_SUFFIXES = (".j2",)

# A Jinja/Ansible result test: `<var> is [not] <test>`. The variable may be a
# dotted or indexed path (`result.results[0]`), and arbitrary whitespace is
# allowed around `is`/`not` because folded YAML scalars wrap mid-expression.
TEST_RE = re.compile(
    r"(?P<var>[A-Za-z_][A-Za-z0-9_]*(?:(?:\.[A-Za-z_][A-Za-z0-9_]*)|(?:\[[^\]]*\]))*)"
    r"\s+is\s+(?:(?P<negated>not)\s+)?(?P<test>[a-z_]+)\b"
)

# Rule 1: banned whatever they are paired with.
BANNED_TESTS = {"succeeded", "success", "successful"}
# Rule 2: allowed, but only alongside a skip test on the same variable.
NEEDS_SKIP_GUARD = {"failed", "failure"}
SKIP_TESTS = {"skipped", "skip"}

# Verdict words that make an expression a pass-RECORDING rather than a plain
# conditional. Only used to sharpen the error message.
VERDICT_HINTS = ("PASS", "OK", "HEALTHY", "SUCCEED", "GREEN", "READY")


def base_var(path: str) -> str:
    """`caddy_headers.strict_transport_security` -> `caddy_headers`."""
    return re.split(r"[.\[]", path, maxsplit=1)[0]


def first_skip_test_offset(text: str, var: str) -> int | None:
    """Offset of the earliest skip test on `var` in `text`, if any."""
    offsets = [
        m.start()
        for m in TEST_RE.finditer(text)
        if m.group("test") in SKIP_TESTS and base_var(m.group("var")) == var
    ]
    return min(offsets) if offsets else None


def check_expression(text: str) -> list[tuple[str, str, str]]:
    """Findings in one expression: (variable, test as written, why)."""
    out: list[tuple[str, str, str]] = []
    for m in TEST_RE.finditer(text):
        test = m.group("test")
        var = m.group("var")
        written = f"{var} is {'not ' if m.group('negated') else ''}{test}"
        if test in BANNED_TESTS:
            out.append((var, written, f"`{test}` is an alias of `not failed`: a SKIPPED task passes it"))
        elif test in NEEDS_SKIP_GUARD and m.group("negated"):
            guard = first_skip_test_offset(text, base_var(var))
            if guard is None:
                out.append((var, written, f"`not {test}` is true for a task that never ran, and `{base_var(var)}` is never tested for skippedness here"))
            elif guard > m.start():
                # Jinja evaluates a conditional chain left to right, so a skip
                # test that comes AFTER this one sits in a branch a skipped
                # task can never reach.
                out.append((var, written, f"`{base_var(var)} is skipped` is tested only AFTER this, in a branch a skipped task never reaches — move the skip test first"))
    return out


def walk_scalars(node: yaml.Node):
    """Every scalar in a composed YAML document, with its 1-based line."""
    if isinstance(node, yaml.ScalarNode):
        yield node.start_mark.line + 1, node.value
    elif isinstance(node, yaml.SequenceNode):
        for child in node.value:
            yield from walk_scalars(child)
    elif isinstance(node, yaml.MappingNode):
        for key, value in node.value:
            yield from walk_scalars(key)
            yield from walk_scalars(value)


def scan_yaml(path: Path) -> list[tuple[int, str, str, str]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    try:
        docs = list(yaml.compose_all(text))
    except yaml.YAMLError as exc:
        sys.exit(f"ERROR: {path.relative_to(REPO_ROOT)} is not parseable YAML: {exc}")
    found: list[tuple[int, str, str, str]] = []
    for doc in docs:
        if doc is None:
            continue
        for line, value in walk_scalars(doc):
            if not isinstance(value, str):
                continue
            for var, written, why in check_expression(value):
                found.append((line, var, written, why + verdict_note(value)))
    return found


def scan_template(path: Path) -> list[tuple[int, str, str, str]]:
    """Templates are not YAML; scan line by line and skip commented lines."""
    found: list[tuple[int, str, str, str]] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        code = line.split("#", 1)[0]
        for var, written, why in check_expression(code):
            found.append((lineno, var, written, why + verdict_note(code)))
    return found


def verdict_note(text: str) -> str:
    upper = text.upper()
    if any(h in upper for h in VERDICT_HINTS):
        return " — and this expression records a verdict, so a skip is reported as healthy"
    return ""


def main() -> int:
    findings: list[tuple[Path, int, str, str, str]] = []
    scanned = 0
    for path in sorted(ANSIBLE_DIR.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix in YAML_SUFFIXES:
            scanner = scan_yaml
        elif path.suffix in TEMPLATE_SUFFIXES:
            scanner = scan_template
        else:
            continue
        scanned += 1
        for line, var, written, why in scanner(path):
            findings.append((path, line, var, written, why))

    if not findings:
        print(f"OK: no result test reads a skipped task as a pass ({scanned} files scanned).")
        return 0

    print("FAIL: result test(s) that score a SKIPPED task as a passing one.\n")
    for path, line, _var, written, why in findings:
        print(f"  {path.relative_to(REPO_ROOT)}:{line}: `{written}`")
        print(f"      {why}")
    print(
        "\nAnsible's `succeeded` test means exactly `not failed`, and a task that was\n"
        "SKIPPED never ran, so it never failed. A probe that took no measurement at\n"
        "all therefore scores as healthy — issue #1617, 27 instances.\n"
        "\n"
        "Write the MEASUREMENT the check is actually for, guarded so an absent one\n"
        "cannot read as a good one:\n"
        "    smoke_check_pass: \"{{ probe.status | default(0) | int == 200 }}\"\n"
        "\n"
        "Where the probe's only claim really is \"this ran clean\", pair the tests:\n"
        "    {{ 'PASS' if (probe is not skipped and probe is not failed) else 'FAIL' }}\n"
        "\n"
        "A check that is legitimately conditional records SKIPPED as its own state —\n"
        "see playbooks/tasks/record-smoke-result.yml. There is no allowlist here on\n"
        "purpose: the compliant form is never worse than the banned one."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
