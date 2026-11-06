#!/usr/bin/env bash
#
# Disk guard for the self-hosted macOS runners that serve the `ios-e2e` label.
#
# WHY THIS EXISTS (#1665)
# ----------------------
# On 2026-10-07 the shared data volume on that host filled up mid-run and the
# two **runner agents** died — not the jobs:
#
#   Unhandled exception. System.IO.IOException: No space left on device :
#     '.../_diag/Worker_<ts>-utc.log'
#      at GitHub.Runner.Common.HostContext.Dispose()
#
# Both agents threw it within one second of each other, from their own tracing
# writer, 18 and 28 minutes into two different jobs. The consequences of the
# agent dying rather than the job failing are the whole point of this file:
#
#   * no log was uploaded at all (`/actions/jobs/<id>/logs` -> BlobNotFound),
#   * every step from the test onward recorded a **null** conclusion,
#   * the only surviving evidence was in the check-run annotations,
#   * so the merge queue ejected a PR that needed no code change, and the
#     honest reading from the job logs was "the iOS suite failed on this PR".
#
# The asymmetry this script is built around: **a job that refuses is a red
# check somebody can read; an agent that crashes produces nothing.** Refusing
# early is always the better failure, even when the refusal is wrong.
#
# It also stops feeding #1639. A crashed agent runs no `if: always()` teardown,
# so the job's simulator (2.4-2.6 GiB of device data, measured) is leaked
# permanently and the volume ratchets down by ~5 GiB per incident. Reclaiming
# at job START is the only point guaranteed to run no matter how the previous
# job died — the same reasoning #1639 applies to the leaked backend port, and
# the reason the sweep belongs here rather than in a teardown step.
#
# WHAT IT WILL AND WILL NOT DELETE
# --------------------------------
# This host is also somebody's development machine. Everything removed here is
# created by CI and identifiable as CI's by name:
#
#   * simulator devices named `ios-e2e-*` or `ios-build-test-*` (the naming
#     schemes of the two CI jobs that create devices) older than
#     MAC_SIM_MAX_AGE_MIN,
#   * runner agent `_diag` logs older than MAC_DIAG_MAX_AGE_DAYS,
#   * CoreSimulator caches and machine-generated CoreSimulator logs,
#   * simulator devices the installed Xcode reports as unavailable,
#   * ANY simulator device that has been Shutdown and untouched for longer
#     than MAC_SIM_STALE_MAX_AGE_HOURS (default 24), whatever its name
#     (#1861). A device idle for a day on a dedicated CI host is a leftover,
#     not a fixture: the one that triggered #1861 was Xcode's default
#     `iPhone 17`, 61 hours idle and 3.86 GiB, created by a destination
#     selected by NAME and owned by nothing. Booted devices are still never
#     touched — a booted device is a live process tree somebody is using.
#
# Deliberately NOT touched, each for a measured reason:
#
#   * `~/Library/Developer/Xcode/DerivedData` — CI never writes here: both iOS
#     build jobs pass `-derivedDataPath "$RUNNER_TEMP/llamenos-build"` and
#     delete it themselves. Each Xcode directory's info.plist names its
#     WorkspacePath. Only entries whose workspace is gone and whose directory
#     has been idle for at least 60 minutes are reclaimed; live, recent, and
#     uninspectable entries are retained and reported.
#   * simulator devices not covered by the rules above — a booted device, or
#     a Shutdown one younger than MAC_SIM_STALE_MAX_AGE_HOURS. `report`
#     surfaces the fat ones and what reclaiming them would cost; the decision
#     for those is the operator's, not this script's.
#   * anything under the operator's home directories (see DENY below).
#   * swap. 8 GiB of `/System/Volumes/VM/swapfile*` lives on the same volume
#     and grew by 3 GiB during the incident. macOS allocates those on demand
#     and keeps them; nothing but a reboot returns them. They are reported,
#     never touched — and they are a large part of why the threshold below is
#     what it is.
#
# THE THRESHOLD
# -------------
# MAC_DISK_MIN_FREE_GIB defaults to 12 GiB, derived from measurement rather
# than chosen:
#
#   per concurrent `ui` shard, measured on this host
#     simulator device data after a full shard   2.4-2.6 GiB  (two samples, the
#                                                             two devices the
#                                                             crashed run leaked)
#     expanded Build/Products from the artifact  ~0.8 GiB
#     .xcresult result bundle                    ~0.1 GiB
#     PostgreSQL data dir + logs                 ~0.1 GiB
#     swap growth attributable to the shard      ~1.5 GiB  (3 new 1 GiB
#                                                           swapfiles appeared
#                                                           during the two
#                                                           crashed shards)
#                                                ---------
#                                                ~5 GiB
#
#   This host has exactly two runners serving the label, so at most two jobs
#   run at once and both can start within seconds of each other:  2 x 5 = 10.
#   Plus a 2 GiB floor so the agent can always write the `_diag` log whose
#   write is what actually crashed it.  ->  12 GiB.
#
# Checked against the incident: the two shards consumed ~10 GiB before the
# volume hit zero, so free space when they started was ~10 GiB. A 12 GiB
# threshold would have refused them, which is the outcome this issue asks for.
#
# WHICH VOLUME IT MEASURES, AND WHY THAT IS CHECKED, NOT ASSUMED
# ---------------------------------------------------------------
# The threshold is only meaningful on the filesystem the job writes to. It
# measures VOLUME (/System/Volumes/Data), and `guard` first proves that every
# path a job writes is on that same filesystem: RUNNER_TEMP (DerivedData and
# build products), RUNNER_WORKSPACE (the checkout), the runner's own `_diag`
# (the write that crashed the agent in #1665) and the CoreSimulator device set.
# If any of them resolves elsewhere - a symlink onto the external
# /Volumes/CIScratch SSD is the realistic way - the job is REFUSED, because a
# guard reading 15 GiB free on the internal disk says nothing about the disk
# the build is filling.
#
# Refused rather than measured-as-well, because on this host such a path is
# broken twice over (measured 2026-11-05):
#   * the runner service cannot read the external drive at all. macOS TCC
#     "Removable Volumes" records the runner's node binary as DENIED, and a
#     launchd-started process gets EPERM on /Volumes/CIScratch while an ssh
#     session is allowed - so every shell-side check looks healthy. On
#     2026-10-21 a DerivedData symlink there wedged this script's own
#     directory walk for 36 minutes per job.
#   * any grant would not survive: the runner self-updates into a new
#     `externals.<version>/` directory, which changes the binary TCC keys on.
# The runners start from launchd at boot, before an external mount is
# guaranteed, too. CI's build data therefore stays on the internal volume, and
# out-of-CI builds over ssh use the SSD instead (scripts/lib/ios-build-data.sh).
# docs/runbooks/mac-ci-runner-disk.md has the layout and the operator options.
#
# MAC_DISK_WARN_FREE_GIB (default 16) is the band where the host still runs but
# is drifting toward the refusal, emitted as a `::warning::` so it is visible
# before it costs anybody a queue cycle.
#
# Both are environment variables on purpose: retuning them is a workflow-level
# decision an operator can make from measurement printed by this script's own
# `report`, without editing code.
#
# USAGE
#   mac-runner-disk-guard.sh report    # measure and print; never fails
#   mac-runner-disk-guard.sh reclaim   # prune CI-owned space; never fails
#   mac-runner-disk-guard.sh guard     # check write paths, report, reclaim, re-measure, then gate
#   mac-runner-disk-guard.sh install-timer # install hourly launchd reclaim
#   mac-runner-disk-guard.sh selftest  # prove the delete guard refuses what it must
#
# `guard` is what CI calls. On a GitHub-hosted runner it prints one line and
# exits 0: the volume is thrown away with the VM, and there is no shared host
# to protect.
#
# `install-timer` is run once by hand on each persistent self-hosted Mac runner,
# from the repository checkout:
#
#   bash scripts/ci/mac-runner-disk-guard.sh install-timer
#
# It installs the per-user `org.llamenos.mac-reclaim` LaunchAgent, which runs
# `reclaim` at login and hourly. The agent invokes the script at THIS checkout
# rather than a copied or pinned script, so re-run `install-timer` if the
# checkout moves. The job-start `guard` stays in place and still refuses to run
# below its disk floor; the timer does not change that threshold.

