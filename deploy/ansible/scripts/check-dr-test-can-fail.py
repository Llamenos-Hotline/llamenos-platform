#!/usr/bin/env python3
"""Keep playbooks/dr-test.yml a drill that can fail.

Why this gate exists
--------------------
dr-test.yml was documented as a recovery drill and could not have worked: it ran
on the control node instead of the host with the backups, looked for backup files
the backup roles no longer produce, started an image that does not exist, and
printed PASS from checks that were ``ignore_errors`` and only asked whether a
result EXISTED. A DR test that cannot run is worse than none -- it reads as
coverage. It looked fine because nothing in it could fail.

CI cannot run the drill (it needs the deployed app image and real backups on a
host), so this keeps its shape honest. The drill must:

* run on the hosts, not ``localhost``;
* have no ``ignore_errors`` and no ``failed_when: false``;
* assert the restored database and object store against what the backup lists,
  that the app reports ready, and the RTO;
* tear its scratch project down in an ``always`` section, and report why it
  failed in a ``rescue`` section.

There is no allowlist.
"""
from __future__ import annotations

import pathlib
import re
import sys

PLAYBOOK = pathlib.Path(__file__).resolve().parent.parent / "playbooks" / "dr-test.yml"


def main() -> int:
    text = PLAYBOOK.read_text()
    code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
    failures: list[str] = []

    if re.search(r"^\s*hosts\s*:\s*localhost\b", code, re.M):
        failures.append("runs on localhost: a drill must run on the host that holds the backups")
    if re.search(r"^\s*connection\s*:\s*local\b", code, re.M):
        failures.append("uses connection: local: a drill must run on the host that holds the backups")
    if re.search(r"ignore_errors\s*:\s*(true|yes)", code, re.I):
        failures.append("uses ignore_errors: every check in a drill must be able to fail the play")
    if re.search(r"failed_when\s*:\s*(false|no)\b", code, re.I):
        failures.append("uses failed_when: false: a check that cannot fail proves nothing")
    for what, pattern in [
        ("assert the restored tables against the dump's own listing", r"tables the dump lists"),
        ("assert the restored files against the archive's own listing", r"files the archive lists"),
        ("wait for the app to report ready on the restored data", r"/api/health/ready"),
        ("fail when the RTO target is missed", r"Fail the drill if the RTO target was missed"),
        ("tear the scratch project down in an `always` section", r"(?s)\balways\s*:.*down -v"),
    ]:
        if not re.search(pattern, code):
            failures.append(f"no longer does this: {what}")
    if not re.search(r"^\s*rescue\s*:", code, re.M):
        failures.append("has no rescue section: a failed drill must report why and still fail")
    if failures:
        print("playbooks/dr-test.yml:\n  " + "\n  ".join(failures), file=sys.stderr)
        return 1
    print("OK: dr-test.yml runs on the host, has no ignore_errors, asserts restore counts, app readiness and RTO, and always tears down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
