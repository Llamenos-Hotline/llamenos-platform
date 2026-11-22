#!/usr/bin/env python3
"""Fail when a PR introduces a contributor's absolute local home path (#2918).

A path such as /home/<account>/... or /Users/<account>/... carries the
operating-system account name of whoever ran the command. It is of no use to a
later reader and it is the kind of thing a pasted command transcript carries
without anyone choosing to. This is a volume problem, so it is a guard, not a
convention.

Two surfaces are checked, both for what a change ADDS:

  diff   every added line of `git diff <base>...<head>` (file and line reported)
  body   the PR description (only when --body-json is given)

A finding quotes the path ROOT only (`/home/<user>/`) plus the location. It never
echoes the segment or the surrounding text: the failure message must not
reproduce the content it is flagging, and a CI log is public.

Not findings:
  * relative paths (apps/worker/routes/) and any `.../home/<x>/` that is the tail
    of a longer path (the match must start at a path boundary)
  * placeholders and non-account paths: ALLOWED_ACCOUNTS below, and a segment
    that does not start with an alphanumeric (/home/.local, /home/<user>/,
    /home/$USER/, /home/~)

Fail closed: an unreadable diff, a missing range or an unparseable body exits 2.
"could not check" is never "clean".

Exit codes: 0 clean | 1 finding(s) | 2 could not check

Usage:
  check-local-paths.py --base <sha> --head <sha> [--body-json '<json string|null>']
  check-local-paths.py --body-json '<json string|null>'
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from typing import Iterator, NamedTuple

# Account names that are documented placeholders or service accounts, not a
# contributor's machine. `llamenos` and `operator` are the placeholders in
# deploy/ansible/vars-production.example.yml and tests/orchestrator/engines.test.ts;
# `runner` is every GitHub Actions log excerpt (/home/runner, /Users/runner);
# `ci` and `deploy` are the container user of deploy/docker/Dockerfile.ci-base and
# the documented deploy account in docs/QUICKSTART.md.
ALLOWED_ACCOUNTS = frozenset({"llamenos", "operator", "runner", "ci", "deploy"})

# `/home/<seg>` or `/Users/<seg>` that STARTS at a path boundary (so `apps/home/x/`
# and `https://host/home/x/` are not matches) and whose segment is a real name.
LOCAL_PATH = re.compile(r"(?<![\w.~/$\-])(/(?:home|Users))/([A-Za-z0-9][A-Za-z0-9._-]*)(?![A-Za-z0-9._-])")

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


class Finding(NamedTuple):
    where: str  # `path:line` or `PR body:line`
    root: str   # `/home` or `/Users`


def scan_text(text: str) -> Iterator[tuple[int, str]]:
    """Yield (1-based line, root) for each non-allowed local path in `text`."""
    for n, line in enumerate(text.splitlines(), start=1):
        for m in LOCAL_PATH.finditer(line):
            if m.group(2) not in ALLOWED_ACCOUNTS:
                yield n, m.group(1)


def scan_diff(diff: str) -> list[Finding]:
    """Scan a unified diff (-U0) and report findings on added lines only."""
    out: list[Finding] = []
    path: str | None = None
    lineno = 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            tgt = raw[4:]
            path = None if tgt == "/dev/null" else (tgt[2:] if tgt.startswith("b/") else tgt)
            continue
        if raw.startswith("--- ") or raw.startswith("diff --git"):
            continue
        h = HUNK.match(raw)
        if h:
            lineno = int(h.group(1))
            continue
        if raw.startswith("+") and path is not None:
            for _, root in scan_text(raw[1:]):
                out.append(Finding(f"{path}:{lineno}", root))
            lineno += 1
    return out


def scan_body(body_json: str) -> list[Finding]:
    """`body_json` is the JSON encoding of the PR body: a string, or null."""
    try:
        body = json.loads(body_json)
    except (ValueError, TypeError) as e:
        raise CouldNotCheck(f"the PR body is not valid JSON ({e.__class__.__name__})") from e
    if body is None:
        return []
    if not isinstance(body, str):
        raise CouldNotCheck("the PR body is neither a string nor null")
    return [Finding(f"PR body:{n}", root) for n, root in scan_text(body)]


class CouldNotCheck(Exception):
    pass


def git_diff(base: str, head: str) -> str:
    cmd = ["git", "-c", "core.quotepath=off", "diff", "--no-color", "--no-ext-diff",
           "--no-renames", "--unified=0", f"{base}...{head}"]
    try:
        res = subprocess.run(cmd, capture_output=True, check=False)
    except OSError as e:
        raise CouldNotCheck(f"could not run git ({e.__class__.__name__})") from e
    if res.returncode != 0:
        raise CouldNotCheck(f"`git diff {base}...{head}` exited {res.returncode}: {res.stderr.decode('utf-8', 'replace').strip()}")
    return res.stdout.decode("utf-8", "replace")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--base")
    ap.add_argument("--head")
    ap.add_argument("--body-json")
    args = ap.parse_args(argv)

    if (args.base is None) != (args.head is None):
        print("check-local-paths: --base and --head go together", file=sys.stderr)
        return 2
    if args.base is None and args.body_json is None:
        print("check-local-paths: nothing to check (no range, no body) — refusing to pass vacuously", file=sys.stderr)
        return 2

    findings: list[Finding] = []
    try:
        if args.base is not None:
            findings += scan_diff(git_diff(args.base, args.head))
        if args.body_json is not None:
            findings += scan_body(args.body_json)
    except CouldNotCheck as e:
        print(f"check-local-paths: COULD NOT CHECK — {e}. This is a failure, not a pass.", file=sys.stderr)
        return 2

    if not findings:
        print("check-local-paths: no machine-specific absolute home path added")
        return 0

    for f in findings:
        print(f"::error title=Local absolute path::{f.where}: a contributor's absolute path ({f.root}/<user>/…) was added")
    print(
        f"\ncheck-local-paths: {len(findings)} machine-specific absolute path(s) added (account name not echoed).\n"
        "These carry the OS account name of whoever ran the command. Replace each with a relative\n"
        "path (apps/worker/routes/) or a placeholder (/home/operator/, /home/runner/), then push.\n"
        "For the PR body: edit the description, then push any commit to re-run this check.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