set -euo pipefail

MODE="${1:-guard}"

VOLUME="${MAC_DISK_GUARD_VOLUME:-/System/Volumes/Data}"
MIN_FREE_GIB="${MAC_DISK_MIN_FREE_GIB:-12}"
WARN_FREE_GIB="${MAC_DISK_WARN_FREE_GIB:-16}"
# Age, never name alone: other PRs' shards run on this host concurrently and
# their devices are also called `ios-e2e-*`, so deleting by name would kill a
# live run. A booted device's directory mtime advances continuously while it
# runs, so an age above the `ui` job's 65-minute cap already proves no job is
# using it; 120 minutes is ~1.8x that cap. (The teardown step this backs up
# used 360, which left a leak sitting on the volume for six hours.)
SIM_MAX_AGE_MIN="${MAC_SIM_MAX_AGE_MIN:-120}"
# The catch-all for devices NOTHING in CI owns (#1861): any device — an Xcode
# default like `iPhone 17`, a hand-made fixture, anything — that has been
# Shutdown and untouched for this long is a leftover, never a fixture worth
# keeping, and reclaim deletes it. The fast path above still reaps CI-named
# devices at 120 minutes; this longer window is only for names the script
# cannot prove are CI's. Booted devices are exempt whatever their age.
STALE_SIM_MAX_AGE_HOURS="${MAC_SIM_STALE_MAX_AGE_HOURS:-24}"
# Measured on this host: 594 agent logs, none older than 7 days, 517 MiB
# across the two serving runners and nothing prunes them. The forensic window
# matters here more than the bytes — #1665 was diagnosed FROM _diag, because
# the crashed jobs uploaded no job log at all — so this is deliberately longer
# than any plausible triage latency rather than as tight as it could be.
DIAG_MAX_AGE_DAYS="${MAC_DIAG_MAX_AGE_DAYS:-5}"
SIM_LOG_MAX_AGE_DAYS="${MAC_SIM_LOG_MAX_AGE_DAYS:-7}"

SIM_DEVICES="$HOME/Library/Developer/CoreSimulator/Devices"
DERIVED_DATA="$HOME/Library/Developer/Xcode/DerivedData"

# Path prefixes this script refuses to delete under, whatever else it is told.
# These include the operator's files, worktrees, Tart VM, and Xcode build state.
# A target is deleted only if it passes BOTH this denylist and the allowlist in
# rm_ci_path, so a future edit has to defeat two checks.
DENY=(
  "$HOME/Pictures"
  "$HOME/projects"
  "$HOME/Documents"
  "$HOME/Desktop"
  "$HOME/Downloads"
  "$HOME/.worktrees"
  "$HOME/.tart/vms"
  "$DERIVED_DATA"
  "$HOME/.ssh"
)

# Parent directories a deletable path must live directly beneath. Anything
# else is a bug in this script, and is reported as one rather than deleted.
ALLOW_PARENTS=(
  "$SIM_DEVICES"
  "$HOME/Library/Developer/CoreSimulator/Caches"
  "$HOME/Library/Logs/CoreSimulator"
  "$DERIVED_DATA"
)

log() { printf '%s\n' "$*"; }

# The incident this file exists for produced no job log at all, so the verdict
# goes somewhere that survives a step nobody expands.
summarize() {
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] || return 0
  printf '### iOS runner disk guard (%s)\n\n%s\n\n' "${RUNNER_NAME:-local}" "$*" \
    >> "$GITHUB_STEP_SUMMARY"
}

free_kib() {
  # `df -k` on the data volume. POSIX output, 4th column is available 1K blocks.
  df_available_kib "$VOLUME"
}

