#!/usr/bin/env bash
# Where an out-of-CI iOS build on the Mac writes its build data, and the
# preflight that refuses to build when that place is not really there.
#
# Sourced by scripts/ios-build.sh and scripts/test-ios.sh. Must stay
# bash-3.2-safe: /bin/bash on macOS is 3.2.
#
# WHY (2026-11-05)
# ----------------
# The CI Mac's internal data volume (/System/Volumes/Data) rests at ~15 GiB
# free, and the self-hosted iOS runners refuse to start a job below 12 GiB
# (scripts/ci/mac-runner-disk-guard.sh). A worker build over ssh that wrote
# Xcode's default ~/Library/Developer/Xcode/DerivedData grew that volume by
# GiBs per build, so a single verification build could push the runners under
# their floor - and two workers in one day could not build iOS at all.
#
# The external SSD (/Volumes/CIScratch, 1.8 TiB) exists so builds stop
# competing for that space. Out-of-CI builds now put DerivedData (which also
# holds SwiftPM checkouts and the module cache) and result bundles on it, via
# an EXPLICIT -derivedDataPath. Not a symlink, and not Xcode's global
# IDECustomDerivedDataLocation default, for two reasons:
#
#   * The runner service cannot read that volume. macOS TCC "Removable
#     Volumes" denies it (the runner's node binary is recorded as denied, and a
#     launchd-started process gets EPERM there, while an ssh session is
#     allowed). The runner's disk guard walks ~/Library/Developer/Xcode/
#     DerivedData; a symlink or a global default pointing it at CIScratch
#     wedged that walk on 2026-10-21. So the default location stays where it
#     is, on the internal disk, and only builds started from an ssh session
#     are redirected.
#   * A symlink onto removable media fails obscurely when the drive is gone (a
#     dangling path deep inside an Xcode error) or, worse, silently succeeds on
#     the boot volume if something recreates /Volumes/CIScratch as a plain
#     directory. The preflight below fails loudly instead, before xcodebuild.
#
# Inside a GitHub Actions job the default is $RUNNER_TEMP instead: the runners
# build on the internal volume, which is the volume their own guard measures
# (and the guard refuses a job whose write paths are anywhere else).
#
# ENVIRONMENT
#   IOS_BUILD_DATA_VOLUME        mount point that must be mounted
#                                (default /Volumes/CIScratch)
#   IOS_BUILD_DATA_ROOT          where build data goes
#                                (default $IOS_BUILD_DATA_VOLUME/llamenos-ios-build)
#   IOS_BUILD_DATA_MIN_FREE_GIB  refuse below this much free space on the
#                                filesystem IOS_BUILD_DATA_ROOT is on (default 20)
#
# Setting IOS_BUILD_DATA_ROOT to a path outside IOS_BUILD_DATA_VOLUME (and
# outside /Volumes, whose mounts cannot be checked without naming the volume)
# is an explicit opt-in to build somewhere else (e.g. the internal disk while the
# SSD is out for service); the mount assertion is then skipped, the free-space
# check measures that path's filesystem, and the preflight warns if it is the
# volume the CI runners' guard protects.

# Filesystem mount point that holds an existing path. Mount points may contain
# spaces, so join every field from the 6th on.
ios_build_data_mount_point() {
  df -P "$1" 2>/dev/null | awk 'NR==2 { s=$6; for (i=7; i<=NF; i++) s = s " " $i; print s }'
}

ios_build_data_free_gib() {
  df -Pk "$1" 2>/dev/null | awk 'NR==2 { printf "%.1f", $4 / 1048576 }'
}

# Stable per-checkout key, so two worktrees building at once on the Mac never
# share one DerivedData (concurrent xcodebuilds on one derivedDataPath fail
# with a locked build database).
ios_build_data_key() {
  local root="$1" hash
  hash="$(printf '%s' "$root" | shasum -a 256 | cut -c1-12)"
  printf '%s-%s' "$(basename "$root")" "$hash"
}

ios_build_data_refuse() {
  printf '\033[0;31m[ios-build-data]\033[0m REFUSED: %s\n' "$*" >&2
  return 1
}

