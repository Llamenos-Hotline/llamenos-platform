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
#   * `com.apple.CoreSimulator.SimDevice.<UDID>` runtime directories in
#     /private/var/tmp that no simulator owns (#2644). `simctl delete`
#     removes the device but not this ~3 MB launchd_sim directory, so every
#     boot-and-delete leaked one: 2,040 of them held 6 GiB and put the host
#     150 MB under the floor for seven hours. Ownership is "the UDID is in no
#     `simctl list devices` line" + the runner account's own + older than
#     MAC_SIM_TMP_MAX_AGE_MIN (default: the simulator age floor). A live or
#     Shutdown device keeps its directory; an unanswered `simctl list`
#     removes nothing. Job teardown now removes the directory itself
#     (`delete-sim`), so the sweep is the backstop, not the mechanism. Also
#     `XCTestTesting.*.spindump*` captures older than a day. Nothing else in
#     /private/var/tmp is touched (rm_ci_path enforces the two name shapes);
#     the thousands of `com.apple.launchd.*` entries there are tiny, belong
#     to no CI step, and are reported only.
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
#   * `~/Library/Developer/Xcode/DerivedData` — the SHARED per-user root. CI's
#     own build jobs never write here (both pass `-derivedDataPath
#     "$RUNNER_TEMP/llamenos-build"` and delete it themselves), but an
#     operator's Xcode session and ssh-driven builds do. Ownership is proved by
#     the entry's info.plist: only one whose WorkspacePath is gone and which has
#     been idle for 60 minutes is reclaimed. The single plist-less exception is
#     a `Llamenos-<hash>` entry holding nothing but run output (#2530: 60 of
#     them, 0.1 GiB each, were measured and none held compiled products).
#     Live, recent and uninspectable entries are retained and reported.
#   * a DerivedData root INSIDE a runner's install tree
#     (`~/actions-runner-*/_work/DerivedData`) is the opposite case: only that
#     runner's jobs write there, so an idle entry is CI's by location and is
#     reclaimed whether or not Xcode finished writing its info.plist. See
#     "DerivedData ownership" below for the classifier both modes share.
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
#   mac-runner-disk-guard.sh delete-sim <udid> # job teardown: shutdown + delete + its /private/var/tmp dir; never fails
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
# Where CoreSimulator keeps each booted device's launchd_sim runtime directory
# (`com.apple.CoreSimulator.SimDevice.<UDID>`: launchd.log, disabled.plist, a
# socket; ~3 MB each) and where XCTest drops its spindumps. `simctl delete`
# removes the device under $SIM_DEVICES but NOT this directory, so every
# simulator a job boots and deletes leaves one behind (#2644: 2,040 of them,
# 6 GiB, took the host under the 12 GiB floor and stalled every merge group
# for seven hours). Overridable so the selftest can point it at a sandbox.
SIM_TMP_ROOT="${MAC_SIM_TMP_ROOT:-/private/var/tmp}"
# Age floor for a SimDevice directory that no simulator owns any more. The
# ownership proof is "no device in `simctl list devices` carries this UDID";
# the age is the second lock, so a directory created between that listing and
# the delete is never a candidate.
SIM_TMP_MAX_AGE_MIN="${MAC_SIM_TMP_MAX_AGE_MIN:-$SIM_MAX_AGE_MIN}"
# XCTest's `XCTestTesting.<ts>.spindump*` captures are forensic leftovers from
# a hung test run; a day is longer than any triage that wants them.
SIM_TMP_SPINDUMP_MAX_AGE_HOURS="${MAC_SIM_TMP_SPINDUMP_MAX_AGE_HOURS:-24}"
DERIVED_DATA="$HOME/Library/Developer/Xcode/DerivedData"
# A DerivedData root inside a runner's own install tree (#2530). Nobody but the
# CI jobs of that runner writes under `_work`, so an entry here is CI's because
# of WHERE it is: the proof cannot be an info.plist, which is the very file a
# build interrupted early never got to write. A glob, matched with `case`, and
# overridable so the selftest can point it at a sandbox.
RUNNER_DD_GLOB="${MAC_RUNNER_DD_GLOB:-$HOME/actions-runner-*/_work/DerivedData}"
# A directory nothing has written to for this long is not a live build. 60 min
# is the figure the plist rule already used.
DD_IDLE_MIN=60

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
  # NAME-restricted by rm_ci_path: the system temp dir is shared with every
  # other process on the host, so being under it proves nothing.
  "$SIM_TMP_ROOT"
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

# The only names this script may remove from $SIM_TMP_ROOT.
sim_tmp_name_ok() {
  case "$1" in
    com.apple.CoreSimulator.SimDevice.????????-????-????-????-????????????) return 0 ;;
    XCTestTesting.*.spindump|XCTestTesting.*.spindump.txt) return 0 ;;
  esac
  return 1
}

# Deletes one path, but only after proving it is a CI-owned leaf under an
# allowed parent. Fails closed and loudly: a refusal here means this script
# was asked to delete something it has no business deleting, which is a defect
# worth seeing rather than silently skipping.
#
# A delete is proved, not assumed (#2566): the path counts as deleted only if
# rm succeeded AND the path is gone afterwards. On 2026-11-07 /Volumes/CIScratch
# answered unlink with EINTR while staying mounted: `rm -rf` exited 1 and the
# tree was still there. Path presence is the discriminator on purpose: APFS
# returns space asynchronously, so df straight after a GOOD delete can still
# show the old figure. df lag therefore never makes a delete look failed, and
# a failed delete never passes for df lag.
#
# Exit status: 0 deleted (verified gone), 2 nothing to delete, 3 delete
# attempted but the path is still there (RM_ERROR says why), 1 refused (a
# defect in this script's own target selection, deliberately fatal).
RM_ERROR=""
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
  # shellcheck disable=SC2254  # the glob is the point
  case "$parent" in $RUNNER_DD_GLOB) ok=1 ;; esac
  if [ "$ok" != "1" ]; then
    log "::error::mac-runner-disk-guard REFUSED to delete '$target': '$parent' is not one of the CI-owned parents this script may prune."
    return 1
  fi

  # A parent that is merely shared (the system temp dir) is allowed only for
  # the two shapes this script is entitled to remove from it.
  if [ "$parent" = "$SIM_TMP_ROOT" ] && ! sim_tmp_name_ok "$(basename "$target")"; then
    log "::error::mac-runner-disk-guard REFUSED to delete '$target': '$parent' is shared with every process on the host, and this name is not a CoreSimulator SimDevice directory or an XCTest spindump. This is a bug in this script, not a disk problem."
    return 1
  fi

  [ -e "$target" ] || [ -L "$target" ] || return 2
  local err rc=0
  err="$(rm -rf "$target" 2>&1)" || rc=$?
  if [ "$rc" -ne 0 ] || [ -e "$target" ] || [ -L "$target" ]; then
    if [ -n "$err" ]; then
      RM_ERROR="$(printf '%s\n' "$err" | head -n 1)"
    else
      RM_ERROR="rm exited $rc but the path is still present"
    fi
    return 3
  fi
}