df_available_kib() {
  df -k "$1" | awk 'NR==2 {print $4}'
}

apparent_gib() {
  local kib
  kib="$(du -sk "$1" 2>/dev/null | awk '{print $1}')"
  awk -v k="${kib:-0}" 'BEGIN { printf "%.2f", k / 1048576 }'
}

path_mtime_epoch() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f %m "$1"
  else
    stat -c %Y "$1"
  fi
}

workspace_path_from_plist() {
  local plist="$1"
  if [ -x /usr/libexec/PlistBuddy ]; then
    /usr/libexec/PlistBuddy -c 'Print :WorkspacePath' "$plist" 2>/dev/null
  else
    python3 -c '
import plistlib, sys
with open(sys.argv[1], "rb") as stream:
    value = plistlib.load(stream).get("WorkspacePath")
if not isinstance(value, str) or not value:
    raise SystemExit(1)
print(value)
' "$plist" 2>/dev/null
  fi
}

free_gib() {
  awk -v k="$(free_kib)" 'BEGIN { printf "%.1f", k / 1048576 }'
}

# Deletes one path, but only after proving it is a CI-owned leaf under an
# allowed parent. Fails closed and loudly: a refusal here means this script
# was asked to delete something it has no business deleting, which is a defect
# worth seeing rather than silently skipping.
# Exit status: 0 deleted, 2 nothing to delete, 1 refused (a defect in this
# script's own target selection, deliberately fatal rather than skipped).
rm_ci_path() {
  local target="$1" parent allowed ok=0 deny
  [ -n "$target" ] || return 2

  # Policy is checked BEFORE the filesystem, so a protected target is refused
  # whether or not it currently exists. The refusal is a property of the path,
  # not of what happens to be sitting there when this runs.
  for deny in "${DENY[@]}"; do
    case "$target" in
      "$deny"|"$deny"/*)
        # DerivedData is protected except for its direct child directories;
        # the ALLOW_PARENTS check below still rejects every other descendant.
        if [ "$deny" = "$DERIVED_DATA" ] &&
           [ "$(dirname "$target")" = "$DERIVED_DATA" ] &&
           [ "$target" != "$DERIVED_DATA" ]; then
          continue
        fi
        log "::error::mac-runner-disk-guard REFUSED to delete '$target': it is under the protected path '$deny'. This is a bug in this script, not a disk problem."
        return 1
        ;;
    esac
  done

  parent="$(dirname "$target")"
  for allowed in "${ALLOW_PARENTS[@]}"; do
    [ "$parent" = "$allowed" ] && ok=1 && break
  done
  if [ "$ok" != "1" ]; then
    log "::error::mac-runner-disk-guard REFUSED to delete '$target': '$parent' is not one of the CI-owned parents this script may prune."
    return 1
  fi

  [ -e "$target" ] || return 2
  rm -rf "$target"
}

# prune <path> <message> — delete a CI-owned path and say so. A refusal from
# rm_ci_path means this script targeted something it must not, which is a
# defect: it aborts rather than continuing quietly.
prune() {
  local rc=0
  rm_ci_path "$1" || rc=$?
  case "$rc" in
    0) log "  $2"; deleted_any=1 ;;
    2) : ;;
    *) exit 1 ;;
  esac
}

# ── report ──────────────────────────────────────────────────────────────────

report() {
  log "── disk ──"
  df -h "$VOLUME" || true
  log ""
  log "free on $VOLUME: $(free_gib) GiB   (refuse below ${MIN_FREE_GIB} GiB, warn below ${WARN_FREE_GIB} GiB)"
  log ""

  # Swap is on this same volume, grows on demand and is never given back
  # without a reboot. It is a disk consumer that no amount of deleting fixes,
  # which is why it is reported next to free space rather than buried.
  log "── swap (same volume; reclaimable only by reboot) ──"
  sysctl -n vm.swapusage 2>/dev/null || true
  if [ -d /System/Volumes/VM ]; then
    log "swapfiles: $(find /System/Volumes/VM -maxdepth 1 -name 'swapfile*' 2>/dev/null | wc -l | tr -d ' ')"
  fi
  log ""

  log "── simulator devices (name, size, age, booted) ──"
  if [ -d "$SIM_DEVICES" ]; then
    local dir udid name size_kib age_min booted booted_list
    # A device left booted by a job that died is a live launchd_sim/backboardd
    # process tree, not just bytes: it holds RAM, which drives this 16 GiB host
    # into swap, and swap is allocated on this same volume. Both devices the
    # crashed run leaked were still booted an hour later.
    booted_list="$(xcrun simctl list devices booted 2>/dev/null || true)"
    for dir in "$SIM_DEVICES"/*/; do
      [ -e "$dir/device.plist" ] || continue
      dir="${dir%/}"
      udid="$(basename "$dir")"
      name="$(/usr/libexec/PlistBuddy -c 'Print :name' "$dir/device.plist" 2>/dev/null || echo '?')"
      size_kib="$(du -sk "$dir" 2>/dev/null | awk '{print $1}')"
      age_min=$(( ( $(date +%s) - $(stat -f %m "$dir" 2>/dev/null || date +%s) ) / 60 ))
      booted=""
      case "$booted_list" in *"$udid"*) booted="BOOTED" ;; esac
      awk -v s="${size_kib:-0}" -v a="$age_min" -v n="$name" -v u="$udid" -v b="$booted" \
        'BEGIN { printf "  %7.2f GiB  %6d min  %-7s %-32s %s\n", s/1048576, a, b, n, u }'
    done | sort -rn
  fi
  log ""

  log "── runner agent _diag (the directory whose write crashed the agent) ──"
  du -sh "$HOME"/actions-runner-*/_diag 2>/dev/null || true
  log ""

  log "── Xcode DerivedData (apparent sizes; df below, not du, measures reclaimed space) ──"
  if [ -d "$DERIVED_DATA" ]; then
    local dir plist workspace age_min apparent mtime
    for dir in "$DERIVED_DATA"/*/; do
      [ -d "$dir" ] || continue
      dir="${dir%/}"
      plist="$dir/info.plist"
      apparent="$(apparent_gib "$dir")"
      if [ ! -e "$plist" ]; then
        log "  ${apparent} GiB apparent  $(basename "$dir"): skipped (missing info.plist)"
      elif ! workspace="$(workspace_path_from_plist "$plist")"; then
        log "  ${apparent} GiB apparent  $(basename "$dir"): skipped (unreadable/unparseable info.plist or missing WorkspacePath)"
      elif [ -e "$workspace" ]; then
        log "  ${apparent} GiB apparent  $(basename "$dir"): retained (WorkspacePath exists: $workspace)"
      elif ! mtime="$(path_mtime_epoch "$dir" 2>/dev/null)"; then
        log "  ${apparent} GiB apparent  $(basename "$dir"): retained (could not determine modification time)"
      else
        age_min=$(( ($(date +%s) - mtime) / 60 ))
        if [ "$age_min" -lt 60 ]; then
          log "  ${apparent} GiB apparent  $(basename "$dir"): retained (modified ${age_min} min ago; needs 60 min)"
        else
          log "  ${apparent} GiB apparent  $(basename "$dir"): orphan candidate (WorkspacePath missing; reclaim checks run during reclaim)"
        fi
      fi
    done
  fi
  log ""
}

# ── reclaim ─────────────────────────────────────────────────────────────────

reclaim() {
  local before after freed deleted_any=0
  before="$(free_kib)"

  log "── reclaim ──"

  # 1. Simulator devices CI created and never deleted, because the job that
  #    owned them was cancelled or its agent crashed. Named by a CI job
  #    (`ios-e2e-<run>-<attempt>-shard<n>` from the ui shards, or
  #    `ios-build-test-<run>-<attempt>` from ios-build-test) AND older than
  #    any job cap, so a live job's device can never match.
  if [ -d "$SIM_DEVICES" ]; then
    local dir udid name
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      udid="$(basename "$dir")"
      name="$(/usr/libexec/PlistBuddy -c 'Print :name' "$dir/device.plist" 2>/dev/null || echo '')"
      case "$name" in
        ios-e2e-*|ios-build-test-*)
          # Shut down first: a device leaked by a crashed agent is still a
          # running launchd_sim tree holding RAM on a 16 GiB host, and the swap
          # that costs lives on the volume we are trying to free. `delete`
          # alone would do it, but doing it explicitly makes the log say so.
          xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
          # simctl first so CoreSimulator forgets the device; the directory
          # removal is the fallback for a device simctl no longer knows about.
          if xcrun simctl delete "$udid" >/dev/null 2>&1; then
            log "  shut down and deleted leaked CI simulator: $name ($udid)"
            deleted_any=1
          else
            prune "$dir" "removed orphaned CI simulator directory: $name ($udid)"
            deleted_any=1
          fi
          ;;
      esac
    done < <(find "$SIM_DEVICES" -maxdepth 1 -type d -mmin "+${SIM_MAX_AGE_MIN}" \
               -exec test -e '{}/device.plist' ';' -print 2>/dev/null || true)
  fi

  # 1b. The #1861 gap: devices NOTHING in CI owns. A destination selected by
  #     name (`-destination 'platform=iOS Simulator,name=iPhone 17'`) uses or
  #     creates an Xcode-default device that no job names, no teardown
  #     deletes, and the pass above cannot match — the one that triggered
  #     #1861 sat Shutdown for 61 hours holding 3.86 GiB while this script
  #     reported "nothing CI-owned left to reclaim". Any device Shutdown and
  #     untouched past MAC_SIM_STALE_MAX_AGE_HOURS is a leftover regardless of
  #     name. Booted devices are exempt at any age: booted means a live
  #     launchd_sim tree somebody is using right now.
  if [ -d "$SIM_DEVICES" ]; then
    local dir udid name booted_list stale_min
    stale_min=$(( STALE_SIM_MAX_AGE_HOURS * 60 ))
    booted_list="$(xcrun simctl list devices booted 2>/dev/null || true)"
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      udid="$(basename "$dir")"
      name="$(/usr/libexec/PlistBuddy -c 'Print :name' "$dir/device.plist" 2>/dev/null || echo '')"
      case "$name" in
        # Handled by the faster pass above; whatever survived it is younger
        # than the stale window by construction.
        ios-e2e-*|ios-build-test-*) continue ;;
      esac
      case "$booted_list" in
        *"$udid"*)
          log "  retained stale simulator (BOOTED — in use, never reclaimed): $name ($udid)"
          continue
          ;;
      esac
      if xcrun simctl delete "$udid" >/dev/null 2>&1; then
        log "  deleted stale Shutdown simulator: $name ($udid, idle > ${STALE_SIM_MAX_AGE_HOURS}h)"
        deleted_any=1
      else
        # simctl no longer knows the device; the directory is an orphan.
        prune "$dir" "removed orphaned stale simulator directory: $name ($udid)"
        deleted_any=1
      fi
    done < <(find "$SIM_DEVICES" -maxdepth 1 -type d -mmin "+${stale_min}" \
               -exec test -e '{}/device.plist' ';' -print 2>/dev/null || true)
  fi

  # 2. Devices the installed Xcode can no longer run (a runtime was removed by
  #    an Xcode upgrade). Always safe: nothing can boot them.
  if xcrun simctl delete unavailable >/dev/null 2>&1; then
    log "  deleted unavailable simulator devices"
  fi

  # 3. CoreSimulator's own caches and machine-generated logs. Regenerated on
  #    demand; nothing reads an old one.
  local p
  for p in "$HOME/Library/Developer/CoreSimulator/Caches"/*; do
    [ -e "$p" ] || continue
    prune "$p" "pruned CoreSimulator cache: $(basename "$p")"
  done
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    prune "$p" "pruned stale CoreSimulator log: $(basename "$p")"
  done < <(find "$HOME/Library/Logs/CoreSimulator" -maxdepth 1 -mindepth 1 \
             -mtime "+${SIM_LOG_MAX_AGE_DAYS}" -print 2>/dev/null || true)

  # 4. Xcode caches for worktrees that no longer exist. CI uses RUNNER_TEMP,
  #    so only an old cache whose own plist proves its workspace is gone is
  #    eligible. rm_ci_path applies both the denylist and direct-parent allowlist.
  reclaim_derived_data "$DERIVED_DATA"

  # 5. The runner agents' own `_diag` logs. Pruned by age so the file the live
  #    agent is writing is never a candidate, and across every runner install
  #    on the host because they share the one volume — which is exactly why
  #    both agents died in the same second. Not routed through rm_ci_path:
  #    these are files under a runner install rather than leaves of a CI-owned
  #    parent, so the name pattern and age bound are the proof instead.
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    rm -f "$p" && { log "  pruned stale runner log: ${p#"$HOME"/}"; deleted_any=1; }
  done < <(find "$HOME"/actions-runner-*/_diag -maxdepth 1 -type f \
             \( -name '*.log' -o -name '*.log.*' \) -mtime "+${DIAG_MAX_AGE_DAYS}" \
             -print 2>/dev/null || true)

  # APFS reclaims asynchronously (#1861): `df` read immediately after
  # `simctl delete` still reports the OLD figure, so a reclaim that measures
  # itself straight away concludes it freed nothing — and `guard`'s gate then
  # refuses on the stale number even though GiBs were just deleted. Give the
  # filesystem a moment to catch up before either consumer reads free space.
  if [ "$deleted_any" -gt 0 ]; then
    sleep "${MAC_DISK_RECLAIM_SETTLE_SEC:-10}"
  fi

  after="$(free_kib)"
  freed=$(awk -v a="$after" -v b="$before" 'BEGIN { printf "%.2f", (a - b) / 1048576 }')
  if awk -v f="$freed" 'BEGIN { exit !(f > 0) }'; then
    log "  reclaimed ${freed} GiB (free: $(awk -v k="$before" 'BEGIN{printf "%.1f", k/1048576}') -> $(free_gib) GiB)"
  elif [ "$deleted_any" -gt 0 ]; then
    # Deletions DID happen; the flat delta is the APFS lag above (or other
    # activity on this shared host consumed the space as fast as we freed
    # it). Saying "nothing left to reclaim" here is how #1861's report read
    # while a 3.86 GiB device sat deleted-but-unmeasured.
    log "  deletions issued; df shows no delta yet — APFS reclaims asynchronously, the space appears on a later read (free: $(awk -v k="$before" 'BEGIN{printf "%.1f", k/1048576}') -> $(free_gib) GiB)"
  else
    # Free space is a live number on a shared host; a non-positive delta means
    # there was nothing of CI's left to take, not that reclaim failed.
    log "  nothing CI-owned left to reclaim (free: $(awk -v k="$before" 'BEGIN{printf "%.1f", k/1048576}') -> $(free_gib) GiB; other activity on this host moves this number)"
  fi
  log ""
}

