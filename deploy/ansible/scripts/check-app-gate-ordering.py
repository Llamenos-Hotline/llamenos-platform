#!/usr/bin/env python3
"""Require the app role's migration gate to run before anything starts the app.

Why this gate exists
--------------------
The app image migrates its database on every container start. The migration
safety gate (roles/llamenos-app/tasks/migration-gate.yml) judges the image's
migrations against the database BEFORE that happens -- but only if nothing has
already started the container. The task named "Pull app image if not present
locally" was ``community.docker.docker_compose_v2 state: present,
recreate: never``: that is ``compose up``, so it started the app. On a fresh host
the entrypoint began migrating the empty database and the gate, about a second
later, read a half-applied ledger, judged the remainder a risky upgrade and
failed the first deploy -- every time. When the timing went the other way the
app migrated with no gate and no pre-upgrade backup at all.

``--syntax-check`` and ``ansible-lint`` cannot see an ordering dependency. This
does: in roles/llamenos-app/tasks/main.yml the gate include must appear before
the first task that can start or restart the app
(``community.docker.docker_compose_v2`` -- not ``_pull``, which only fetches
images -- or a ``docker compose up``/``start``/``restart`` command), and the
role must not flush handlers before the gate (a flush runs "Restart app
service").
"""
from __future__ import annotations

import pathlib
import re
import sys

MAIN = pathlib.Path(__file__).resolve().parent.parent / "roles" / "llamenos-app" / "tasks" / "main.yml"

GATE = re.compile(r"include_tasks\s*:\s*migration-gate\.yml|import_tasks\s*:\s*migration-gate\.yml")
STARTS = [
    (re.compile(r"^\s*community\.docker\.docker_compose_v2\s*:"), "a docker_compose_v2 task (this is `compose up`)"),
    (re.compile(r"docker\s+compose\b[^\n]*\b(up|start|restart|run)\b(?!.*--no-start)"), "a `docker compose up/start/restart/run` command"),
    (re.compile(r"meta\s*:\s*flush_handlers"), "a handler flush (runs 'Restart app service')"),
]


def main() -> int:
    lines = [l for l in MAIN.read_text().splitlines() if not l.lstrip().startswith("#")]
    gate = next((i for i, l in enumerate(lines) if GATE.search(l)), None)
    if gate is None:
        print(f"{MAIN.name}: no migration-gate include found; the gate has been removed or renamed", file=sys.stderr)
        return 1
    failures = []
    for i, line in enumerate(lines[:gate]):
        for pattern, what in STARTS:
            if pattern.search(line):
                failures.append(
                    f"roles/llamenos-app/tasks/main.yml: {what} appears BEFORE the migration gate "
                    f"(line text: {line.strip()!r}). It starts the app, which migrates the database, "
                    "so the gate then judges a half-migrated database."
                )
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("OK: nothing in the app role can start the app before the migration gate")
    return 0


if __name__ == "__main__":
    sys.exit(main())