# Deletes that were attempted and did not happen. Counted, named, and carried
# to the gate's verdict; never added to anything reported as freed. A failed
# delete is not fatal by itself: the gate decides on MEASURED free space, so a
# job still runs when the disk really has room, and is refused (with these
# paths named) when it does not.
DELETE_FAILURES=0
DELETE_FAILED_LIST=""
# What the last reclaim pass measurably returned (KiB, df delta, floored at 0),
# carried to the gate's verdict so a refusal says whether reclaiming helped.
RECLAIM_FREED_KIB=0

# note_delete_failed <path> <what> [apparent-gib]
# Deliberately does not `du` the survivor: on the volume that produced #2566,
# readdir also returned EINTR and mkdir hung, so walking it here could wedge
# the guard. Callers that measured the size before the delete pass it in.
note_delete_failed() {
  local size=""
  [ -n "${3:-}" ] && size=" (${3} GiB apparent, NOT freed)"
  DELETE_FAILURES=$((DELETE_FAILURES + 1))
  DELETE_FAILED_LIST="${DELETE_FAILED_LIST}    $1: ${RM_ERROR}
"
  log "::warning::mac-runner-disk-guard delete FAILED — $2: '$1' is still on disk${size}: ${RM_ERROR}. Not counted as reclaimed; free space here is measured, never assumed (#2566)."
}

# prune <path> <message> — delete a CI-owned path and say so. A refusal from
# rm_ci_path means this script targeted something it must not, which is a
# defect: it aborts rather than continuing quietly. A delete the filesystem
# would not perform is not this script's defect: it is named and counted, and
# the rest of the reclaim still runs.
prune() {
  local rc=0
  rm_ci_path "$1" || rc=$?
  case "$rc" in
    0) log "  $2"; deleted_any=1 ;;
    2) : ;;
    3) note_delete_failed "$1" "not done: $2" ;;
    *) exit 1 ;;
  esac
}

# ── DerivedData ownership ───────────────────────────────────────────────────
#
# ONE classifier, used by both `report` and `reclaim`, so what the report says
# will be kept or removed cannot drift from what reclaim does (#2530: the
# report listed 0.55 GiB as "skipped" while reclaim declined it too, and the
# rule behind both was the wrong one).
#
# An entry is CI's for one of two reasons, never by name alone:
#
#   runner  The entry sits in a DerivedData root inside a runner's own install
#           tree (RUNNER_DD_GLOB). Only that runner's jobs write there, so
#           location is the proof. The plist is NOT consulted: an interrupted
#           build is exactly the case where it was never written, and the CI
#           checkout persists between jobs, so "WorkspacePath exists" would
#           protect every leftover for ever.
#   host    The shared per-user root (~/Library/Developer/Xcode/DerivedData),
#           where an operator's Xcode session may own a folder. Here the
#           plist stays the discriminator: reclaim only an entry whose
#           WorkspacePath is gone. The one plist-less exception is a
#           `Llamenos-<hash>` directory holding nothing but run output (logs,
#           test results, coverage; see dd_is_headless_leftover): there is no
#           incremental state in it for anyone to lose.
#
# Both need the entry to be idle: nothing under it modified in DD_IDLE_MIN
# minutes, so a build running right now is never a candidate. The plist-less
# headless shape needs the longer SIM_MAX_AGE_MIN instead: a live
# `test-without-building` (the `ui` job) has no plist either, writes its
# coverage only at the end, and is capped at 65 min, so 60 quiet minutes does
# not prove it is dead.
#
# Where this root points: the default stays on the internal disk. CI's data
# does not go to /Volumes/CIScratch (the runner service is denied it by TCC),
# and out-of-CI ssh builds use an explicit -derivedDataPath under
# CIScratch/llamenos-ios-build (scripts/lib/ios-build-data.sh), never this
# root. A symlink from this root onto CIScratch is the 2026-10-21 incident
# shape, not the norm, and nothing here depends on it.

DD_VERDICT=""   # reclaim | retain
DD_REASON=""

# True when nothing at all under $1 changed in the last $2 minutes (default
# DD_IDLE_MIN). A find that cannot read the tree is NOT idle: when in doubt,
# keep.
dd_is_idle() {
  local newest
  newest="$(find "$1" -mmin "-${2:-$DD_IDLE_MIN}" -print -quit 2>/dev/null)" || return 1
  [ -z "$newest" ]
}

# Xcode names an entry <Workspace>-<28 lowercase letters>. True only for that
# shape under the Llamenos name whose whole content is run output: Logs/,
# TestResults/ and a Build/ holding nothing but ProfileData/ (coverage). That is
# exactly what every one of the 60 plist-less entries on the CI host held
# (measured 2026-11-06): a headless `xcodebuild test` that was pointed at
# another derived-data path for its products and left only its results here.
# Compiled products or indexes (Build/Products, Build/Intermediates.noindex,
# Index.noindex, ModuleCache.noindex, SourcePackages) are reusable state, and
# any of them keeps the entry out, as does any name not listed here.
dd_is_headless_leftover() {
  local dir="$1" entry shape='^Llamenos-[a-z]{28}$'
  [[ "$(basename "$dir")" =~ $shape ]] || return 1
  while IFS= read -r entry; do
    case "$entry" in
      Logs|TestResults) ;;
      Build)
        while IFS= read -r entry; do
          [ "$entry" = "ProfileData" ] || return 1
        done < <(find "$dir/Build" -mindepth 1 -maxdepth 1 -exec basename {} ';' 2>/dev/null)
        ;;
      *) return 1 ;;
    esac
  done < <(find "$dir" -mindepth 1 -maxdepth 1 -exec basename {} ';' 2>/dev/null)
}

# dd_classify <dir> <runner|host> — sets DD_VERDICT and DD_REASON.
dd_classify() {
  local dir="$1" owner="$2" plist workspace
  plist="$dir/info.plist"
  DD_VERDICT="retain"

  if [ "$owner" = "runner" ]; then
    if dd_is_idle "$dir"; then
      DD_VERDICT="reclaim"; DD_REASON="inside a runner's own DerivedData root, idle"
    else
      DD_REASON="modified within the last ${DD_IDLE_MIN} min; needs ${DD_IDLE_MIN} min idle (a live job's output)"
    fi
    return 0
  fi

  if [ ! -e "$plist" ]; then
    if ! dd_is_headless_leftover "$dir"; then
      DD_REASON="missing info.plist"
    elif dd_is_idle "$dir" "$SIM_MAX_AGE_MIN"; then
      DD_VERDICT="reclaim"; DD_REASON="no info.plist, only run output (logs, test results, coverage)"
    else
      # Longer than the plist rule on purpose: a live `test-without-building`
      # (the `ui` job, capped at 65 min) has no info.plist either and writes
      # its coverage only at the end, so 60 min of quiet does not prove it is
      # dead. SIM_MAX_AGE_MIN is above that cap.
      DD_REASON="modified within the last ${SIM_MAX_AGE_MIN} min; needs ${SIM_MAX_AGE_MIN} min idle (could be a live test run)"
    fi
  elif ! workspace="$(workspace_path_from_plist "$plist")"; then
    DD_REASON="info.plist unreadable/unparseable or WorkspacePath missing"
  elif [ -e "$workspace" ]; then
    DD_REASON="WorkspacePath exists ($workspace)"
  elif dd_is_idle "$dir"; then
    DD_VERDICT="reclaim"; DD_REASON="WorkspacePath missing"
  else
    DD_REASON="modified within the last ${DD_IDLE_MIN} min; needs ${DD_IDLE_MIN} min idle"
  fi
}

