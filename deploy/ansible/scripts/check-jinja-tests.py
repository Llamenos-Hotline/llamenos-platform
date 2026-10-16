#!/usr/bin/env python3
"""Reject Jinja `select`/`reject`/`selectattr`/`rejectattr` calls that name a
test which does not exist.

Why this gate exists
--------------------
`selectattr('status', 'startswith', 'FAIL')` reads like Python but is not: the
second argument of `selectattr` is a *Jinja test name*, and neither Jinja nor
Ansible defines a test called `startswith`. At runtime it raises
"No test named 'startswith'"; until then it is invisible, because the two
checks that run in CI never evaluate Jinja:

  * `ansible-playbook --syntax-check` parses YAML and task structure only;
  * `ansible-lint` lints task/role shape, not template semantics.

Issue #1602 found four such calls in `playbooks/smoke-check.yml`, three of them
in the deploy's own pass/fail gate. The summary task raised before the gate
task was reached, so the gate — "fail the deploy if any smoke check failed" —
could never evaluate, in either direction, on any host. A gate that cannot fire
is worse than no gate, and nothing in CI noticed for as long as it existed.

Pair it with the repo rule: a gate is verified by injecting the defect it
claims to catch. Re-introduce `startswith` into any playbook and this script
must exit non-zero.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent.parent
SCAN_SUFFIXES = (".yml", ".yaml", ".j2")

# `selectattr('attr', 'test', ...)` / `rejectattr('attr', 'test', ...)`
ATTR_CALL = re.compile(
    r"\b(selectattr|rejectattr)\(\s*(['\"])(?:(?!\2).)*\2\s*,\s*(['\"])([A-Za-z_][A-Za-z0-9_]*)\3"
)
# `select('test', ...)` / `reject('test', ...)`
PLAIN_CALL = re.compile(r"(?<![a-zA-Z_.])(select|reject)\(\s*(['\"])([A-Za-z_][A-Za-z0-9_]*)\2")

# Jinja2's own built-in tests. Kept here rather than imported so the script
# runs wherever `ansible-doc` does, without needing jinja2 importable.
JINJA_BUILTIN_TESTS = {
    "boolean", "callable", "defined", "divisibleby", "eq", "equalto", "escaped",
    "even", "false", "filter", "float", "ge", "greaterthan", "gt", "in",
    "integer", "iterable", "le", "lessthan", "lower", "lt", "mapping", "ne",
    "none", "number", "odd", "sameas", "sequence", "string", "test", "true",
    "undefined", "upper",
}


def ansible_test_names() -> set[str]:
    """Every test Ansible exposes, by short and fully-qualified name."""
    try:
        out = subprocess.run(
            ["ansible-doc", "-t", "test", "-l", "--json"],
            capture_output=True, text=True, check=True, timeout=180,
        ).stdout
    except (OSError, subprocess.SubprocessError) as exc:
        sys.exit(f"ERROR: could not enumerate Ansible tests via ansible-doc: {exc}")

    names: set[str] = set()
    for fqcn in json.loads(out):
        names.add(fqcn)
        names.add(fqcn.rsplit(".", 1)[-1])
    return names


def scan(known: set[str]) -> list[tuple[Path, int, str, str]]:
    bad: list[tuple[Path, int, str, str]] = []
    for path in sorted(ANSIBLE_DIR.rglob("*")):
        if not path.is_file() or path.suffix not in SCAN_SUFFIXES:
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for match in ATTR_CALL.finditer(line):
                if match.group(4) not in known:
                    bad.append((path, lineno, match.group(1), match.group(4)))
            for match in PLAIN_CALL.finditer(line):
                if match.group(3) not in known:
                    bad.append((path, lineno, match.group(1), match.group(3)))
    return bad


def main() -> int:
    known = ansible_test_names() | JINJA_BUILTIN_TESTS
    bad = scan(known)
    if not bad:
        print(f"OK: every select/reject test name resolves ({len(known)} known tests).")
        return 0

    print("FAIL: Jinja filter(s) name a test that does not exist.\n")
    for path, lineno, call, name in bad:
        print(f"  {path.relative_to(ANSIBLE_DIR.parent.parent)}:{lineno}: {call}(..., '{name}', ...)")
    print(
        "\nThe second argument of selectattr/rejectattr (first of select/reject) is a\n"
        "Jinja TEST NAME, not a Python method. For a prefix comparison use the\n"
        "`match` test (anchored at the start) or `search` (anywhere):\n"
        "    selectattr('status', 'match', 'FAIL')\n"
        "This raises at runtime only; --syntax-check and ansible-lint do not\n"
        "evaluate Jinja, which is why issue #1602's dead deploy gate survived CI."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