# ios_build_data_preflight <project-root>
#
# On success, sets and exports:
#   IOS_DERIVED_DATA_PATH   pass as -derivedDataPath
#   IOS_RESULTS_DIR         directory for -resultBundlePath bundles
# On failure, prints why and returns 1. Never falls back silently.
ios_build_data_preflight() {
  local project_root="$1"
  local volume="${IOS_BUILD_DATA_VOLUME:-/Volumes/CIScratch}"
  local default_root="$volume/llamenos-ios-build"
  # Inside a GitHub Actions job the runner cannot reach the external drive
  # (TCC, above), and its own disk guard measures the volume RUNNER_TEMP is
  # on - so a job's build data belongs in RUNNER_TEMP, as the workflows do.
  if [ "${GITHUB_ACTIONS:-}" = "true" ] && [ -n "${RUNNER_TEMP:-}" ]; then
    default_root="$RUNNER_TEMP/llamenos-ios-build"
  fi
  local root="${IOS_BUILD_DATA_ROOT:-$default_root}"
  local min_free="${IOS_BUILD_DATA_MIN_FREE_GIB:-20}"
  local internal="/System/Volumes/Data"
  local mp probe free key existing

  if [ "$(uname -s)" != "Darwin" ]; then
    ios_build_data_refuse "iOS builds run on macOS; this host is $(uname -s)."
    return 1
  fi

  case "$root" in
    /*) : ;;
    *) ios_build_data_refuse "IOS_BUILD_DATA_ROOT must be absolute, got '$root'."; return 1 ;;
  esac

  # The mount assertion. The thing being ruled out is not only "the drive is
  # absent" but "the drive is absent and /Volumes/<name> exists anyway as a
  # plain directory on the boot volume", where every write would succeed and
  # land on exactly the disk this file exists to protect. A real mount point
  # is its own filesystem's mount point; a stand-in directory is not.
  local on_volume=0
  if [ "$root" = "$volume" ] || [ "${root#"$volume"/}" != "$root" ]; then
    on_volume=1
  else
    case "$root" in
      /Volumes/*)
        ios_build_data_refuse "IOS_BUILD_DATA_ROOT '$root' is under /Volumes but not under IOS_BUILD_DATA_VOLUME '$volume'. Set IOS_BUILD_DATA_VOLUME to the volume that holds it, so its mount can be checked."
        return 1
        ;;
    esac
  fi

  if [ "$on_volume" -eq 1 ]; then
    if [ ! -d "$volume" ]; then
      ios_build_data_refuse "the build-data volume $volume is not mounted (no such directory). The external SSD is unplugged, off the USB bus, or has not mounted since boot. NOT falling back to the internal disk: that is the disk the CI runners' 12 GiB guard protects. Fix: reattach/mount the drive ('diskutil list external physical' must show it; a drop's cause is in '/usr/bin/log show'), or opt into another location explicitly with IOS_BUILD_DATA_ROOT=<absolute path>."
      return 1
    fi
    mp="$(ios_build_data_mount_point "$volume")"
    if [ "$mp" != "$volume" ]; then
      ios_build_data_refuse "the build-data volume $volume is NOT mounted: that path exists but belongs to the filesystem mounted at '${mp:-?}', so it is a stand-in directory on another disk, not the external SSD. Writing there would silently fill that disk. Do not delete the directory blindly (look at what is in it first); reattach the drive, or opt into another location with IOS_BUILD_DATA_ROOT=<absolute path>."
      return 1
    fi
  fi

  if ! mkdir -p "$root/DerivedData" "$root/results" 2>/dev/null; then
    ios_build_data_refuse "cannot create '$root'. If this process was started by launchd (a LaunchAgent, a GitHub runner) rather than an ssh or Terminal session, macOS TCC 'Removable Volumes' denies it access to external drives - run the build from an ssh session, or set IOS_BUILD_DATA_ROOT to an internal path."
    return 1
  fi
  probe="$root/.write-probe.$$"
  if ! ( : > "$probe" ) 2>/dev/null; then
    ios_build_data_refuse "'$root' exists but is not writable by $(id -un) (TCC 'Removable Volumes' denies launchd-started processes; ssh sessions are allowed)."
    return 1
  fi
  rm -f "$probe"

  # Re-check the mount after creating directories: the drive can drop between
  # the assertion and the mkdir, and APFS would then have created the tree on
  # the boot volume under a recreated mount-point directory.
  mp="$(ios_build_data_mount_point "$root")"
  if [ "$on_volume" -eq 1 ] && [ "$mp" != "$volume" ]; then
    ios_build_data_refuse "'$root' is on '${mp:-?}', not on $volume; the drive dropped during the preflight."
    return 1
  fi

  if [ -z "$mp" ]; then
    ios_build_data_refuse "cannot read the filesystem '$root' is on (df failed), so its free space is unknown."
    return 1
  fi
  free="$(ios_build_data_free_gib "$root")"
  if awk -v f="${free:-0}" -v m="$min_free" 'BEGIN { exit !(f < m) }'; then
    ios_build_data_refuse "only ${free:-?} GiB free on '$mp' (the filesystem '$root' is on), need ${min_free} GiB for an iOS build's DerivedData. Reclaim old per-checkout entries under '$root/DerivedData' (each is a regenerable cache keyed by checkout), or lower IOS_BUILD_DATA_MIN_FREE_GIB deliberately."
    return 1
  fi

  key="$(ios_build_data_key "$project_root")"
  IOS_DERIVED_DATA_PATH="$root/DerivedData/$key"
  IOS_RESULTS_DIR="$root/results/$key"
  mkdir -p "$IOS_RESULTS_DIR"
  export IOS_DERIVED_DATA_PATH IOS_RESULTS_DIR

  printf '\033[0;32m[ios-build-data]\033[0m DerivedData -> %s (%s GiB free on %s)\n' \
    "$IOS_DERIVED_DATA_PATH" "$free" "$mp"

  # The volume the CI runners' guard protects. Report it either way, because
  # the build's simulator device data (test/uitest) still lands there: the
  # default CoreSimulator device set cannot move without the runners losing it.
  if [ -d "$internal" ]; then
    existing="$(ios_build_data_free_gib "$internal")"
    if [ "$mp" = "$internal" ]; then
      printf '\033[1;33m[ios-build-data]\033[0m WARNING: building on %s - the volume the CI runners need 12 GiB free on (%s GiB free now). An iOS build adds GiBs; this can make queued iOS jobs refuse to start.\n' \
        "$internal" "$existing" >&2
    else
      printf '\033[0;32m[ios-build-data]\033[0m internal %s: %s GiB free (simulator device data still lands there)\n' \
        "$internal" "$existing"
    fi
  fi
}