# Existing runner DerivedData roots, one per line.
runner_dd_roots() {
  local root
  # shellcheck disable=SC2086  # the glob is the point
  for root in $RUNNER_DD_GLOB; do
    [ -d "$root" ] && printf '%s\n' "$root"
  done
  return 0
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

  log "── simulator runtime dirs in ${SIM_TMP_ROOT} (simctl delete leaves these behind, #2644) ──"
  report_sim_tmp "$(xcrun simctl list devices 2>/dev/null || true)"
  log ""

  log "── runner agent _diag (the directory whose write crashed the agent) ──"
  du -sh "$HOME"/actions-runner-*/_diag 2>/dev/null || true
  log ""

  log "── Xcode DerivedData (apparent sizes; df below, not du, measures reclaimed space) ──"
  local root owner
  while IFS='|' read -r owner root; do
    [ -n "$root" ] || continue
    log "  [$owner root] $root"
    report_derived_data "$root" "$owner"
  done < <(derived_data_roots)
  log ""
}

# How many SimDevice runtime directories exist, how many no simulator owns
# (the ones reclaim removes once past the age floor), and what they hold.
report_sim_tmp() {
  local listing="$1" dir udid total=0 orphans=0 kib orphan_kib=0 spindumps
  if [ -d "$SIM_TMP_ROOT" ]; then
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      total=$((total + 1))
      case "$listing" in *"${dir##*.SimDevice.}"*) continue ;; esac
      orphans=$((orphans + 1))
      kib="$(du -sk "$dir" 2>/dev/null | awk '{print $1}')"
      orphan_kib=$((orphan_kib + ${kib:-0}))
    done < <(find "$SIM_TMP_ROOT" -maxdepth 1 -type d -name 'com.apple.CoreSimulator.SimDevice.*' -print 2>/dev/null || true)
    spindumps="$(find "$SIM_TMP_ROOT" -maxdepth 1 -name 'XCTestTesting.*.spindump*' 2>/dev/null | wc -l | tr -d ' ')"
  fi
  if [ -z "$listing" ]; then
    log "  simctl returned no device listing; ${total} SimDevice dir(s) present, orphans cannot be told from live devices"
  else
    awk -v t="$total" -v o="$orphans" -v k="$orphan_kib" -v s="${spindumps:-0}" \
      'BEGIN { printf "  %d SimDevice dir(s), %d orphaned (no simulator owns them; %.2f GiB apparent), %d XCTest spindump(s)\n", t, o, k/1048576, s }'
  fi
}

# Lists one root's entries with the verdict reclaim will reach.
report_derived_data() {
  local root="$1" owner="$2" dir apparent
  for dir in "$root"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    apparent="$(apparent_gib "$dir")"
    dd_classify "$dir" "$owner"
    if [ "$DD_VERDICT" = "reclaim" ]; then
      log "  ${apparent} GiB apparent  $(basename "$dir"): orphan candidate ($DD_REASON; reclaim checks run during reclaim)"
    else
      log "  ${apparent} GiB apparent  $(basename "$dir"): retained ($DD_REASON)"
    fi
  done
}

# "owner|root" for every DerivedData root this script looks at, host first.
derived_data_roots() {
  local root
  [ -d "$DERIVED_DATA" ] && printf 'host|%s\n' "$DERIVED_DATA"
  while IFS= read -r root; do
    printf 'runner|%s\n' "$root"
  done < <(runner_dd_roots)
  return 0
}

# ── simulator runtime directories (#2644) ───────────────────────────────────

# reclaim_sim_tmp <device-listing> — remove from $SIM_TMP_ROOT:
#   * `com.apple.CoreSimulator.SimDevice.<UDID>` directories that NO simulator
#     owns: the UDID is absent from <device-listing> (the output of
#     `xcrun simctl list devices`, which includes booted and Shutdown devices),
#     the directory is the runner account's own, and it is older than
#     SIM_TMP_MAX_AGE_MIN. A device that still exists keeps its directory, so
#     a booted simulator can never lose it. An EMPTY listing means simctl
#     could not answer, and then nothing is removed: without it an orphan and a
#     live device look identical.
#   * `XCTestTesting.*.spindump*` captures older than
#     SIM_TMP_SPINDUMP_MAX_AGE_HOURS.
# Every removal goes through rm_ci_path, which re-checks the name.
reclaim_sim_tmp() {
  local listing="$1" dir udid owner p
  [ -d "$SIM_TMP_ROOT" ] || return 0
  owner="$(id -un)"

  if [ -z "$listing" ]; then
    log "  skipped orphaned SimDevice directories: simctl returned no device listing, so an orphan cannot be told from a live device's directory"
  else
    while IFS= read -r dir; do
      [ -n "$dir" ] || continue
      # Not the shape CoreSimulator writes: not ours to judge, and handing it
      # to prune would be refused as a defect and abort the whole reclaim.
      sim_tmp_name_ok "$(basename "$dir")" || continue
      udid="${dir##*.SimDevice.}"
      case "$listing" in
        *"$udid"*) continue ;;
      esac
      prune "$dir" "removed orphaned simulator runtime dir: $udid"
    done < <(find "$SIM_TMP_ROOT" -maxdepth 1 -type d -user "$owner" \
               -name 'com.apple.CoreSimulator.SimDevice.*' \
               -mmin "+${SIM_TMP_MAX_AGE_MIN}" -print 2>/dev/null || true)
  fi

  while IFS= read -r p; do
    [ -n "$p" ] || continue
    sim_tmp_name_ok "$(basename "$p")" || continue
    prune "$p" "removed stale XCTest spindump: $(basename "$p")"
  done < <(find "$SIM_TMP_ROOT" -maxdepth 1 -user "$owner" \
             -name 'XCTestTesting.*.spindump*' \
             -mmin "+$(( SIM_TMP_SPINDUMP_MAX_AGE_HOURS * 60 ))" -print 2>/dev/null || true)
}

