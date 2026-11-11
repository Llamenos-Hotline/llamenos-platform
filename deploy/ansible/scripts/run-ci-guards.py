#!/usr/bin/env python3
"""Run every ansible CI guard registered under deploy/ansible/ci-guards/.

Why this exists (#2645)
-----------------------
ci.yml used to carry one hand-written `- name: Check ...` / `run: python3 ...`
step per guard, appended to the tail of one long list. N authors appending at
one anchor meant N-1 merge conflicts, and they recurred as each one merged:
three deploy PRs were DIRTY at once on that single hunk, and one sat
UNMERGEABLE at queue position 1 for six hours.

Now a guard is a new file, `deploy/ansible/ci-guards/<id>.toml`:

    name = "Check X cannot happen"        # shown in the log + failure summary
    run  = "python3 deploy/ansible/scripts/check-x.py"   # bash, run from repo root
    why  = "Free text: the incident this guard prevents."  # optional

Two authors adding two guards add two files, which git never conflicts. ci.yml
carries exactly one step that calls this runner.

Legibility is preserved on purpose: each guard runs in its own `::group::`
named after the guard, a failure emits an `::error title=<name>::` annotation,
and the end-of-run summary lists every guard that tripped (it does not stop at
the first, so one push shows all of them). The runner never exits 0 on an empty
or under-populated directory: that would be a gate that checks nothing.

Usage: run-ci-guards.py [--dir DIR] [--min N]   (cwd must be the repo root)
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tomllib
from pathlib import Path

DEFAULT_DIR = Path("deploy/ansible/ci-guards")
# A floor, not a count to keep current: it only has to be high enough that a
# moved directory or a bad glob cannot pass vacuously. Do not bump it per guard.
DEFAULT_MIN = 8
ALLOWED_KEYS = {"name", "run", "why"}


class ManifestError(Exception):
    pass


def load_guards(directory: Path) -> list[dict[str, str]]:
    """Parse and validate every manifest file; raise ManifestError on any defect."""
    if not directory.is_dir():
        raise ManifestError(f"guard directory {directory} does not exist")
    guards: list[dict[str, str]] = []
    problems: list[str] = []
    seen: dict[str, str] = {}
    for path in sorted(directory.glob("*.toml")):
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except (tomllib.TOMLDecodeError, OSError) as exc:
            problems.append(f"{path}: unreadable: {exc}")
            continue
        unknown = sorted(set(data) - ALLOWED_KEYS)
        if unknown:
            problems.append(f"{path}: unknown key(s) {unknown} (allowed: {sorted(ALLOWED_KEYS)})")
        ok = True
        for key in ("name", "run"):
            value = data.get(key)
            if not isinstance(value, str) or not value.strip():
                problems.append(f"{path}: `{key}` must be a non-empty string")
                ok = False
        if not ok:
            continue
        if data["name"] in seen:
            problems.append(f"{path}: duplicate name {data['name']!r} (also {seen[data['name']]})")
            continue
        seen[data["name"]] = str(path)
        guards.append({"name": data["name"], "run": data["run"], "file": str(path)})
    if problems:
        raise ManifestError("\n".join(problems))
    return guards


def run_guards(guards: list[dict[str, str]]) -> list[str]:
    """Run each guard; return the names of those that failed."""
    failed: list[str] = []
    for guard in guards:
        print(f"::group::{guard['name']}  [{guard['file']}]", flush=True)
        result = subprocess.run(["bash", "-c", guard["run"]], check=False)
        print("::endgroup::", flush=True)
        if result.returncode != 0:
            failed.append(guard["name"])
            # Outside the group so the annotation and a collapsed log both name the guard.
            print(
                f"::error title=ansible guard failed::{guard['name']} "
                f"(exit {result.returncode}) -- see the '{guard['name']}' log group; "
                f"defined in {guard['file']}",
                flush=True,
            )
    return failed


def write_summary(total: int, failed: list[str]) -> None:
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary:
        return
    with open(summary, "a", encoding="utf-8") as fh:
        if failed:
            fh.write(f"### Ansible guards: {len(failed)} of {total} failed\n\n")
            fh.writelines(f"- :x: {name}\n" for name in failed)
        else:
            fh.write(f"### Ansible guards: all {total} passed\n")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR)
    parser.add_argument("--min", type=int, default=DEFAULT_MIN, dest="minimum")
    args = parser.parse_args(argv)

    try:
        guards = load_guards(args.dir)
    except ManifestError as exc:
        print(f"::error::Invalid ansible guard manifest:\n{exc}", file=sys.stderr)
        return 2
    if len(guards) < args.minimum:
        print(
            f"::error::Found only {len(guards)} guard(s) in {args.dir}; expected at least "
            f"{args.minimum}. The directory is wrong or files were deleted, so this gate "
            "would have passed without checking anything.",
            file=sys.stderr,
        )
        return 2

    print(f"Running {len(guards)} ansible guards from {args.dir}:")
    for guard in guards:
        print(f"  - {guard['name']}")
    failed = run_guards(guards)
    write_summary(len(guards), failed)
    if failed:
        print(f"\n{len(failed)} of {len(guards)} ansible guards FAILED:", file=sys.stderr)
        for name in failed:
            print(f"  x {name}", file=sys.stderr)
        return 1
    print(f"\nAll {len(guards)} ansible guards passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