# Remove only old DerivedData entries with a parseable plist naming a workspace
# that no longer exists. Keep apparent size informational; df deltas are the
# only measurement of actual reclaimed capacity, especially on APFS clones.
reclaim_derived_data() {
  local data_root="${1:-$DERIVED_DATA}" dir plist workspace mtime age_min before after freed apparent rc
  [ -d "$data_root" ] || return 0

  for dir in "$data_root"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    plist="$dir/info.plist"
    apparent="$(apparent_gib "$dir")"
    if [ ! -e "$plist" ]; then
      log "  retained DerivedData $(basename "$dir") (${apparent} GiB apparent): missing info.plist"
      continue
    fi
    if ! workspace="$(workspace_path_from_plist "$plist")"; then
      log "  retained DerivedData $(basename "$dir") (${apparent} GiB apparent): info.plist unreadable/unparseable or WorkspacePath missing"
      continue
    fi
    if [ -e "$workspace" ]; then
      log "  retained DerivedData $(basename "$dir") (${apparent} GiB apparent): WorkspacePath exists ($workspace)"
      continue
    fi

    mtime="$(path_mtime_epoch "$dir" 2>/dev/null)" || {
      log "  retained DerivedData $(basename "$dir") (${apparent} GiB apparent): could not determine modification time"
      continue
    }
    age_min=$(( ($(date +%s) - mtime) / 60 ))
    if [ "$age_min" -lt 60 ]; then
      log "  retained DerivedData $(basename "$dir") (${apparent} GiB apparent): modified ${age_min} min ago; needs 60 min"
      continue
    fi

    before="$(df_available_kib "$dir")"
    rc=0
    rm_ci_path "$dir" || rc=$?
    case "$rc" in
      0)
        after="$(df_available_kib "$data_root")"
        freed="$(awk -v a="$after" -v b="$before" 'BEGIN { printf "%.2f", (a - b) / 1048576 }')"
        deleted_any=1
        log "  removed orphaned DerivedData $(basename "$dir") (WorkspacePath missing; ${age_min} min old); df available: $(awk -v k="$before" 'BEGIN{printf "%.2f", k/1048576}') -> $(awk -v k="$after" 'BEGIN{printf "%.2f", k/1048576}') GiB (delta ${freed} GiB)"
        ;;
      2) : ;;
      *) exit 1 ;;
    esac
  done
}

