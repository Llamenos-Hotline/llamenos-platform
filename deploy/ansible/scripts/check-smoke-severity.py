#!/usr/bin/env python3
"""Every smoke check must declare whether its failure stops the deploy.

Why this gate exists
--------------------
Before issue #1636 the smoke suite had three behaviours and named one of them:

  * fatal     — the summary's `fail` task stopped the deploy;
  * advisory  — nothing; the concept did not exist;
  * neither   — the Kamailio probe, which reported NOT READY from inside
                roles/kamailio and let the deploy succeed without comment.

That third state is the defect. An operator reading "Smoke check FAILED"
reasonably expects the deploy to have stopped, and for one of the checks it had
not. So the fix was not only to decide which failures are fatal but to make the
decision *per check and visible*, instead of an emergent property of whichever
task happened to carry a `failed_when`.

This script keeps it that way. `tasks/record-smoke-result.yml` defaults an
undeclared severity to **fatal**, so a forgotten declaration is too strict
rather than silently advisory — but "too strict" is still a surprise, and a
silent default is how the policy drifts back out of the playbook. Every call
site therefore has to say which it is, in the file a reader is already looking
at.

It is a text check on purpose: it runs in milliseconds with no Ansible, no
sockets and no target host, so it can gate every PR. The behavioural
counterparts are `playbooks/check-record-smoke-result.yml` (the recorder's
defaulting, in CI) and `scripts/check-smoke-verdicts.py` (the whole suite
against real listeners, by hand).

Verify it by breaking it: delete any `smoke_check_severity:` line from
playbooks/smoke-check.yml and this script must exit non-zero naming that check.

Usage:
    python3 deploy/ansible/scripts/check-smoke-severity.py
    python3 deploy/ansible/scripts/check-smoke-severity.py --list
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent.parent

# Playbooks whose checks feed a smoke_results summary. A new one belongs here.
PLAYBOOKS = ("playbooks/smoke-check.yml",)

VALID = ("fatal", "advisory")

NAME = re.compile(r"^\s*smoke_check_name:\s*(.+?)\s*$")
SEVERITY = re.compile(r"^\s*smoke_check_severity:\s*(\S+)\s*$")
# A `vars:` block ends at the next task or at `tags:`; the declaration has to
# live inside the same block as the name it applies to.
BLOCK_END = re.compile(r"^\s*(tags:|- name:)")


def declarations(path: Path) -> list[tuple[int, str, str | None]]:
    """(line number, check name, declared severity or None) per call site."""
    lines = path.read_text().split("\n")
    found: list[tuple[int, str, str | None]] = []
    for i, line in enumerate(lines):
        m = NAME.match(line)
        if not m:
            continue
        name = m.group(1).strip("\"'")
        sev: str | None = None
        # Look backwards to the start of this vars block, then forwards to its
        # end, so the declaration may sit on either side of the name.
        for j in range(i - 1, max(i - 12, -1), -1):
            if BLOCK_END.match(lines[j]):
                break
            got = SEVERITY.match(lines[j])
            if got:
                sev = got.group(1)
                break
        if sev is None:
            for j in range(i + 1, min(i + 12, len(lines))):
                if BLOCK_END.match(lines[j]):
                    break
                got = SEVERITY.match(lines[j])
                if got:
                    sev = got.group(1)
                    break
        found.append((i + 1, name, sev))
    return found


def main() -> int:
    want_list = "--list" in sys.argv[1:]
    problems: list[str] = []
    total = 0

    for rel in PLAYBOOKS:
        path = ANSIBLE_DIR / rel
        if not path.exists():
            problems.append(f"{rel}: not found")
            continue
        found = declarations(path)
        if not found:
            problems.append(f"{rel}: no smoke checks found at all — has the "
                            f"recorder's call shape changed?")
        for lineno, name, sev in found:
            total += 1
            if want_list:
                print(f"{sev or '(UNDECLARED)':<12} {name}")
            if sev is None:
                problems.append(
                    f"{rel}:{lineno}: check {name!r} declares no "
                    f"smoke_check_severity. Add `smoke_check_severity: fatal` "
                    f"or `advisory` — see the ruling in the playbook header. "
                    f"Fatal is the default at runtime, so this is not a "
                    f"silent weakening, but the policy has to be readable in "
                    f"the file to stay the policy.")
            elif sev not in VALID:
                problems.append(
                    f"{rel}:{lineno}: check {name!r} declares severity "
                    f"{sev!r}, which is not one of {VALID}. The recorder "
                    f"treats anything unrecognised as fatal, so this check is "
                    f"not weakened — but it is not saying what it means.")

    if problems:
        for p in problems:
            print(f"ERROR: {p}", file=sys.stderr)
        print(f"\n{len(problems)} smoke check(s) do not declare a usable "
              f"severity.", file=sys.stderr)
        return 1
    print(f"OK: all {total} smoke checks declare a severity (fatal or advisory).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