# delete_sim <udid> — the job-teardown form: shut a simulator down, delete it,
# and remove the runtime directory `simctl delete` leaves behind. Never fails
# the step that calls it (an unconditional teardown must not turn a green job
# red), but says out loud when it could not finish.
delete_sim() {
  local udid="${1:-}" listing
  if [ -z "$udid" ]; then
    log "delete-sim: no simulator was created by this job; nothing to delete"
    return 0
  fi
  case "$udid" in
    ????????-????-????-????-????????????) ;;
    *) log "::warning::delete-sim: '$udid' is not a simulator UDID; refusing to act on it"; return 0 ;;
  esac
  xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
  xcrun simctl delete "$udid" >/dev/null 2>&1 || true
  # Only forget the runtime directory once CoreSimulator no longer knows the
  # device. An empty listing is "could not ask", never "it is gone".
  if ! listing="$(xcrun simctl list devices 2>/dev/null)" || [ -z "$listing" ]; then
    log "::warning::delete-sim: could not list simulators, so '$udid' was not confirmed deleted; leaving its runtime directory for the next reclaim"
    return 0
  fi
  case "$listing" in
    *"$udid"*)
      log "::warning::delete-sim: simulator $udid is still registered after shutdown+delete; leaving its runtime directory for the next reclaim"
      return 0
      ;;
  esac
  prune "$SIM_TMP_ROOT/com.apple.CoreSimulator.SimDevice.$udid" "deleted simulator $udid and its runtime directory"
  return 0
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

  # 3b. The runtime directory `simctl delete` leaves in /private/var/tmp for
  #     every simulator a job boots (#2644). Listed AFTER the passes above so a
  #     device they just deleted already counts as gone; its directory is
  #     still younger than the age floor, so the next pass takes it.
  reclaim_sim_tmp "$(xcrun simctl list devices 2>/dev/null || true)"

  # 4. DerivedData CI left behind. Ownership by location inside a runner's own
  #    tree, by plist (or a logs-only shape) in the shared per-user root; see
  #    "DerivedData ownership" above. rm_ci_path applies both the denylist and
  #    direct-parent allowlist.
  reclaim_all_derived_data

  # 5. The runner agents' own `_diag` logs. Pruned by age so the file the live
  #    agent is writing is never a candidate, and across every runner install
  #    on the host because they share the one volume — which is exactly why
  #    both agents died in the same second. Not routed through rm_ci_path:
  #    these are files under a runner install rather than leaves of a CI-owned
  #    parent, so the name pattern and age bound are the proof instead.
  local err
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if err="$(rm -f "$p" 2>&1)" && [ ! -e "$p" ]; then
      log "  pruned stale runner log: ${p#"$HOME"/}"; deleted_any=1
    else
      RM_ERROR="${err:-rm exited 0 but the file is still present}"
      note_delete_failed "$p" "stale runner log"
    fi
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
  RECLAIM_FREED_KIB=$(( after > before ? after - before : 0 ))
  if [ "$DELETE_FAILURES" -gt 0 ]; then
    log "::warning::mac-runner-disk-guard: ${DELETE_FAILURES} delete(s) FAILED and freed nothing; still on disk:"
    printf '%s' "$DELETE_FAILED_LIST"
  fi
  if awk -v f="$freed" 'BEGIN { exit !(f > 0) }'; then
    log "  reclaimed ${freed} GiB (free: $(awk -v k="$before" 'BEGIN{printf "%.1f", k/1048576}') -> $(free_gib) GiB)"
  elif [ "$deleted_any" -gt 0 ]; then
    # Deletions DID happen; the flat delta is the APFS lag above (or other
    # activity on this shared host consumed the space as fast as we freed
    # it). Saying "nothing left to reclaim" here is how #1861's report read
    # while a 3.86 GiB device sat deleted-but-unmeasured.
    log "  deletions issued; df shows no delta yet — APFS reclaims asynchronously, the space appears on a later read (free: $(awk -v k="$before" 'BEGIN{printf "%.1f", k/1048576}') -> $(free_gib) GiB)"
  elif [ "$DELETE_FAILURES" -gt 0 ]; then
    log "  nothing reclaimed: every delete attempted FAILED (listed above) (free: $(awk -v k="$before" 'BEGIN{printf "%.1f", k/1048576}') -> $(free_gib) GiB)"
  else
    # Free space is a live number on a shared host; a non-positive delta means
    # there was nothing of CI's left to take, not that reclaim failed.
    log "  nothing CI-owned left to reclaim (free: $(awk -v k="$before" 'BEGIN{printf "%.1f", k/1048576}') -> $(free_gib) GiB; other activity on this host moves this number)"
  fi
  log ""
}

# Reclaim every DerivedData root this script looks at.
reclaim_all_derived_data() {
  local root owner
  while IFS='|' read -r owner root; do
    [ -n "$root" ] || continue
    reclaim_derived_data "$root" "$owner"
  done < <(derived_data_roots)
}