# ── write paths ─────────────────────────────────────────────────────────────

# Mount point of the filesystem holding an existing path (follows symlinks, so
# a symlinked directory reports where its data really goes). Mount points may
# contain spaces: join every field from the 6th on. Empty when df cannot stat
# the path, which on this host is what TCC's EPERM looks like.
mount_point_of() {
  df -P "$1" 2>/dev/null | awk 'NR==2 { s=$6; for (i=7; i<=NF; i++) s = s " " $i; print s }'
}

# Prints the marker line `write paths OK:` on success; the workflow's watchdog
# fallback looks for it, so a hang INSIDE this check is a refusal, not a pass.
check_write_paths() {
  local want entry label path mp bad=0 runner_root
  local -a paths
  want="$(mount_point_of "$VOLUME")"
  if [ -z "$want" ]; then
    log "::error::ios runner REFUSED to run: disk-guard cannot read the filesystem of ${VOLUME}, the volume it measures. THIS IS NOT A TEST FAILURE AND NOT THIS PR'S FAULT."
    return 1
  fi

  paths=("CoreSimulator device set|$SIM_DEVICES")
  if [ -n "${RUNNER_TEMP:-}" ]; then
    paths+=("RUNNER_TEMP (DerivedData, build products)|$RUNNER_TEMP")
  fi
  if [ -n "${RUNNER_WORKSPACE:-}" ]; then
    paths+=("RUNNER_WORKSPACE (checkout)|$RUNNER_WORKSPACE")
    runner_root="${RUNNER_WORKSPACE%%/_work/*}"
    if [ "$runner_root" != "$RUNNER_WORKSPACE" ]; then
      paths+=("runner _diag (the agent's own log)|$runner_root/_diag")
    fi
  fi

  log "── write paths (must be on ${want}, the volume this guard measures) ──"
  for entry in "${paths[@]}"; do
    label="${entry%%|*}"
    path="${entry#*|}"
    if [ ! -e "$path" ] && [ ! -L "$path" ]; then
      log "  absent, nothing to check: $label ($path)"
      continue
    fi
    # Printed BEFORE the df, so a df that blocks on an unreadable volume
    # leaves the path it blocked on as the last line of the log.
    log "  checking: $label ($path)"
    mp="$(mount_point_of "$path")"
    if [ -z "$mp" ]; then
      log "::error::ios runner REFUSED to run: disk-guard-wrong-volume — $label ($path) is on a filesystem this runner cannot even stat. On this host that is macOS TCC 'Removable Volumes' denying the runner service access to an external drive (a symlink onto /Volumes/CIScratch is the usual cause). THIS IS NOT A TEST FAILURE AND NOT THIS PR'S FAULT. CI build data must stay on ${want}; see docs/runbooks/mac-ci-runner-disk.md."
      bad=1
    elif [ "$mp" != "$want" ]; then
      log "::error::ios runner REFUSED to run: disk-guard-wrong-volume — $label ($path) is on ${mp}, but this guard's ${MIN_FREE_GIB} GiB floor measures ${want}, so its verdict would say nothing about the disk this job fills. THIS IS NOT A TEST FAILURE AND NOT THIS PR'S FAULT. The runner service cannot use an external drive (TCC 'Removable Volumes'; launchd starts it before external mounts), so move that path back onto ${want}; see docs/runbooks/mac-ci-runner-disk.md."
      bad=1
    else
      log "  ok: on $mp"
    fi
  done
  [ "$bad" -eq 0 ] || return 1
  log "write paths OK: every path this job writes is on ${want}"
  log ""
}

