#!/usr/bin/env bash
# The self-hosted Mac's disk-headroom ADMISSION step: run the disk guard, and
# when it refuses while another CI job is still on this host, WAIT for that
# job's teardown instead of failing at once. Every workflow job that lands on
# the iOS Macs calls this, never `mac-runner-disk-guard.sh guard` directly.
#
# Why this is a script and not a flag each caller must remember (#2533).
#   `mac-mini-ios-1` and `mac-mini-ios-2` are two runners on ONE physical Mac, so
#   any two concurrently scheduled iOS jobs are each other's co-tenants on one
#   /System/Volumes/Data — a merge group's `ios-build-test` and
#   `ios-e2e / build (mac)` start together. The wait lived inline in
#   ios-e2e.yml's `build` only; ci.yml's two iOS jobs called the bare guard,
#   which checks once and refuses. On 2026-11-06 the pair refused within a
#   minute of each other, the job with no wait died first, and the group — and
#   the PR in it — was ejected for a shortfall a sibling's teardown returns
#   (#2470, #2518). A caller added next month inherits whichever default it
#   copies; scripts/ci/mac-runner-disk-guard-wait.test.ts now fails CI when
#   a workflow runs the bare guard, so the choice is no longer a copy.
#
# What waiting does and does not do. It makes the ADMISSION decision correct
# when the shortfall belongs to a job that will finish. It cannot help when the
# job being waited on is itself waiting on this one (two jobs both at the
# guard with the disk under the floor and nothing running) — both then wait out
# the deadline and refuse, which is the honest verdict for a host with no room
# for either and costs the merge queue no more than the refusal it replaces.
# It does not guard a volume that is adequate at admission and exhausted
# mid-run; that is the headroom reading each job takes during its work.
#
# THE GUARD ITSELF MUST NOT BE ABLE TO HANG (2026-10-21). Each attempt runs
# under a watchdog and its output reaches the job log either way; a hung
# attempt falls back to the guard's own df-only `gate` mode, taken only once the
# guard has proved (`write paths OK:`) that every path the job writes is on a
# volume it can read. Full reasoning is in ios-e2e.yml's `build` copy, which
# this script was extracted from. Nothing here signals a process group: only the
# guard's own pid and its direct children are ever signalled.
#
# Environment (the workflow step sets the first three):
#   DISK_WAIT_MAX_MIN           how long a refusal may wait for a co-tenant (min)
#   DISK_WAIT_POLL_SEC          seconds between attempts
#   DISK_GUARD_ATTEMPT_MAX_SEC  watchdog per attempt
#   DISK_WAIT_MAX_SEC           overrides DISK_WAIT_MAX_MIN, in seconds (tests)
#   DISK_GUARD_SCRIPT           the guard to run (tests); default: the sibling script
#
# The calling step's `timeout-minutes` must exceed DISK_WAIT_MAX_MIN, and the
# job's must be its own budget PLUS that step's cap, so a wait that ends in a
# pass leaves the job its whole budget. Change them together.
set -uo pipefail

GUARD="${DISK_GUARD_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mac-runner-disk-guard.sh}"
DISK_WAIT_MAX_MIN="${DISK_WAIT_MAX_MIN:-35}"
DISK_WAIT_POLL_SEC="${DISK_WAIT_POLL_SEC:-60}"
DISK_GUARD_ATTEMPT_MAX_SEC="${DISK_GUARD_ATTEMPT_MAX_SEC:-90}"
wait_max_sec="${DISK_WAIT_MAX_SEC:-$(( DISK_WAIT_MAX_MIN * 60 ))}"
RUNNER_TEMP="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
GITHUB_STEP_SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/null}"

