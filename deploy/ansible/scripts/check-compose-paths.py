#!/usr/bin/env python3
"""Assert no day-2 playbook or role references the legacy monolithic compose
layout.

Why this exists (issue #1121): production renders one docker-compose.yml per
service under {{ app_dir }}/services/<service>/ (roles/llamenos-app,
roles/llamenos-postgres, etc. — see playbooks/deploy.yml). A single
{{ app_dir }}/docker-compose.yml never exists on a production host; that file
is only ever written by the legacy `llamenos` role, used exclusively by
playbooks/deploy-demo.yml for the internal staging instance (and archived by
playbooks/migrate-to-multi-host.yml while migrating a host off it). Every
day-2 operations playbook — backup, restore, update, rollback,
security-update, alerting, security scanning — silently referenced the
monolithic path anyway, so none of them could run against a real production
deploy. This script is the regression guard: it fails CI the moment any file
outside the allowlist below references the monolithic layout again.

It is a static text scan, not a live deploy — deliberately so: the issue
itself suggests exactly this ("A grep for {{ app_dir }}/docker-compose.yml
returning nothing outside the legacy demo role would do"). A live `dr-test`
job that actually provisions a host and runs every day-2 playbook against it
would catch more, but needs real infrastructure this repo's CI does not have;
tracked as follow-up, not done here.

Usage:
    python3 deploy/ansible/scripts/check-compose-paths.py

Exits non-zero (and prints every offending file:line) on any match outside
the allowlist.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ANSIBLE_DIR = Path(__file__).resolve().parent.parent

# Patterns that only ever make sense against the legacy monolithic layout.
# `app_dir` is deliberately not anchored to a fixed delimiter style (Jinja
# render differs by call site: "{{ app_dir }}/x" vs "{{app_dir}}/x" vs
# shell-interpolated "${app_dir}") -- we only care about the fixed suffix.
PATTERNS = [
    re.compile(r"app_dir\s*\}\}/docker-compose\.yml"),
    re.compile(r"app_dir\s*\}\}/\.env\b"),
    re.compile(r"app_dir\s*\}\}/Caddyfile\b"),
]

# Files that legitimately speak the legacy monolithic layout: the role that
# renders it, the playbook that deploys it (staging/demo only — see its
# LAYOUT NOTICE comment), the playbook that migrates a host off it, and this
# guard's own docstring/patterns.
ALLOWLIST = {
    ANSIBLE_DIR / "roles" / "llamenos" / "tasks" / "main.yml",
    ANSIBLE_DIR / "roles" / "llamenos" / "handlers" / "main.yml",
    ANSIBLE_DIR / "playbooks" / "deploy-demo.yml",
    ANSIBLE_DIR / "playbooks" / "migrate-to-multi-host.yml",
    ANSIBLE_DIR / "playbooks" / "tasks" / "discover-services.yml",
    ANSIBLE_DIR / "roles" / "backup-config" / "defaults" / "main.yml",
    Path(__file__).resolve(),
}

# Templates rendered BY the allowed role above live under its templates/
# directory and reference app_dir-relative paths from the *inside* -- not
# relevant to this check (they don't reference the compose/env path shape at
# all), but excluded defensively in case that changes.
ALLOWLIST_DIRS = {
    ANSIBLE_DIR / "roles" / "llamenos" / "templates",
}


def iter_files() -> list[Path]:
    files: list[Path] = []
    for ext in ("*.yml", "*.yaml", "*.j2"):
        files.extend(ANSIBLE_DIR.rglob(ext))
    return files


def main() -> int:
    violations: list[str] = []

    for path in iter_files():
        resolved = path.resolve()
        if resolved in ALLOWLIST:
            continue
        if any(resolved.is_relative_to(d) for d in ALLOWLIST_DIRS):
            continue

        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        for lineno, line in enumerate(text.splitlines(), start=1):
            for pattern in PATTERNS:
                if pattern.search(line):
                    violations.append(
                        f"{path.relative_to(ANSIBLE_DIR)}:{lineno}: {line.strip()}"
                    )

    if violations:
        print(
            "Found references to the legacy monolithic docker-compose.yml/.env/"
            "Caddyfile layout outside the allowlist (issue #1121). Production\n"
            "renders one compose file per service under "
            "{{ app_dir }}/services/<service>/ --\n"
            "point at that instead, or add the file to ALLOWLIST in "
            "scripts/check-compose-paths.py\nwith a reason if it genuinely "
            "needs the legacy layout.\n",
            file=sys.stderr,
        )
        for v in violations:
            print(f"  {v}", file=sys.stderr)
        return 1

    print(f"OK: no monolithic-layout references outside the allowlist ({len(iter_files())} files scanned).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