# ── gate ────────────────────────────────────────────────────────────────────

gate() {
  local free; free="$(free_gib)"

  if awk -v f="$free" -v m="$MIN_FREE_GIB" 'BEGIN { exit !(f < m) }'; then
    log "::error::ios runner REFUSED to run: disk-headroom — only ${free} GiB free on ${VOLUME} of the ${MIN_FREE_GIB} GiB this job needs. THIS IS NOT A TEST FAILURE AND NOT THIS PR'S FAULT. Two concurrent iOS shards consume ~10 GiB of simulator data, build products and swap on this host; below ${MIN_FREE_GIB} GiB the runner AGENT runs out of space writing its own _diag log and dies mid-step, which uploads no job log at all and ejects whatever PR is in the merge queue with no attributable cause (#1665). Refusing here instead. To fix: free space on the runner host — 'scripts/ci/mac-runner-disk-guard.sh report' prints every consumer and what reclaiming it would cost."
    cat <<EOF

The reclaim above already removed everything this script can prove is CI's.
What is left needs a human, because it is not CI's to delete. In rough order
of size on this host, and read the script header before touching any of them:

  * simulator devices that are booted, or Shutdown but younger than
    ${STALE_SIM_MAX_AGE_HOURS}h (the report above lists every device with
    sizes; the stale ones are already reclaimed by the pass above).
    'xcrun simctl erase <udid>' reclaims a device's data without deleting
    the device, which is usually what you want for an Xcode default.
  * ~/Library/Developer/Xcode/DerivedData — the operator's incremental build
    state, NOT CI's. Reclaim removes only entries whose info.plist names a
    WorkspacePath that no longer exists and whose directory is at least 60
    minutes old. The report above names anything retained and why; apparent
    directory sizes are informational, while df deltas measure actual space.
  * /System/Volumes/VM/swapfile* — grows on demand, returned only by a reboot.

EOF
    return 1
  fi

  if awk -v f="$free" -v w="$WARN_FREE_GIB" 'BEGIN { exit !(f < w) }'; then
    log "::warning::ios runner disk headroom is low: ${free} GiB free on ${VOLUME}, above the ${MIN_FREE_GIB} GiB refusal threshold but below the ${WARN_FREE_GIB} GiB comfort band. Two concurrent shards can consume ~10 GiB. Reclaim space on the host before this becomes a refusal (#1665)."
  fi

  log "disk headroom OK: ${free} GiB free on ${VOLUME} (need ${MIN_FREE_GIB} GiB)"
}

# ── selftest ────────────────────────────────────────────────────────────────
#
# Audits the delete guard by trying to BREAK it, which is the only way to know
# it holds (`feedback_audit_gates_by_breaking`). Reading the DENY array proves
# nothing; asking rm_ci_path to delete the operator's home directory and
# watching it refuse does. Run it on the host after any change to this file.