# reclaim_derived_data <root> <runner|host> — delete the idle entries of one
# root that dd_classify proves are CI's. Apparent size is informational; df
# deltas are the only measurement of actual reclaimed capacity, especially on
# APFS clones.
reclaim_derived_data() {
  local data_root="$1" owner="$2" dir mtime age_min before after freed apparent rc
  [ -d "$data_root" ] || return 0

  for dir in "$data_root"/*/; do
    [ -d "$dir" ] || continue
    dir="${dir%/}"
    apparent="$(apparent_gib "$dir")"
    dd_classify "$dir" "$owner"
    if [ "$DD_VERDICT" != "reclaim" ]; then
      log "  retained DerivedData $(basename "$dir") (${apparent} GiB apparent): $DD_REASON"
      continue
    fi

    mtime="$(path_mtime_epoch "$dir" 2>/dev/null || date +%s)"
    age_min=$(( ($(date +%s) - mtime) / 60 ))
    before="$(df_available_kib "$dir")"
    rc=0
    rm_ci_path "$dir" || rc=$?
    case "$rc" in
      0)
        after="$(df_available_kib "$data_root")"
        freed="$(awk -v a="$after" -v b="$before" 'BEGIN { printf "%.2f", (a - b) / 1048576 }')"
        deleted_any=1
        log "  removed orphaned DerivedData $(basename "$dir") ($DD_REASON; ${age_min} min old); df available: $(awk -v k="$before" 'BEGIN{printf "%.2f", k/1048576}') -> $(awk -v k="$after" 'BEGIN{printf "%.2f", k/1048576}') GiB (delta ${freed} GiB)"
        ;;
      2) : ;;
      3) note_delete_failed "$dir" "orphaned DerivedData $(basename "$dir") ($DD_REASON)" "$apparent" ;;
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
    # Free, required and the gap, in MiB, in one machine-readable line the
    # workflow reads. A host 150 MB short and a host 8 GiB short are different
    # faults and used to read the same (#2644).
    local free_kib_now short_mib
    free_kib_now="$(free_kib)"
    short_mib="$(awk -v k="$free_kib_now" -v m="$MIN_FREE_GIB" 'BEGIN { printf "%d", (m * 1048576 - k) / 1024 + 0.999 }')"
    log "disk-guard-verdict: refused free_mib=$(( free_kib_now / 1024 )) need_mib=$(( MIN_FREE_GIB * 1024 )) short_mib=${short_mib} reclaimed_mib=$(( RECLAIM_FREED_KIB / 1024 ))"
    log "::error::ios runner REFUSED to run: disk-headroom — only ${free} GiB free on ${VOLUME} of the ${MIN_FREE_GIB} GiB this job needs (short by ${short_mib} MiB; this reclaim pass freed $(( RECLAIM_FREED_KIB / 1024 )) MiB). THIS IS NOT A TEST FAILURE AND NOT THIS PR'S FAULT. Two concurrent iOS shards consume ~10 GiB of simulator data, build products and swap on this host; below ${MIN_FREE_GIB} GiB the runner AGENT runs out of space writing its own _diag log and dies mid-step, which uploads no job log at all and ejects whatever PR is in the merge queue with no attributable cause (#1665). Refusing here instead. To fix: free space on the runner host — 'scripts/ci/mac-runner-disk-guard.sh report' prints every consumer and what reclaiming it would cost."
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
    WorkspacePath that no longer exists (or run-output-only Llamenos-<hash>
    entries with no plist), idle for at least 60 minutes. Entries under a
    runner's own _work/DerivedData are removed on location alone. The report
    above names anything retained and why; apparent directory sizes are
    informational, while df deltas measure actual space.
  * /System/Volumes/VM/swapfile* — grows on demand, returned only by a reboot.

EOF
    if [ "$DELETE_FAILURES" -gt 0 ]; then
      log "Reclaim also TRIED to free the ${DELETE_FAILURES} path(s) below and the filesystem refused. They are"
      log "still on disk and none of their space is in the figure above. Fix the volume first (#2566):"
      printf '%s' "$DELETE_FAILED_LIST"
    fi
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
  # Plist-less entries: the leaked test-run shape (reclaimed when idle), the
  # same shape still being written (retained), and look-alikes that hold
  # anything a real build would (retained).
  local testrun="$DERIVED_DATA/Llamenos-ttttttttttttttttttttttttiiii" testrun_live="$DERIVED_DATA/Llamenos-ttttttttttttttttttttttttllll"
  local testrun_build="$DERIVED_DATA/Llamenos-ttttttttttttttttttttttttbbbb" testrun_extra="$DERIVED_DATA/Llamenos-ttttttttttttttttttttttttxxxx"
  mkdir -p "$orphan" "$live" "$missing" "$malformed" "$fresh" "$sandbox/live-workspace"
  mkdir -p "$testrun/Logs/Test" "$testrun/TestResults" "$testrun/Build/ProfileData/X"
  : > "$testrun/Build/ProfileData/X/a.profraw"
  mkdir -p "$testrun_live/Logs/Test" "$testrun_live/Build/ProfileData/X"
  : > "$testrun_live/Build/ProfileData/X/a.profraw"
  mkdir -p "$testrun_build/Logs" "$testrun_build/Build/ProfileData" "$testrun_build/Build/Intermediates.noindex"
  mkdir -p "$testrun_extra/Logs" "$testrun_extra/SourcePackages"
  # Everything idle except testrun_live, whose newest file stays fresh.
  find "$testrun" "$testrun_build" "$testrun_extra" -exec touch -t 202001010000 {} +
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
  # Idleness is judged on the newest file anywhere in the tree, not the top
  # directory, so the whole fixture has to be old.
  find "$orphan" -exec touch -t 202001010000 {} +
  before_kib="$(df_available_kib "$sandbox")"
  reclaim_output="$(reclaim_derived_data "$DERIVED_DATA" host)"
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
  if [ ! -e "$testrun" ]; then
    log "  ok    leaked idle test-run DerivedData was removed"
  else
    log "  FAIL  leaked idle test-run DerivedData survived"
    fails=$((fails + 1))
  fi
  for leaf in "$live" "$missing" "$malformed" "$fresh" "$testrun_live" "$testrun_build" "$testrun_extra"; do
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

  selftest_derived_data_ownership "$sandbox"
  fails=$((fails + SELFTEST_OWNERSHIP_FAILS))
  selftest_failed_delete "$sandbox"
  fails=$((fails + SELFTEST_FAILED_DELETE_FAILS))
  selftest_sim_tmp "$sandbox"
  fails=$((fails + SELFTEST_SIM_TMP_FAILS))

  log ""
  if [ "$fails" -ne 0 ]; then
    log "::error::mac-runner-disk-guard selftest FAILED: $fails case(s). Do not ship this script."
    return 1
  fi
  log "selftest passed: every protected path refused, every CI-owned path handled"
}

# Ownership of a DerivedData entry is proved by WHERE it is, or, where a human
# could own the folder, by what is inside it (#2530). Each case below is a
# break-it: the first group must be reclaimed (they are the leftovers the old
# plist-only rule protected), the second must survive.
selftest_derived_data_ownership() {
  local sandbox="$1" host runner out before_kib after_kib name rc fails=0
  local hash_a="Llamenos-aaaaaaaaaaaaaaaaaaaaaaaaaaaa" hash_b="Llamenos-bbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  local hash_c="Llamenos-cccccccccccccccccccccccccccc" hash_d="Llamenos-dddddddddddddddddddddddddddd"
  local hash_e="Llamenos-eeeeeeeeeeeeeeeeeeeeeeeeeeee" hash_f="Llamenos-ffffffffffffffffffffffffffff"
  local hash_h="Llamenos-hhhhhhhhhhhhhhhhhhhhhhhhhhhh"
  host="$sandbox/host-dd"
  runner="$sandbox/actions-runner-9/_work/DerivedData"
  RUNNER_DD_GLOB="$sandbox/actions-runner-*/_work/DerivedData"
  DERIVED_DATA="$host"
  DENY=("${DENY[@]}" "$host")
  ALLOW_PARENTS=("${ALLOW_PARENTS[@]}" "$host")
  mkdir -p "$host" "$runner" "$sandbox/ws-alive"

  age() { find "$1" -exec touch -t 202001010000 {} + ; }
  # age_min <dir> <minutes>: BSD date (-v) on the Mac, GNU date (-d) elsewhere.
  age_min() {
    local stamp
    stamp="$(date -v-"$2"M +%Y%m%d%H%M 2>/dev/null || date -d "$2 minutes ago" +%Y%m%d%H%M)"
    find "$1" -exec touch -t "$stamp" {} +
  }
  plist_for() { # plist_for <dir> <workspace>
    cat > "$1/info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>WorkspacePath</key><string>$2</string></dict></plist>
PLIST
  }
  expect_gone() { # expect_gone <label> <path>
    if [ ! -e "$2" ]; then log "  ok    $1"; else log "  FAIL  $1: survived: $2"; fails=$((fails + 1)); fi
  }
  expect_kept() {
    if [ -e "$2" ]; then log "  ok    $1"; else log "  FAIL  $1: was deleted: $2"; fails=$((fails + 1)); fi
  }

  log "── selftest: DerivedData ownership (#2530) ──"

  # Reclaimed ----------------------------------------------------------------
  # (1) the incident: an interrupted CI build under the RUNNER's own root, no
  #     plist, real bytes. Must be gone, and its bytes reported as reclaimed.
  mkdir -p "$runner/$hash_a/Build/Products"
  dd if=/dev/urandom of="$runner/$hash_a/Build/Products/payload" bs=1048576 count=64 2>/dev/null
  # (2) runner root, plist whose workspace still exists: the CI checkout
  #     persists between jobs, so "workspace exists" would protect every
  #     leftover forever. Location is the proof, not the plist.
  mkdir -p "$runner/$hash_b/Build"; plist_for "$runner/$hash_b" "$sandbox/ws-alive"
  # (3) host root, no plist, only logs/results: an automated headless build.
  mkdir -p "$host/$hash_c/Build/ProfileData/UUID" "$host/$hash_c/Logs" "$host/$hash_c/TestResults"
  : > "$host/$hash_c/TestResults/a.xcresult"
  age "$runner/$hash_a"; age "$runner/$hash_b"; age "$host/$hash_c"

  # Survives -----------------------------------------------------------------
  # (4) runner root but modified just now: a live job's output.
  mkdir -p "$runner/$hash_d/Build"
  # (5) host root, no plist, but holds Build/Products — incremental state somebody may reuse.
  mkdir -p "$host/$hash_e/Build/Products" "$host/$hash_e/Logs"; age "$host/$hash_e"
  # (6) host root, plist names a workspace that exists — a human's project.
  mkdir -p "$host/$hash_f/Build"; plist_for "$host/$hash_f" "$sandbox/ws-alive"; age "$host/$hash_f"
  # (7) host root, no plist, logs only, but not Llamenos's hash shape.
  mkdir -p "$host/SomeoneElse-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/Logs"; age "$host/SomeoneElse-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  # (8) host root, correct shape, logs only, but written to just now: a live headless build.
  mkdir -p "$host/Llamenos-gggggggggggggggggggggggggggg/Logs"
  # (8b) the same shape idle 90 min: past the 60-min rule the plist cases use but
  #      inside the `ui` job's 65-min cap plus margin (SIM_MAX_AGE_MIN, 120). A
  #      live test-without-building has no plist and writes coverage only at
  #      the end, so 90 quiet minutes does not prove it is dead.
  mkdir -p "$host/$hash_h/Build/ProfileData/UUID" "$host/$hash_h/Logs"; age_min "$host/$hash_h" 90
  # (9) a sibling dir that is NOT a runner DerivedData root.
  mkdir -p "$sandbox/actions-runner-9/_work/NotDerivedData/$hash_a"; age "$sandbox/actions-runner-9/_work/NotDerivedData"

  before_kib="$(df_available_kib "$sandbox")"
  out="$(reclaim_all_derived_data)"
  after_kib="$(df_available_kib "$sandbox")"
  log "$out"

  expect_gone "runner-root leftover with NO info.plist was reclaimed" "$runner/$hash_a"
  expect_gone "runner-root leftover whose workspace still exists was reclaimed (location, not plist)" "$runner/$hash_b"
  expect_gone "host-root plist-less logs-only headless build was reclaimed" "$host/$hash_c"
  if awk -v b="$before_kib" -v a="$after_kib" 'BEGIN { exit !(a > b) }'; then
    log "  ok    df shows the bytes returned: $(awk -v k="$before_kib" 'BEGIN{printf "%.2f", k/1048576}') -> $(awk -v k="$after_kib" 'BEGIN{printf "%.2f", k/1048576}') GiB"
  else
    log "  FAIL  df did not show space returned: ${before_kib} -> ${after_kib} KiB"; fails=$((fails + 1))
  fi
  case "$out" in
    *"removed orphaned DerivedData $hash_a"*"delta "*) log "  ok    the removal line reports the reclaimed bytes" ;;
    *) log "  FAIL  no 'removed ... delta' line for $hash_a in the reclaim output"; fails=$((fails + 1)) ;;
  esac
  expect_kept "fresh runner-root entry survives (live job)" "$runner/$hash_d"
  expect_kept "host-root plist-less entry holding Build/Products survives" "$host/$hash_e"
  expect_kept "host-root entry whose workspace exists survives" "$host/$hash_f"
  expect_kept "host-root plist-less entry with a foreign name survives" "$host/SomeoneElse-aaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  expect_kept "fresh host-root headless entry survives (live build)" "$host/Llamenos-gggggggggggggggggggggggggggg"
  expect_kept "host-root headless entry idle 90 min survives (could be a live test run)" "$host/$hash_h"
  expect_kept "entry outside any DerivedData root survives" "$sandbox/actions-runner-9/_work/NotDerivedData/$hash_a"

  # The delete guard itself must still refuse a path outside every root.
  name="$sandbox/actions-runner-9/_work/NotDerivedData/$hash_a"
  rc=0; rm_ci_path "$name" >/dev/null 2>&1 || rc=$?
  if [ "$rc" = "1" ]; then log "  ok    rm_ci_path refuses a hash dir outside every DerivedData root"
  else log "  FAIL  rm_ci_path rc=$rc for a hash dir outside every DerivedData root"; fails=$((fails + 1)); fi

  SELFTEST_OWNERSHIP_FAILS="$fails"
}

