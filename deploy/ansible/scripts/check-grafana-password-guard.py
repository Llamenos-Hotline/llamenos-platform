#!/usr/bin/env python3
"""Prove an empty or weak Grafana admin password cannot be deployed.

Why this gate exists
--------------------
GF_SECURITY_ADMIN_PASSWORD="" is not "no admin account": Grafana treats it as
unset and keeps its built-in ``admin``/``admin`` login. The production vars
template never mentioned ``grafana_admin_password``, preflight never asserted it,
and the role defaulted it to ``""`` -- so an operator who followed the template
deployed a default credential (measured: ``admin:admin`` -> HTTP 200).

This runs the shared assertion (playbooks/tasks/assert-grafana-admin-password.yml)
against a table of values and requires the verdict for each to be the expected
one -- including that every bad value is refused for the RIGHT reason (our
message, not an expression error) -- and then checks, statically, that the two
places that must call it still do: playbooks/preflight.yml and the grafana role,
before the role does anything else.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile

ANSIBLE_DIR = pathlib.Path(__file__).resolve().parent.parent
ASSERT_FILE = ANSIBLE_DIR / "playbooks" / "tasks" / "assert-grafana-admin-password.yml"

# (label, extra-vars, must_pass)
CASES = [
    ("a generated password", {"grafana_admin_password": "Zq8-converge/Pass+word=2026x"}, True),
    ("exactly 16 characters", {"grafana_admin_password": "a" * 16}, True),
    ("the key is absent", {}, False),
    ("empty string", {"grafana_admin_password": ""}, False),
    ("the built-in default, admin", {"grafana_admin_password": "admin"}, False),
    ("15 characters", {"grafana_admin_password": "a" * 15}, False),
    ("whitespace", {"grafana_admin_password": "has space 123456789012"}, False),
    ("a double quote", {"grafana_admin_password": 'has"quote123456789012'}, False),
    ("a backslash", {"grafana_admin_password": "has\\back123456789012"}, False),
    ("not a string", {"grafana_admin_password": 1234567890123456}, False),
]

PLAY = f"""---
- hosts: localhost
  gather_facts: false
  become: false
  tasks:
    - ansible.builtin.import_tasks: {ASSERT_FILE}
"""


def run_case(play: pathlib.Path, extra: dict) -> tuple[int, str]:
    env = dict(os.environ, ANSIBLE_BECOME="false", ANSIBLE_CONFIG=str(ANSIBLE_DIR / "ansible.cfg"))
    proc = subprocess.run(
        ["ansible-playbook", "-i", "localhost,", "-c", "local", str(play), "-e", json.dumps(extra or {"_": 1})],
        capture_output=True, text=True, env=env, cwd=ANSIBLE_DIR,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    failures: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        play = pathlib.Path(tmp) / "case.yml"
        play.write_text(PLAY)
        for label, extra, must_pass in CASES:
            rc, out = run_case(play, extra)
            if must_pass and rc != 0:
                failures.append(f"{label}: should be ACCEPTED but was refused:\n{out[-600:]}")
            elif not must_pass and rc == 0:
                failures.append(f"{label}: should be REFUSED but was accepted")
            elif not must_pass and "REQUIRED: 'grafana_admin_password'" not in out:
                failures.append(f"{label}: refused, but not by the assertion (an expression error would also fail):\n{out[-600:]}")
            # The value itself must never be printed.
            secret = str(extra.get("grafana_admin_password", ""))
            if len(secret) >= 16 and secret in out:
                failures.append(f"{label}: the password value appears in the output")
    preflight = (ANSIBLE_DIR / "playbooks" / "preflight.yml").read_text()
    if "tasks/assert-grafana-admin-password.yml" not in preflight:
        failures.append("playbooks/preflight.yml no longer asserts grafana_admin_password")
    role = (ANSIBLE_DIR / "roles" / "llamenos-grafana" / "tasks" / "main.yml").read_text()
    body = [l for l in role.splitlines() if l.strip() and not l.lstrip().startswith("#") and l.strip() != "---"]
    if not body or "assert-grafana-admin-password.yml" not in body[0] + (body[1] if len(body) > 1 else ""):
        failures.append("roles/llamenos-grafana/tasks/main.yml must run the password assertion before anything else")
    defaults = (ANSIBLE_DIR / "roles" / "llamenos-grafana" / "defaults" / "main.yml").read_text()
    if re.search(r"^grafana_admin_password\s*:", defaults, re.M):
        failures.append("roles/llamenos-grafana/defaults/main.yml gives grafana_admin_password a default again")
    example = (ANSIBLE_DIR / "vars-production.example.yml").read_text()
    if not re.search(r"^grafana_admin_password\s*:", example, re.M):
        failures.append("vars-production.example.yml no longer lists grafana_admin_password")
    if failures:
        print("\n\n".join(failures), file=sys.stderr)
        return 1
    print(f"OK: {len(CASES)} password cases judged correctly; preflight and the role both assert it; "
          "no role default; the production template lists it")
    return 0


if __name__ == "__main__":
    sys.exit(main())