selftest() {
  local sandbox rc fails=0 original_derived_data before_kib after_kib reclaim_output
  sandbox="$(mktemp -d "${TMPDIR:-/tmp}/disk-guard-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$sandbox'" EXIT

  # Point the deny/allow policy at the sandbox so the real DerivedData
  # exception and reclaim path are exercised without touching the host cache.
  original_derived_data="$DERIVED_DATA"
  DERIVED_DATA="$sandbox/DerivedData"
  local -a test_deny=("${DENY[@]}") test_allow=("${ALLOW_PARENTS[@]}")
  local entry
  test_deny+=("$DERIVED_DATA")
  DENY=("${test_deny[@]}")
  test_allow+=("$sandbox/sim-devices" "$sandbox/sim-caches" "$sandbox/sim-logs")
  test_allow+=("$DERIVED_DATA")
  ALLOW_PARENTS=("${test_allow[@]}")
  mkdir -p "$DERIVED_DATA" "$sandbox/sim-devices" "$sandbox/sim-caches" "$sandbox/sim-logs"

  check() { # check <label> <expected-rc> <path>
    local label="$1" want="$2" path="$3" got=0
    rm_ci_path "$path" >/dev/null 2>&1 || got=$?
    if [ "$got" = "$want" ]; then
      log "  ok    $label (rc=$got)"
    else
      log "  FAIL  $label: expected rc=$want, got rc=$got for '$path'"
      fails=$((fails + 1))
    fi
  }

  log "── selftest: the deletions this script must refuse ──"

  # Every protected prefix, refused even as a path that does not exist — the
  # policy must not depend on what is on disk at the time.
  local deny
  for deny in "${DENY[@]}"; do
    if [ "$deny" = "$DERIVED_DATA" ]; then
      check "refuses nested path under DerivedData" 1 "$deny/nested/selftest-should-never-be-touched"
    else
      check "refuses under $(basename "$deny")" 1 "$deny/selftest-should-never-be-touched"
    fi
    check "refuses the protected root itself ($(basename "$deny"))" 1 "$deny"
  done
  check "refuses the host DerivedData root" 1 "$original_derived_data"

  # A real file somewhere plausible but not CI-owned.
  : > "$sandbox/decoy"
  check "refuses a file outside every CI-owned parent" 1 "$sandbox/decoy"
  if [ ! -e "$sandbox/decoy" ]; then
    log "  FAIL  the refused decoy was deleted anyway"
    fails=$((fails + 1))
  else
    log "  ok    the refused decoy is still on disk"
  fi

  log "── selftest: the deletions it must allow ──"
  local allowed_parent leaf
  for allowed_parent in "$sandbox/sim-devices" "$sandbox/sim-caches" "$sandbox/sim-logs" "$DERIVED_DATA"; do
    check "nothing to do for absent CI-owned leaf under $(basename "$allowed_parent")" 2 "$allowed_parent/selftest-absent"
    leaf="$allowed_parent/selftest-leaf"
    : > "$leaf"
    check "deletes CI-owned leaf under $(basename "$allowed_parent")" 0 "$leaf"
    if [ -e "$leaf" ]; then
      log "  FAIL  the allowed leaf survived under '$allowed_parent'"
      rm -f "$leaf"
      fails=$((fails + 1))
    fi
  done

  log "── selftest: DerivedData safety predicates ──"
  local orphan="$DERIVED_DATA/orphan" live="$DERIVED_DATA/live" missing="$DERIVED_DATA/missing-plist"
  local malformed="$DERIVED_DATA/malformed-plist" fresh="$DERIVED_DATA/fresh"
  mkdir -p "$orphan" "$live" "$missing" "$malformed" "$fresh" "$sandbox/live-workspace"
  cat > "$orphan/info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>WorkspacePath</key><string>$sandbox/gone-workspace</string></dict></plist>
EOF
  cat > "$live/info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>WorkspacePath</key><string>$sandbox/live-workspace</string></dict></plist>
EOF
  cat > "$malformed/info.plist" <<'EOF'
this is not a property list
EOF
  cat > "$fresh/info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>WorkspacePath</key><string>$sandbox/also-gone</string></dict></plist>
EOF
  # Use allocated random data so df can prove actual free-space movement. du is
  # informational only; APFS clones can make its apparent size misleading.
  dd if=/dev/urandom of="$orphan/payload" bs=1048576 count=64 2>/dev/null
  touch -t 202001010000 "$orphan"
  before_kib="$(df_available_kib "$sandbox")"
  reclaim_output="$(reclaim_derived_data "$DERIVED_DATA")"
  after_kib="$(df_available_kib "$sandbox")"
  log "$reclaim_output"
  if [ ! -e "$orphan" ]; then
    log "  ok    orphaned DerivedData was removed"
  else
    log "  FAIL  orphaned DerivedData survived"
    fails=$((fails + 1))
  fi
  if awk -v before="$before_kib" -v after="$after_kib" 'BEGIN { exit !(after > before) }'; then
    log "  ok    df available increased: $(awk -v k="$before_kib" 'BEGIN{printf "%.2f", k/1048576}') -> $(awk -v k="$after_kib" 'BEGIN{printf "%.2f", k/1048576}') GiB"
  else
    log "  FAIL  df did not show space returned: ${before_kib} KiB -> ${after_kib} KiB"
    fails=$((fails + 1))
  fi
  for leaf in "$live" "$missing" "$malformed" "$fresh"; do
    if [ -d "$leaf" ]; then
      log "  ok    retained $(basename "$leaf")"
    else
      log "  FAIL  unsafe DerivedData entry was removed: $leaf"
      fails=$((fails + 1))
    fi
  done
  for entry in \
    "live|WorkspacePath exists" \
    "missing-plist|missing info.plist" \
    "malformed-plist|unreadable/unparseable" \
    "fresh|modified"; do
    local report_name="${entry%%|*}" report_reason="${entry#*|}"
    if [[ "$reclaim_output" == *"DerivedData $report_name ("*"$report_reason"* ]]; then
      log "  ok    report names skip reason: $report_name ($report_reason)"
    else
      log "  FAIL  report omitted skip reason: $report_name ($report_reason)"
      fails=$((fails + 1))
    fi
  done

  log "── selftest: write paths must be on the measured volume ──"
  # /dev is its own filesystem (devfs on macOS, devtmpfs on Linux) on every
  # host this runs on, so it stands in for "a path on another disk" without
  # needing a mount. Subshells keep the overrides from leaking.
  mkdir -p "$sandbox/write-same"
  if ( VOLUME="$sandbox"; SIM_DEVICES="$sandbox/write-same"; RUNNER_TEMP="$sandbox/write-same"; RUNNER_WORKSPACE=""
       check_write_paths ) >/dev/null 2>&1; then
    log "  ok    accepts write paths on the measured volume"
  else
    log "  FAIL  refused write paths that are on the measured volume"
    fails=$((fails + 1))
  fi
  if ( VOLUME="$sandbox"; SIM_DEVICES="$sandbox/write-same"; RUNNER_TEMP="/dev"; RUNNER_WORKSPACE=""
       check_write_paths ) >/dev/null 2>&1; then
    log "  FAIL  accepted RUNNER_TEMP on a different filesystem from the measured volume"
    fails=$((fails + 1))
  else
    log "  ok    refuses RUNNER_TEMP on a different filesystem"
  fi
  ln -s /dev "$sandbox/write-symlink"
  if ( VOLUME="$sandbox"; SIM_DEVICES="$sandbox/write-symlink"; RUNNER_TEMP=""; RUNNER_WORKSPACE=""
       check_write_paths ) >/dev/null 2>&1; then
    log "  FAIL  accepted a device set SYMLINKED onto a different filesystem"
    fails=$((fails + 1))
  else
    log "  ok    refuses a write path symlinked onto a different filesystem"
  fi
  ln -s "$sandbox/does-not-exist" "$sandbox/write-dangling"
  if ( VOLUME="$sandbox"; SIM_DEVICES="$sandbox/write-dangling"; RUNNER_TEMP=""; RUNNER_WORKSPACE=""
       check_write_paths ) >/dev/null 2>&1; then
    log "  FAIL  accepted a DANGLING symlink as a write path (an unmounted drive looks like this)"
    fails=$((fails + 1))
  else
    log "  ok    refuses a dangling symlink (what an unmounted drive leaves behind)"
  fi

  log ""
  if [ "$fails" -ne 0 ]; then
    log "::error::mac-runner-disk-guard selftest FAILED: $fails case(s). Do not ship this script."
    return 1
  fi
  log "selftest passed: every protected path refused, every CI-owned path handled"
}