# selftest_reclaim_with_failing_rm <sandbox> <eintr-name> <ghost-name>
# A SUBSHELL body, so the `rm` override dies with it. Kept out of a `$( )` on
# purpose: macOS /bin/bash 3.2 (what the install-timer LaunchAgent runs)
# misparses a `case` inside command substitution and echoes the source instead.
selftest_reclaim_with_failing_rm() (
  RUNNER_DD_GLOB="$1/actions-runner-8/_work/DerivedData"
  DERIVED_DATA="$1/empty-host-dd"
  SHIM_EINTR="$2"; SHIM_GHOST="$3"
  DELETE_FAILURES=0; DELETE_FAILED_LIST=""
  rm() {
    case "$*" in
      *"$SHIM_EINTR"*) printf 'rm: %s: Interrupted system call\n' "${!#}" >&2; return 1 ;;
      *"$SHIM_GHOST"*) return 0 ;;
      *) command rm "$@" ;;
    esac
  }
  reclaim_all_derived_data
  printf 'DELETE_FAILURES=%s\n' "$DELETE_FAILURES"
)

# A delete the filesystem refuses must be NAMED and must not count as freed
# (#2566: /Volumes/CIScratch returned EINTR on unlink while staying mounted).
# `rm` is shadowed by a function, inside a subshell, so the failure is the
# exact shape that host produced (rm exits 1 with EINTR, the path survives)
# on any filesystem and as any user. A second shim exits 0 and deletes
# nothing: the verdict must come from the path, not from rm's exit code.
selftest_failed_delete() {
  local sandbox="$1" root out rc fails=0
  local eintr="Llamenos-eintreintreintreintreintreintr" ghost="Llamenos-ghostghostghostghostghostghost"
  local healthy="Llamenos-zzzzzzzzzzzzzzzzzzzzzzzzzzzz"
  root="$sandbox/actions-runner-8/_work/DerivedData"
  mkdir -p "$root/$eintr/Build/Products" "$root/$ghost/Build" "$root/$healthy/Build/Products" "$sandbox/empty-host-dd"
  dd if=/dev/urandom of="$root/$eintr/Build/Products/payload" bs=1048576 count=8 2>/dev/null
  dd if=/dev/urandom of="$root/$healthy/Build/Products/payload" bs=1048576 count=8 2>/dev/null
  find "$root" -exec touch -t 202001010000 {} +

  log "── selftest: a delete that fails is named, never counted as freed (#2566) ──"
  rc=0
  out="$(selftest_reclaim_with_failing_rm "$sandbox" "$eintr" "$ghost")" || rc=$?
  log "$out"

  # expect <label> <command...>: `if`, never a bare test, so a failing case is
  # reported instead of tripping `set -e` and ending the selftest unreported.
  expect() {
    local label="$1"; shift
    if "$@"; then log "  ok    $label"; else log "  FAIL  $label"; fails=$((fails + 1)); fi
  }
  # matches <string> <glob> / lacks <string> <glob>
  # shellcheck disable=SC2053  # the glob is the point
  matches() { [[ "$1" == $2 ]]; }
  # shellcheck disable=SC2053  # the glob is the point
  lacks() { [[ "$1" != $2 ]]; }

  expect "reclaim survived the failed deletes (rc=$rc), it did not abort" [ "$rc" = "0" ]
  expect "the EINTR entry is still on disk" [ -d "$root/$eintr" ]
  expect "the rm-exited-0 entry is still on disk" [ -d "$root/$ghost" ]
  expect "the healthy entry after them was still reclaimed" [ ! -e "$root/$healthy" ]
  expect "the EINTR failure is named with its error and marked NOT freed" \
    matches "$out" "*delete FAILED*$eintr*NOT freed*Interrupted system call*"
  expect "an rm that exits 0 but leaves the path is a failure, not a delete" \
    matches "$out" "*delete FAILED*$ghost*rm exited 0 but the path is still present*"
  expect "the EINTR entry is not reported as removed" lacks "$out" "*removed orphaned DerivedData $eintr*"
  expect "the rm-exited-0 entry is not reported as removed" lacks "$out" "*removed orphaned DerivedData $ghost*"
  expect "the healthy entry is reported as removed" matches "$out" "*removed orphaned DerivedData $healthy*"
  expect "exactly the two failed deletes are counted" matches "$out" "*DELETE_FAILURES=2*"

  # The gate decides on measured space. Failures name themselves in a refusal,
  # and do not by themselves refuse a disk that really has room.
  rc=0
  out="$( VOLUME="$sandbox"; MIN_FREE_GIB=999999; DELETE_FAILURES=1
          DELETE_FAILED_LIST="    $root/$eintr: rm: Interrupted system call
"
          gate 2>&1 )" || rc=$?
  expect "a refusal exits 1" [ "$rc" = "1" ]
  expect "a refusal names the paths reclaim failed to free" \
    matches "$out" "*TRIED to free*$root/$eintr*Interrupted system call*"
  rc=0
  out="$( VOLUME="$sandbox"; MIN_FREE_GIB=0; WARN_FREE_GIB=0; DELETE_FAILURES=1
          DELETE_FAILED_LIST="    $root/$eintr: rm: Interrupted system call