guard_log="$RUNNER_TEMP/disk-guard.log"
guard_summary="$RUNNER_TEMP/disk-guard-summary.md"
# This runner's install root, so its own Runner.Worker is not mistaken for a
# co-tenant: .../actions-runner-ios-1/_work/<repo>.
own_root="${RUNNER_WORKSPACE%%/_work/*}"
deadline=$(( SECONDS + wait_max_sec ))
attempt=0
while :; do
  attempt=$((attempt + 1))
  # Each attempt's summary goes to a scratch file and only the last one is
  # published, so a wait that ends well leaves no stale REFUSED line in the
  # job summary.
  : > "$guard_summary"
  : > "$guard_log"
  # An attempt may not run past the wait deadline, or the step's own
  # timeout-minutes would kill it and hide the verdict again.
  cap="$DISK_GUARD_ATTEMPT_MAX_SEC"
  remaining=$(( deadline - SECONDS ))
  [ "$remaining" -ge "$cap" ] || cap=$(( remaining > 10 ? remaining : 10 ))
  GITHUB_STEP_SUMMARY="$guard_summary" \
    bash "$GUARD" guard >"$guard_log" 2>&1 &
  gpid=$!
  started=$SECONDS
  hung=0
  while kill -0 "$gpid" 2>/dev/null; do
    if [ $(( SECONDS - started )) -ge "$cap" ]; then hung=1; break; fi
    sleep 1
  done
  if [ "$hung" -eq 1 ]; then
    last_line=$(tail -n 1 "$guard_log" 2>/dev/null || true)
    # The script's own pid and its direct children, nothing wider.
    pkill -TERM -P "$gpid" 2>/dev/null || true
    kill -TERM "$gpid" 2>/dev/null || true
    sleep 2
    pkill -KILL -P "$gpid" 2>/dev/null || true
    kill -KILL "$gpid" 2>/dev/null || true
    # Never `wait` on something that may not have died: a process stuck in the
    # kernel ignores SIGKILL, and waiting is the bug.
    if kill -0 "$gpid" 2>/dev/null; then disown "$gpid" 2>/dev/null || true; else wait "$gpid" 2>/dev/null || true; fi
    echo "::group::disk guard output before it hung (attempt $attempt)"
    cat "$guard_log"
    echo "::endgroup::"
    # The guard checks that this job's write paths are on the volume it
    # measures BEFORE it walks anything, and prints the marker on success. A
    # hang before the marker is a hang on one of those paths (an external drive
    # the runner cannot read), so the df fallback below would be measuring the
    # wrong disk: refuse.
    if ! grep -q '^write paths OK:' "$guard_log"; then
      echo "::error::disk guard hung (attempt $attempt) while checking the volumes this job's write paths are on (last output: '${last_line}'). A path this job writes is on a filesystem the runner service cannot read (macOS TCC 'Removable Volumes' denies it the external drive itself; the CI work volume's disk image is the way round that), so no free-space reading here would describe it. THIS IS NOT A TEST FAILURE AND NOT THIS PR'S FAULT. See docs/runbooks/mac-ci-runner-disk.md."
      printf 'REFUSED: guard hung checking write paths (%s). Environmental, not this PR.\n' "$last_line" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
      exit 1
    fi
    # Every df below already answered once, in the attempt above.
    fallback_log="$RUNNER_TEMP/disk-guard-fallback.log"
    if bash "$GUARD" gate >"$fallback_log" 2>&1; then
      cat "$fallback_log"
      echo "::warning::disk guard did not finish within ${cap}s (attempt $attempt; last output: '${last_line}'). Its report/reclaim is blocked on a path that is not about free space, so the check fell back to the guard's df-only gate, which held every volume this job writes to its own floor and passed. Proceeding WITHOUT reclaim."
      printf '### iOS runner disk guard (%s)\n\nGuard script hung after %ss (last output: %s). df-only fallback passed: %s. Proceeded without reclaim.\n\n' \
        "${RUNNER_NAME:-local}" "$cap" "$last_line" "$(grep '^disk headroom OK' "$fallback_log" | tr '\n' ' ')" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
      exit 0
    fi
    # Into the guard log, so the verdict and shortfall lines below read the
    # fallback's numbers like any other refusal.
    tee -a "$guard_log" < "$fallback_log"
    echo "::error::disk guard did not finish within ${cap}s (attempt $attempt; last output: '${last_line}') and its df-only fallback refused ($(grep -o 'disk-guard-verdict: refused .*' "$fallback_log" | tail -1)). THIS IS NOT A TEST FAILURE AND NOT THIS PR'S FAULT."
    printf 'REFUSED: guard script hung; df-only fallback: %s. Environmental, not this PR.\n' "$(grep '^disk-guard-verdict:' "$fallback_log" | tr '\n' ' ')" > "$guard_summary"
    rc=1
  elif wait "$gpid"; then
    rc=0
  else
    rc=$?
  fi
  others=$(pgrep -fl '/bin/Runner.Worker' 2>/dev/null | grep -vF "$own_root/" | grep -c . || true)
  if [ "$rc" -eq 0 ] || [ "$others" -eq 0 ] || [ "$SECONDS" -ge "$deadline" ]; then
    [ "$hung" -eq 1 ] || cat "$guard_log"
    cat "$guard_summary" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null || true
    waited="$((attempt - 1)) x ${DISK_WAIT_POLL_SEC}s"
    # The guard's own `disk-guard-verdict:` line carries free, need and the gap
    # in MiB (#2644). A shortfall of 150 MB with nothing else running is a
    # different fault from a busy disk, and only the busy disk is worth a wait;
    # say which one this is.
    verdict=$(grep -o 'disk-guard-verdict: refused .*' "$guard_log" 2>/dev/null | tail -1 || true)
    if [ "$rc" -eq 0 ]; then
      [ "$attempt" -eq 1 ] || echo "disk headroom passed on attempt $attempt, after waiting $waited for a co-tenant CI job's teardown"
    elif [ "$others" -gt 0 ]; then
      echo "::error::still refused after waiting $waited for $others co-tenant CI job(s) on this host to release space (${verdict:-no verdict line; guard did not finish})"
    elif [ "$attempt" -gt 1 ]; then
      echo "::error::still refused after waiting $waited: every co-tenant CI job has finished and the space did not come back, so what holds it is not CI's (${verdict:-no verdict line; guard did not finish})"
    else
      echo "::error::refused at once, NOT waiting: no other CI job is running on this host, so no teardown is coming to return space and waiting cannot help (${verdict:-no verdict line; guard did not finish}). The space is held by something CI does not own; the guard's reclaim output above lists what it removed and 'scripts/ci/mac-runner-disk-guard.sh report' lists the rest, including the /private/var/tmp simulator runtime dirs (#2644)."
    fi
    exit "$rc"
  fi
  # Not `::warning::` — a wait that ends in a pass is not a problem.
  shortfall=$(grep -o 'only [0-9.]* GiB free' "$guard_log" | head -1 || true)
  [ -n "$shortfall" ] || shortfall="guard hung, df fallback short"
  echo "disk headroom short (attempt $attempt): $shortfall; $others other CI job(s) on this host will release space at teardown; re-checking in ${DISK_WAIT_POLL_SEC}s ($(( (deadline - SECONDS) / 60 )) min left)"
  nap="$DISK_WAIT_POLL_SEC"
  left=$(( deadline - SECONDS ))
  [ "$nap" -le "$left" ] || nap="$left"
  sleep "$nap"
done
