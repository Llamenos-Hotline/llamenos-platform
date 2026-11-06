# shellcheck shell=bash disable=SC2034  # GH_READ_OUT/GH_READ_ERR are outputs, read by the sourcing step
#
# gh-read.sh — the ONE bounded-retry policy for a gate's GitHub API reads
# (#2481, #2483). Source it; do not execute it.
#
#   . "$GH_READ_LIB"
#   if ! gh_read "<label>" <gh api args...>; then
#     echo "::error::<gate> FAILED: <lookup token> — ..."; printf '%s\n' "$GH_READ_ERR"; exit 1
#   fi
#   value="$GH_READ_OUT"
#
# WHY IT EXISTS. On 2026-11-05 two merge groups (#2467, #2472) were ejected
# within one minute because a single `gh api .../pulls/<n>` call failed while
# GitHub's API was flaky, discarding a full gate run whose every other
# workflow had passed. A failed READ is "I could not ask", not an answer, so
# it is retried: 5 attempts, backing off 2s, 4s, 8s, 16s (30s of sleep at
# most, against a merge group that costs a full gate run to rebuild).
#
# WHAT IS RETRIED, judged from `gh`'s own stderr: anything with no HTTP
# status at all (transport errors, timeouts, a GraphQL-level "Something went
# wrong"), HTTP 5xx, 408, 429, and a 403 that says it is a rate limit. Every
# other 4xx — a 404 for a PR that does not exist, a 401 for a bad token — is
# a well-formed answer from GitHub and fails on the first attempt.
#
# WHAT CANNOT BE RETRIED, by construction: an answer. `gh_read` retries only
# a non-zero `gh` exit; a 200 response is a SUCCESSFUL read whatever it says,
# and the caller's judgement runs exactly once on it. Callers must keep
# "could not ask" (`gh_read` returned 1 — a lookup token) and "asked, and
# the answer is no" (their own verdict token) as DIFFERENT tokens, both
# failing closed. Never wrap the judgement, the step or the job in a retry:
# an outer retry re-runs a real objection until it goes away (and a mid-run
# job rerun is refused 403 anyway, #2458).
#
# `gh_read <label> <gh api args...>` sets GH_READ_OUT / GH_READ_ERR rather
# than printing, so it runs in the CALLER's shell (not a `$(...)` subshell)
# and its ::warning:: lines reach the log as workflow commands.
#
# SHARED, NOT COPIED. Consumers: fleet-verify.yml's merge_group PR-context
# resolver and its #1894 queue guard, which source this file from a sparse
# checkout of the merge-group head. fleet-review.yml's merge_group arm (#2482)
# still carries these same definitions inline — it predates this file, and
# its `run:` executes before any checkout. Until it sources this file too,
# tests/orchestrator/gh-read-helper.test.ts pins the two byte-identical, so
# a change to the policy in one place without the other fails CI.

lookup_retryable() {
  local code
  code="$(printf '%s' "$1" | grep -oE 'HTTP [0-9]{3}' | tail -n 1 | grep -oE '[0-9]{3}' || true)"
  if [ -z "$code" ]; then
    return 0
  fi
  case "$code" in
    5??|408|429) return 0 ;;
    403) grep -qi 'rate limit' <<<"$1" ;;
    *) return 1 ;;
  esac
}
GH_READ_ATTEMPTS=5
gh_read() {
  local what="$1" attempt=1 delay=2 errfile
  shift
  errfile="$(mktemp)"
  while :; do
    if GH_READ_OUT="$(gh api "$@" 2>"$errfile")"; then
      GH_READ_ERR=""
      rm -f "$errfile"
      return 0
    fi
    GH_READ_ERR="$(cat "$errfile")"
    if ! lookup_retryable "$GH_READ_ERR"; then
      echo "$what: non-retryable failure on attempt $attempt/$GH_READ_ATTEMPTS — a well-formed answer from GitHub, not retried"
      rm -f "$errfile"
      return 1
    fi
    if [ "$attempt" -ge "$GH_READ_ATTEMPTS" ]; then
      echo "$what: still failing after $attempt/$GH_READ_ATTEMPTS attempts"
      rm -f "$errfile"
      return 1
    fi
    echo "::warning::$what failed (attempt $attempt/$GH_READ_ATTEMPTS, transient) — retrying in ${delay}s: $(printf '%s' "$GH_READ_ERR" | tr '\n' ' ')"
    sleep "$delay"
    attempt=$((attempt + 1))
    delay=$((delay * 2))
  done
}
