#!/usr/bin/env python3
"""Require every task file that declares a cron job to install cron first.

Why this gate exists
--------------------
``ansible.builtin.cron`` shells out to ``crontab``. A minimal Debian image
(a cloud image, a bare VPS) does not ship the ``cron`` package, and nothing in
this repo installed it, so the first cron task on a host built from one died with
``Failed to find required executable "crontab"``. Ten tasks across six
roles/playbooks wrote cron jobs; none of them said where cron came from.

``--syntax-check`` and ``ansible-lint`` cannot see a missing runtime dependency,
and a host built from the FDE ISO usually has cron (a standard Debian install
includes it), so the failure only appears on the next kind of host. This makes
the dependency a property of the file: every file that uses
``ansible.builtin.cron`` must include the ``cron`` role (roles/cron) BEFORE its
first cron task.

There is no allowlist.
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
CRON_TASK = re.compile(r"^\s*ansible\.builtin\.cron\s*:")
CRON_ROLE = re.compile(
    r"(?:^\s*(?:ansible\.builtin\.)?(?:include|import)_role\s*:\s*$)"
    r"|(?:^\s*-\s*role\s*:\s*cron\s*$)"
)


def candidates() -> list[pathlib.Path]:
    files = sorted(ROOT.glob("roles/*/tasks/**/*.yml")) + sorted(ROOT.glob("playbooks/*.yml"))
    # roles/cron is the installer itself; roles/llamenos is the legacy demo role.
    return [f for f in files if f.relative_to(ROOT).parts[:2] != ("roles", "cron")]


def installs_cron_before(lines: list[str], limit: int) -> bool:
    for i in range(limit):
        if CRON_ROLE.search(lines[i]):
            # `include_role:` / `import_role:` — its `name:` is on a following line.
            if re.search(r"role\s*:\s*cron\s*$", lines[i]):
                return True
            for j in range(i + 1, min(i + 4, limit)):
                if re.match(r"^\s*name\s*:\s*cron\s*$", lines[j]):
                    return True
    return False


def main() -> int:
    files = candidates()
    if len(files) < 30:
        print(f"::error::found only {len(files)} task files under {ROOT}; the glob is wrong", file=sys.stderr)
        return 2
    failures: list[str] = []
    users = 0
    for path in files:
        lines = path.read_text().splitlines()
        first = next((i for i, l in enumerate(lines) if CRON_TASK.search(l)), None)
        if first is None:
            continue
        users += 1
        if not installs_cron_before(lines, first):
            failures.append(
                f"{path.relative_to(ROOT)}:{first + 1}: uses ansible.builtin.cron without including "
                "the `cron` role (roles/cron) earlier in the same file. On a minimal Debian image "
                "there is no crontab and the task fails."
            )
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    if users == 0:
        print("::error::no file uses ansible.builtin.cron; this check would pass vacuously", file=sys.stderr)
        return 2
    print(f"OK: {users} task files declare cron jobs, each installs cron first")
    return 0


if __name__ == "__main__":
    sys.exit(main())