install_timer() {
  local launch_agents="$HOME/Library/LaunchAgents"
  local plist="$launch_agents/org.llamenos.mac-reclaim.plist"
  local script_dir repo_root script_path log_dir stdout_path stderr_path domain
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || {
    log "::error::install-timer must be run from a Git checkout."
    return 1
  }
  script_path="$repo_root/scripts/ci/mac-runner-disk-guard.sh"
  if [ ! -f "$script_path" ]; then
    log "::error::install-timer could not find the disk guard at '$script_path'."
    return 1
  fi
  log_dir="$HOME/Library/Logs"
  stdout_path="$log_dir/org.llamenos.mac-reclaim.log"
  stderr_path="$log_dir/org.llamenos.mac-reclaim.err"
  domain="gui/$(id -u)"
  mkdir -p "$launch_agents" "$log_dir"
  launchctl bootout "$domain/org.llamenos.mac-reclaim" >/dev/null 2>&1 || true

  local script_xml stdout_xml stderr_xml
  script_xml="$(printf '%s' "$script_path" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
  stdout_xml="$(printf '%s' "$stdout_path" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
  stderr_xml="$(printf '%s' "$stderr_path" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
  umask 077
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>org.llamenos.mac-reclaim</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$script_xml</string><string>reclaim</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>$stdout_xml</string>
  <key>StandardErrorPath</key><string>$stderr_xml</string>
</dict>
</plist>
EOF
  chmod 600 "$plist"
  launchctl bootstrap "$domain" "$plist"
  log "Installed hourly DerivedData and CI-cache reclaim: $plist"
  log "The LaunchAgent executes the checked-out script at: $script_path"
}

# ── main ────────────────────────────────────────────────────────────────────

if [ "$MODE" = "selftest" ]; then
  selftest
  exit $?
fi

if [ "$(uname -s)" != "Darwin" ]; then
  log "::error::mac-runner-disk-guard.sh is for the self-hosted macOS runners; this host is $(uname -s)."
  exit 1
fi

# A GitHub-hosted macOS runner is a fresh VM that is destroyed after the job.
# There is no shared volume to protect and nothing of anybody's to delete.
if [ "${RUNNER_ENVIRONMENT:-self-hosted}" = "github-hosted" ]; then
  log "GitHub-hosted runner — disk guard not applicable (ephemeral VM, nothing shared). free: $(free_gib) GiB"
  exit 0
fi

case "$MODE" in
  report)   report ;;
  reclaim)  reclaim ;;
  install-timer) install_timer ;;
  guard)
    # First, and before anything that walks a directory: if a write path is on
    # an unreadable volume, report/reclaim would wedge on it (2026-10-21).
    if ! check_write_paths; then
      summarize "REFUSED: a path this job writes is not on ${VOLUME}, the volume the disk floor measures. Environmental, not this PR."
      exit 1
    fi
    report
    reclaim
    if gate; then
      summarize "disk headroom OK — $(free_gib) GiB free (need ${MIN_FREE_GIB} GiB)"
    else
      summarize "REFUSED: only $(free_gib) GiB free, need ${MIN_FREE_GIB} GiB. Environmental, not this PR (#1665)."
      exit 1
    fi
    ;;
  *)
    log "usage: $(basename "$0") <report|reclaim|guard|install-timer|selftest>"
    exit 2
    ;;
esac