"
          gate 2>&1 )" || rc=$?
  expect "a failed delete does not fail closed when measured space is enough" \
    matches "$rc:$out" "0:*disk headroom OK*"
  rc=0
  out="$( VOLUME="$sandbox"; MIN_FREE_GIB=0; WARN_FREE_GIB=0; DELETE_FAILURES=0; gate 2>&1 )" || rc=$?
  expect "a healthy gate passes" matches "$rc:$out" "0:*disk headroom OK*"
  expect "a healthy gate mentions no failures" lacks "$out" "*TRIED to free*"

  SELFTEST_FAILED_DELETE_FAILS="$fails"
}

# The /private/var/tmp sweep (#2644). Break-it in both directions: an orphaned
# SimDevice directory and a stale spindump go; a live device's directory, a
# young orphan, an unrelated file and every other name in the shared temp dir
# stay, and an unanswered `simctl list` removes nothing at all.
selftest_sim_tmp() {
  local sandbox="$1" fails=0 out rc root orig_root="$SIM_TMP_ROOT"
  local -a orig_allow=("${ALLOW_PARENTS[@]}") filtered=() p
  local live="AAAAAAAA-1111-4111-8111-AAAAAAAAAAAA" orphan="BBBBBBBB-2222-4222-8222-BBBBBBBBBBBB"
  local young="CCCCCCCC-3333-4333-8333-CCCCCCCCCCCC" gone="DDDDDDDD-4444-4444-8444-DDDDDDDDDDDD"
  local still="EEEEEEEE-5555-4555-8555-EEEEEEEEEEEE"
  local pre="com.apple.CoreSimulator.SimDevice."
  root="$sandbox/vartmp"
  mkdir -p "$root"

  # The sandbox stands in for /private/var/tmp: swap it into the policy and
  # drop the real one, so a path under the real /private/var/tmp is judged by
  # the same rules and not waved through by a stale allowlist entry.
  for p in "${orig_allow[@]}"; do
    [ "$p" = "$orig_root" ] || filtered+=("$p")
  done
  SIM_TMP_ROOT="$root"
  ALLOW_PARENTS=("${filtered[@]}" "$root")

  expect() {
    local label="$1"; shift
    if "$@"; then log "  ok    $label"; else log "  FAIL  $label"; fails=$((fails + 1)); fi
  }
  # shellcheck disable=SC2053  # the glob is the point
  matches() { [[ "$1" == $2 ]]; }

  log "── selftest: /private/var/tmp is shared; only two name shapes may go (#2644) ──"
  : > "$root/notes.txt"
  mkdir -p "$root/com.apple.launchd.AbCdEf1234" "$root/${pre}not-a-uuid" "$root/CallKit"
  for p in notes.txt com.apple.launchd.AbCdEf1234 "${pre}not-a-uuid" CallKit; do
    rc=0; rm_ci_path "$root/$p" >/dev/null 2>&1 || rc=$?
    expect "rm_ci_path refuses '$p' in the shared temp dir (rc=$rc)" [ "$rc" = "1" ]
  done
  rc=0; rm_ci_path "/private/var/tmp/${pre}${orphan}" >/dev/null 2>&1 || rc=$?
  expect "the real /private/var/tmp is not an allowed parent while the sandbox stands in" [ "$rc" = "1" ]
  expect "every refused name is still on disk" [ -e "$root/notes.txt" ] && [ -d "$root/CallKit" ] && [ -d "$root/com.apple.launchd.AbCdEf1234" ]

  mkdir -p "$root/${pre}${live}" "$root/${pre}${orphan}" "$root/${pre}${young}" "$root/${pre}${still}"
  : > "$root/${pre}${orphan}/launchd.log"
  : > "$root/XCTestTesting.2020-01-01-00:00:00.spindump.txt"
  mkdir -p "$root/XCTestTesting.2020-01-01-00:00:01.spindump" "$root/XCTestTesting.fresh.spindump.txt"
  rmdir "$root/XCTestTesting.fresh.spindump.txt"; : > "$root/XCTestTesting.fresh.spindump.txt"
  find "$root" -mindepth 1 -maxdepth 1 -exec touch -t 202001010000 {} +
  find "$root"/"${pre}${orphan}" -exec touch -t 202001010000 {} +
  touch "$root/${pre}${young}" "$root/XCTestTesting.fresh.spindump.txt"
  local listing="    ios-e2e-1-shard0 ($live) (Booted)
    iPhone CI fixture ($still) (Shutdown)"

  rc=0
  out="$(SIM_TMP_MAX_AGE_MIN=120; reclaim_sim_tmp "")" || rc=$?
  expect "no device listing: reclaim does not abort (rc=$rc)" [ "$rc" = "0" ]
  expect "no device listing: the orphan is NOT removed (cannot tell it from a live device)" [ -d "$root/${pre}${orphan}" ]
  expect "no device listing: the skip is announced" matches "$out" "*simctl returned no device listing*"
  expect "no device listing: the stale spindump is still removed (needs no listing)" [ ! -e "$root/XCTestTesting.2020-01-01-00:00:00.spindump.txt" ]

  rc=0
  out="$(SIM_TMP_MAX_AGE_MIN=120; reclaim_sim_tmp "$listing")" || rc=$?
  log "$out"
  expect "reclaim_sim_tmp succeeds (rc=$rc)" [ "$rc" = "0" ]
  expect "the orphaned SimDevice directory is removed" [ ! -e "$root/${pre}${orphan}" ]
  expect "a BOOTED device's directory survives" [ -d "$root/${pre}${live}" ]
  expect "a Shutdown device's directory survives" [ -d "$root/${pre}${still}" ]
  expect "a young orphan survives the age floor" [ -d "$root/${pre}${young}" ]
  expect "the stale spindump directory is removed" [ ! -e "$root/XCTestTesting.2020-01-01-00:00:01.spindump" ]
  expect "a fresh spindump survives" [ -e "$root/XCTestTesting.fresh.spindump.txt" ]
  expect "an unrelated file survives the sweep" [ -e "$root/notes.txt" ]
  expect "an unrelated launchd dir survives the sweep" [ -d "$root/com.apple.launchd.AbCdEf1234" ]
  expect "the removal is announced" matches "$out" "*removed orphaned simulator runtime dir: $orphan*"

  log "── selftest: job teardown removes the directory simctl delete leaves (#2644) ──"
  mkdir -p "$root/${pre}${gone}" "$root/${pre}${still}"
  (
    # xcrun shim: `delete` removes the device from the listing unless it is
    # the stubborn one, which models a simulator CoreSimulator will not delete.
    SIM_LISTING="$listing
    ci ($gone) (Shutdown)"
    xcrun() {
      case "$2" in
        delete) [ "$3" = "$still" ] || SIM_LISTING="$(printf '%s\n' "$SIM_LISTING" | grep -vF "$3")" ;;
        list) printf '%s\n' "$SIM_LISTING" ;;
      esac
      return 0
    }
    delete_sim "$gone"
    delete_sim "$still"
    delete_sim ""
    delete_sim "not-a-udid"
  ) > "$sandbox/delete-sim.out" 2>&1
  rc=$?
  out="$(cat "$sandbox/delete-sim.out")"
  log "$out"
  expect "delete-sim never fails the teardown step (rc=$rc)" [ "$rc" = "0" ]
  expect "delete-sim removes the runtime directory of the device it deleted" [ ! -e "$root/${pre}${gone}" ]
  expect "delete-sim keeps the directory of a device that is still registered" [ -d "$root/${pre}${still}" ]
  expect "delete-sim says so when a device is still registered" matches "$out" "*still registered*"
  expect "delete-sim with no udid is a no-op" matches "$out" "*nothing to delete*"
  expect "delete-sim refuses a non-UDID" matches "$out" "*is not a simulator UDID*"

  log "── selftest: a refusal says how short the disk is, in numbers (#2644) ──"
  rc=0
  out="$( VOLUME="$sandbox"; MIN_FREE_GIB=999999; DELETE_FAILURES=0; RECLAIM_FREED_KIB=2048; gate 2>&1 )" || rc=$?
  expect "a refusal exits 1" [ "$rc" = "1" ]
  expect "a refusal carries free/need/short/reclaimed as one parseable line" \
    matches "$out" "*disk-guard-verdict: refused free_mib=*need_mib=*short_mib=*reclaimed_mib=2*"
  expect "a refusal still names the shortfall in prose" matches "$out" "*only * GiB free on*short by * MiB*"

  SIM_TMP_ROOT="$orig_root"
  ALLOW_PARENTS=("${orig_allow[@]}")
  SELFTEST_SIM_TMP_FAILS="$fails"
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
  delete-sim)    delete_sim "${2:-}" ;;
  guard)
    # First, and before anything that walks a directory: if a write path is on
    # an unreadable volume, report/reclaim would wedge on it (2026-10-21).
    if ! check_write_paths; then
      summarize "REFUSED: a path this job writes is not on ${VOLUME}, the volume the disk floor measures. Environmental, not this PR."
      exit 1
    fi
    report
    reclaim
    failed_note=""
    if [ "$DELETE_FAILURES" -gt 0 ]; then
      failed_note=" ${DELETE_FAILURES} reclaim delete(s) FAILED and are not counted as freed (#2566)."
    fi
    if gate; then
      summarize "disk headroom OK — $(free_gib) GiB free (need ${MIN_FREE_GIB} GiB).${failed_note}"
    else
      summarize "REFUSED: only $(free_gib) GiB free, need ${MIN_FREE_GIB} GiB. Environmental, not this PR (#1665).${failed_note}"
      exit 1
    fi
    ;;
  *)
    log "usage: $(basename "$0") <report|reclaim|guard|delete-sim <udid>|install-timer|selftest>"
    exit 2
    ;;
esac
