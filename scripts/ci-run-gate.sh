#!/usr/bin/env bash
# ci-run-gate.sh — run a CI gate and keep "it found a problem" apart from "it
# could not run" (#2455).
#
#   scripts/ci-run-gate.sh <gate-name> -- <command...>
#
# The convention the migration gates follow: exit 0 = verified clean, exit 1 =
# a verdict (the check ran and said no), exit 2 = the check did not execute
# (base not fetchable, no Postgres, a crash). GitHub shows any non-zero step as
# the same red cross, so a 2 used to read as drift and sent people hunting for a
# migration conflict that did not exist.
#
# This wrapper never turns a failure into a pass. Exit 0 -> 0, exit 1 -> 1
# untouched. Exit 2 (or any other code, or death by signal) still FAILS the step,
# but loudly labelled: an error annotation, a step summary, and a step output
# `did_not_run` that the job re-exports so ci-status can say it too.
set -uo pipefail

gate="${1:?usage: ci-run-gate.sh <gate-name> -- <command...>}"
shift
[[ "${1:-}" == "--" ]] && shift
[[ $# -gt 0 ]] || { echo "ci-run-gate.sh: no command given" >&2; exit 64; }

"$@"
rc=$?

if [[ $rc -eq 0 || $rc -eq 1 ]]; then
  exit "$rc"
fi

msg="$gate DID NOT RUN (exit $rc) — this is NOT a finding. The check never reached a verdict, so there is no migration conflict to look for in this diff. Read the log above for why it could not run (a base commit it could not fetch, a database it could not start); fix that or re-run."
echo "::error title=$gate DID NOT RUN (not drift)::$msg"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### $gate: DID NOT RUN"
    echo ""
    echo "$msg"
  } >> "$GITHUB_STEP_SUMMARY"
fi
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "did_not_run=$gate" >> "$GITHUB_OUTPUT"
fi
# Still a failure: an unverified gate must never read as passing.
exit 1
