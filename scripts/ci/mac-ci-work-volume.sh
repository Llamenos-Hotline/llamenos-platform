#!/usr/bin/env bash
#
# The CI work volume: a disk image hosted on the Mac's external SSD that holds
# what the iOS jobs write (each runner's `_work` and the CoreSimulator device
# set), so the build's ~5 GiB per shard stops competing for the internal disk.
#
# WHY A DISK IMAGE, AND NOT THE SSD DIRECTLY (measured 2026-11-14)
# ----------------------------------------------------------------
# The Mac has one extra disk: a 2 TB SABRENT USB SSD, APFS volume `CIScratch`,
# 1.8 TiB free. The runner service cannot use it. macOS TCC "Removable Volumes"
# is DENIED for the runner's node binary, and a launchd-started process gets
# `Operation not permitted` on `ls` and `touch` in /Volumes/CIScratch while an
# ssh session is allowed, so every shell-side check looks healthy. A grant is
# the operator's (System Settings; it cannot be made over ssh) and would not
# last: the runner self-updates into a new `externals.<ver>/node<N>` binary,
# which is what TCC keys on.
#
# What TCC gates is the SSD's own volume. A sparsebundle FILE on it, mounted as
# a disk image, is a different volume, and the same launchd-started process
# that is refused on CIScratch reads, writes and execs on it:
#
#   launchd bash, /Volumes/CIScratch          -> Operation not permitted
#   launchd bash, /Volumes/CIProbe (image)    -> write, read, 400 MB/s dd, exec: OK
#   launchd bash, hdiutil attach <image>      -> OK (the attach is done by the
#                                                disk-image daemon, not the caller)
#
# so nothing here needs a TCC grant, and nothing is lost if the runner updates.
# `verify` re-runs that proof from launchd, because the claim "the runner can
# use it" is only worth anything when it is measured from the runner's own kind
# of process; an ssh `touch` proves nothing.
#
# WHAT HAPPENS WHEN THE IMAGE IS NOT ATTACHED
# -------------------------------------------
# `_work` and the CoreSimulator device set are symlinks onto /Volumes/CIWork.
# With the image detached they dangle. The runner cannot create a workspace
# through a dangling link and /Volumes is root's, so nothing is created on the
# boot volume behind anyone's back: the job fails at once, and the disk guard
# says `disk-guard-wrong-volume ... the CI work volume's disk image is not
# attached`. The attach agent (`install-agent`) re-attaches within a minute of
# the SSD coming back, at login and every 60 seconds, with no ssh session.
#
# USAGE (run on the Mac, from an ssh session; no sudo anywhere)
#   mac-ci-work-volume.sh status           what exists, what is attached, where each link points
#   mac-ci-work-volume.sh create           create the sparsebundle on the SSD (once)
#   mac-ci-work-volume.sh attach           attach it (idempotent)
#   mac-ci-work-volume.sh install-agent    LaunchAgent that keeps it attached across logins/drops
#   mac-ci-work-volume.sh verify           prove a LAUNCHD-started process can use the volume
#   mac-ci-work-volume.sh cutover          move idle runners' `_work` and the simulator device set onto it
#   mac-ci-work-volume.sh rollback         put them back on the internal disk
#   mac-ci-work-volume.sh selftest         drive all of the above against stubs (runs anywhere)
#
# `cutover` and `rollback` refuse while a job could be using what they move: a
# Runner.Worker under the install, a booted simulator, a running xcodebuild.
# They never signal a process and never touch a runner's registration.
#
# ORDER OF OPERATIONS: cutover is safe to run once the disk guard that is in the
# job's own checkout understands the layout (scripts/ci/mac-runner-disk-guard.sh
# measures every volume a job writes to). A checkout that predates that guard
# demands every write path be on the internal volume and REFUSES a job whose
# `_work` is not: environmental, labelled as such, and cleared by rebasing.
# Cut over after the guard has landed on main.
#
# bash 3.2 compatible: this is what /bin/bash is on macOS, and what launchd runs.

set -euo pipefail

VOLNAME="${MAC_CI_WORK_VOLNAME:-CIWork}"
MOUNT="${MAC_CI_WORK_MOUNT:-/Volumes/$VOLNAME}"
IMAGE_DIR="${MAC_CI_WORK_IMAGE_DIR:-/Volumes/CIScratch/ci-work}"
IMAGE="${MAC_CI_WORK_IMAGE:-$IMAGE_DIR/$VOLNAME.sparsebundle}"
# A cap, not a reservation: a sparsebundle occupies only what is written. It is
# the ceiling the guard's free-space reading is computed against, so it should
# be far above the 12 GiB floor and far below the SSD.
SIZE="${MAC_CI_WORK_SIZE:-300g}"
STATE="${MAC_CI_WORK_STATE:-$HOME/.llamenos-mac}"
RUNNER_GLOB="${MAC_CI_RUNNER_GLOB:-$HOME/actions-runner-ios-*}"
SIM_DEVICES="${MAC_CI_SIM_DEVICES:-$HOME/Library/Developer/CoreSimulator/Devices}"
AGENT_LABEL="org.llamenos.ci-work-attach"
AGENT_PLIST="${MAC_CI_WORK_AGENT_PLIST:-$HOME/Library/LaunchAgents/$AGENT_LABEL.plist}"
PROBE_WAIT_SEC="${MAC_CI_WORK_PROBE_WAIT_SEC:-30}"

say() { printf '%s\n' "$*"; }
die() { printf 'mac-ci-work-volume: %s\n' "$*" >&2; exit 1; }

is_mounted() {
  # `mount` lists "<dev> on <mountpoint> (<opts>)". A match on the
  # " on <mount> (" shape, so /Volumes/CIWork cannot match /Volumes/CIWork 1.
  # The listing is captured first and matched with `case`, not piped into
  # `grep -q`: under pipefail, grep exiting at the first hit SIGPIPEs the
  # writer and the pipeline reports failure, so a mounted volume would
  # intermittently read as detached.
  local listing
  listing="$(mount 2>/dev/null || true)"
  case "$listing" in
    *" on $MOUNT ("*) return 0 ;;
  esac
  return 1
}

mount_point_of() {
  df -P "$1" 2>/dev/null | awk 'NR==2 { s=$6; for (i=7; i<=NF; i++) s = s " " $i; print s }'
}

avail_gib() {
  df -Pk "$1" 2>/dev/null | awk 'NR==2 { printf "%.1f", $4 / 1048576 }'
}

# True when something is running that could be using what cutover/rollback move.
# Runner.Worker is the process that runs a job; the install's own Listener is
# not a job. Matched by the install's bin prefix so a sibling runner's job does
# not block this one.
runner_busy() {
  local root="$1"
  ps -Ao command 2>/dev/null | awk -v r="$root/bin" 'index($0, r) == 1 && $0 ~ /Runner\.Worker/ { f = 1 } END { exit !f }'
}

sims_busy() {
  local booted
  booted="$(xcrun simctl list devices booted 2>/dev/null | grep -c '(Booted)' || true)"
  [ "${booted:-0}" -eq 0 ] || return 0
  ps -Ao command 2>/dev/null | awk '/xcodebuild/ && !/awk/ { f = 1 } END { exit !f }'
}

runner_roots() {
  local d
  # shellcheck disable=SC2086  # the glob is the point
  for d in $RUNNER_GLOB; do
    [ -d "$d" ] && [ -f "$d/.runner" ] && printf '%s\n' "$d"
  done
  return 0
}

# ── status ──────────────────────────────────────────────────────────────────

status() {
  local d t
  say "── CI work volume ──"
  say "image:      $IMAGE"
  if [ -e "$IMAGE" ]; then say "  exists: yes"; else say "  exists: NO (or this process cannot read the SSD)"; fi
  say "mount:      $MOUNT"
  if is_mounted; then
    say "  attached: yes, $(avail_gib "$MOUNT") GiB free (image cap $SIZE)"
  else
    say "  attached: NO"
  fi
  if [ -f "$AGENT_PLIST" ]; then say "attach agent: installed ($AGENT_PLIST)"; else say "attach agent: NOT installed"; fi
  say ""
  say "── where the job writes ──"
  for d in $(runner_roots); do
    if [ -L "$d/_work" ]; then
      t="$(readlink "$d/_work")"
      say "  $(basename "$d")/_work -> $t   [on $(mount_point_of "$d/_work" || true)]"
    elif [ -d "$d/_work" ]; then
      say "  $(basename "$d")/_work is a plain directory   [on $(mount_point_of "$d/_work")]"
    else
      say "  $(basename "$d")/_work absent"
    fi
  done
  if [ -L "$SIM_DEVICES" ]; then
    say "  CoreSimulator Devices -> $(readlink "$SIM_DEVICES")   [on $(mount_point_of "$SIM_DEVICES" || true)]"
  else
    say "  CoreSimulator Devices is a plain directory   [on $(mount_point_of "$SIM_DEVICES" || true)]"
  fi
}

# ── image ───────────────────────────────────────────────────────────────────

create() {
  command -v hdiutil >/dev/null 2>&1 || die "hdiutil not found: this runs on the Mac"
  [ ! -e "$IMAGE" ] || die "$IMAGE already exists; refusing to overwrite a volume that may hold a job's data"
  mkdir -p "$IMAGE_DIR" || die "cannot create $IMAGE_DIR: if this says Operation not permitted, this process is TCC-denied on the SSD; run it from an ssh session, not from launchd"
  hdiutil create -size "$SIZE" -type SPARSEBUNDLE -fs APFS -volname "$VOLNAME" "$IMAGE"
  say "created $IMAGE (cap $SIZE; occupies only what is written)"
}

attach() {
  command -v hdiutil >/dev/null 2>&1 || die "hdiutil not found: this runs on the Mac"
  if is_mounted; then say "already attached at $MOUNT"; return 0; fi
  hdiutil attach "$IMAGE" -nobrowse -noverify -quiet || die "could not attach $IMAGE (is the SSD mounted?)"
  is_mounted || die "attach returned but $MOUNT is not mounted: a volume with another name may have claimed the mount point"
  # Not worth indexing: it is build output, rewritten every job.
  : > "$MOUNT/.metadata_never_index" 2>/dev/null || true
  say "attached at $MOUNT, $(avail_gib "$MOUNT") GiB free"
}

# The wrapper launchd runs. It must not read the SSD itself (launchd's bash is
# TCC-denied there): it only asks the disk-image daemon to attach a path.
write_attach_wrapper() { # write_attach_wrapper <wrapper-path>
  local wrapper="$1"
  {
    printf '#!/bin/bash\n# Generated by mac-ci-work-volume.sh install-agent. Re-run install-agent to change it.\n'
    printf 'IMAGE=%q\nMOUNT=%q\nLOG=%q\n' "$IMAGE" "$MOUNT" "$STATE/ci-work-attach.log"
    cat <<'WRAPPER_BODY'
set -u
LISTING="$(mount 2>/dev/null)"
case "$LISTING" in *" on $MOUNT ("*) exit 0 ;; esac
mkdir -p "$(dirname "$LOG")"
{
  printf '%s attaching %s\n' "$(date -u +%FT%TZ)" "$IMAGE"
  hdiutil attach "$IMAGE" -nobrowse -noverify -quiet 2>&1
  LISTING="$(mount 2>/dev/null)"
  case "$LISTING" in
  *" on $MOUNT ("*)
    : > "$MOUNT/.metadata_never_index" 2>/dev/null
    printf '%s attached at %s\n' "$(date -u +%FT%TZ)" "$MOUNT"
    ;;
  *)
    printf '%s NOT attached: the SSD is not mounted yet, or %s is claimed by another volume\n' "$(date -u +%FT%TZ)" "$MOUNT"
    ;;
  esac
} >> "$LOG" 2>&1
tail -500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0
WRAPPER_BODY
  } > "$wrapper"
  chmod 755 "$wrapper"
}

install_agent() {
  local wrapper="$STATE/ci-work-attach.sh" domain wrapper_xml
  mkdir -p "$STATE" "$(dirname "$AGENT_PLIST")"
  write_attach_wrapper "$wrapper"
  wrapper_xml="$(printf '%s' "$wrapper" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g')"
  umask 077
  cat > "$AGENT_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$wrapper_xml</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>60</integer>
</dict>
</plist>
EOF
  chmod 600 "$AGENT_PLIST"
  if command -v launchctl >/dev/null 2>&1; then
    domain="gui/$(id -u)"
    launchctl bootout "$domain/$AGENT_LABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "$domain" "$AGENT_PLIST"
  fi
  say "installed $AGENT_PLIST: attaches $IMAGE at login and every 60 s while it is detached"
  say "log: $STATE/ci-work-attach.log"
}

# ── verify ──────────────────────────────────────────────────────────────────

# A process started by LAUNCHD, as the runner is, writes, reads back, execs and
# deletes on the volume. Returns 0 only when it printed the success marker; the
# runner's own TCC identity cannot be borrowed over ssh, so this is the closest
# faithful stand-in and the one measured on 2026-11-14. Bounded: a pending TCC
# prompt shows up as a hang, which is a finding and not something to wait on.
verify() {
  command -v launchctl >/dev/null 2>&1 || die "launchctl not found: this runs on the Mac"
  is_mounted || die "$MOUNT is not attached"
  local tag="org.llamenos.ci-work-probe.$$" script out waited=0
  mkdir -p "$STATE"
  script="$STATE/probe.$$.sh"; out="$STATE/probe.$$.out"
  : > "$out"
  cat > "$script" <<EOF
#!/bin/bash
d="$MOUNT/.probe.\$\$"
{ mkdir -p "\$d" && echo hello > "\$d/f" && [ "\$(cat "\$d/f")" = hello ] \\
  && printf '#!/bin/bash\\necho exec-ok\\n' > "\$d/x.sh" && chmod +x "\$d/x.sh" && [ "\$("\$d/x.sh")" = exec-ok ] \\
  && rm -rf "\$d" && echo "PROBE-OK launchd-user=\$(id -un)"; } 2>&1 || echo "PROBE-FAILED"
echo "PROBE-DONE"
EOF
  chmod 755 "$script"
  launchctl remove "$tag" >/dev/null 2>&1 || true
  launchctl submit -l "$tag" -o "$out" -e "$out" -- /bin/bash "$script"
  while [ "$waited" -lt "$PROBE_WAIT_SEC" ] && ! grep -q '^PROBE-DONE' "$out" 2>/dev/null; do
    sleep 1; waited=$((waited + 1))
  done
  launchctl remove "$tag" >/dev/null 2>&1 || true
  if grep -q '^PROBE-OK' "$out"; then
    say "verify: a launchd-started process can write, read and exec on $MOUNT ($(grep '^PROBE-OK' "$out"))"
    rm -f "$script" "$out"
    return 0
  fi
  say "verify FAILED on $MOUNT. Probe output:"
  cat "$out" 2>/dev/null || true
  if ! grep -q '^PROBE-DONE' "$out" 2>/dev/null; then
    say "(no result within ${PROBE_WAIT_SEC}s: a hang with a healthy df is the shape of a pending macOS permission prompt waiting for someone at the console)"
  fi
  rm -f "$script" "$out"
  return 1
}

# ── cutover / rollback ──────────────────────────────────────────────────────

# relink <link> <target> — make <link> a symlink to <target>, keeping what was
# there: its contents are copied to <target> first, then the original is removed
# once the copy is complete. A path that cannot be removed is NAMED, never
# assumed gone (the same rule as the disk guard's deletes, #2566).
relink() {
  local link="$1" target="$2" old rc=0
  if [ -L "$link" ]; then
    if [ "$(readlink "$link")" = "$target" ] && [ -d "$target" ]; then
      say "  already linked: $link -> $target"
      return 0
    fi
    die "$link is a symlink to '$(readlink "$link")', not to $target; refusing to guess. Run rollback first."
  fi
  mkdir -p "$target"
  if [ -d "$link" ]; then
    rsync -a "$link/" "$target/" || die "copying $link to $target failed; $link is untouched"
    old="$link.pre-ci-work"
    [ ! -e "$old" ] || die "$old already exists from an earlier attempt; look at it and remove it first"
    mv "$link" "$old"
    ln -s "$target" "$link"
    rm -rf "$old" || rc=$?
    if [ "$rc" -ne 0 ] || [ -e "$old" ]; then
      say "  WARNING: $old is still on disk (rc=$rc); its space is NOT returned. Remove it by hand."
    fi
  else
    ln -s "$target" "$link"
  fi
  say "  linked: $link -> $target"
}

unlink_back() { # unlink_back <link>: replace a symlink with a real directory holding its contents
  local link="$1" target tmp
  if [ ! -L "$link" ]; then say "  not a link, nothing to do: $link"; return 0; fi
  target="$(readlink "$link")"
  [ -d "$target" ] || die "$link points at $target, which is not there (image detached?): attach it first so nothing is lost"
  tmp="$link.rollback"
  [ ! -e "$tmp" ] || die "$tmp already exists from an earlier attempt"
  rsync -a "$target/" "$tmp/" || die "copying $target back failed; $link is untouched"
  rm "$link"
  mv "$tmp" "$link"
  say "  restored a plain directory at $link (the copy on the volume is left in place: $target)"
}

check_idle() { # check_idle <runner-root...>
  local d
  for d in "$@"; do
    ! runner_busy "$d" || die "$(basename "$d") has a job running (Runner.Worker under $d/bin). Cut over between jobs; this never signals a process."
  done
  if sims_busy; then
    die "a simulator is booted or xcodebuild is running: a job is using the device set. Cut over between jobs; this never signals a process."
  fi
}

cutover() {
  local roots d name
  is_mounted || die "$MOUNT is not attached: run attach first"
  verify
  roots="$(runner_roots)"
  [ -n "$roots" ] || die "no runner installs match $RUNNER_GLOB"
  # shellcheck disable=SC2086
  check_idle $roots
  say "── cutover: moving what jobs write onto $MOUNT ──"
  for d in $roots; do
    name="$(basename "$d")"
    relink "$d/_work" "$MOUNT/$name/_work"
  done
  relink "$SIM_DEVICES" "$MOUNT/CoreSimulator/Devices"
  say ""
  say "CoreSimulatorService reads the device set when it starts. If a simulator job fails to find"
  say "its device straight after this, run 'xcrun simctl list devices' once to confirm it now lists"
  say "the moved set; the service restarts on demand and picks the new path up."
  say "internal free now: $(avail_gib /System/Volumes/Data) GiB; $MOUNT free: $(avail_gib "$MOUNT") GiB"
}

rollback() {
  local roots d
  # Not attached means what the links point at is not there to copy back from.
  is_mounted || die "$MOUNT is not attached: attach it first, or what the links point at cannot be copied back and would be lost"
  roots="$(runner_roots)"
  # shellcheck disable=SC2086
  check_idle $roots
  say "── rollback: putting what jobs write back on the internal disk ──"
  for d in $roots; do unlink_back "$d/_work"; done
  unlink_back "$SIM_DEVICES"
}

# ── selftest ────────────────────────────────────────────────────────────────
#
# Drives every command above against stubs, anywhere (Linux CI included). The
# stubs stand in for the macOS tools; what is under test is this script's own
# decisions: that it will not move a busy runner's workspace, will not link
# onto a detached volume, keeps the data it moves, and says so when a removal
# did not happen.

selftest() {
  local sb fails=0 stubs out rc
  sb="$(mktemp -d "${TMPDIR:-/tmp}/ci-work-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$sb'" EXIT
  stubs="$sb/stubs"; mkdir -p "$stubs"

  ok()   { say "  ok    $1"; }
  fail() { say "  FAIL  $1"; fails=$((fails + 1)); }
  expect() { local label="$1"; shift; if "$@"; then ok "$label"; else fail "$label"; fi; }
  # shellcheck disable=SC2053
  matches() { [[ "$1" == $2 ]]; }

  # A volume "mounted" at $sb/vol, and the stubs that make `mount`, `hdiutil`,
  # `launchctl`, `ps` and `xcrun` answer for it.
  mkdir -p "$sb/vol" "$sb/ssd"
  cat > "$stubs/mount" <<EOF
#!/bin/bash
[ -f "$sb/attached" ] && echo "/dev/disk9s1 on $sb/vol (apfs, local, nobrowse)"
echo "/dev/disk3s5 on /System/Volumes/Data (apfs, local)"
EOF
  cat > "$stubs/hdiutil" <<EOF
#!/bin/bash
echo "\$@" >> "$sb/hdiutil.calls"
case "\$1" in
  attach) [ -e "$sb/ssd/CIWork.sparsebundle" ] || { echo "hdiutil: attach failed - no such file" >&2; exit 1; }; : > "$sb/attached" ;;
  create) mkdir -p "\${@: -1}" ;;
esac
EOF
  cat > "$stubs/launchctl" <<EOF
#!/bin/bash
# submit -l <label> -o <out> -e <err> -- <cmd...>: run it now, as launchd would.
case "\$1" in
  submit) shift; o=/dev/null
          while [ "\$1" != "--" ]; do [ "\$1" = "-o" ] && o="\$2"; shift; done; shift
          if [ -f "$sb/launchd-denied" ]; then echo "touch: Operation not permitted" > "\$o"; echo PROBE-DONE >> "\$o"; exit 0; fi
          "\$@" > "\$o" 2>&1 ;;
  *) exit 0 ;;
esac
EOF
  cat > "$stubs/ps" <<EOF
#!/bin/bash
cat "$sb/ps.out" 2>/dev/null
EOF
  cat > "$stubs/xcrun" <<EOF
#!/bin/bash
cat "$sb/simctl.out" 2>/dev/null
EOF
  chmod +x "$stubs"/*
  : > "$sb/ps.out"; : > "$sb/simctl.out"

  # Per-runner installs and a device set, with content that must survive.
  mkdir -p "$sb/home/actions-runner-ios-1/_work/repo" "$sb/home/actions-runner-ios-2/_work/repo" "$sb/home/dev/Devices/AAAA"
  for n in 1 2; do : > "$sb/home/actions-runner-ios-$n/.runner"; echo "ws-$n" > "$sb/home/actions-runner-ios-$n/_work/repo/file"; done
  echo plist > "$sb/home/dev/Devices/AAAA/device.plist"
  # Everything the script reads from the environment, pointed at the sandbox.
  run() {
    ( PATH="$stubs:$PATH"
      MAC_CI_WORK_MOUNT="$sb/vol" MAC_CI_WORK_IMAGE_DIR="$sb/ssd" MAC_CI_WORK_IMAGE="$sb/ssd/CIWork.sparsebundle"
      MAC_CI_WORK_STATE="$sb/state" MAC_CI_RUNNER_GLOB="$sb/home/actions-runner-ios-*" MAC_CI_SIM_DEVICES="$sb/home/dev/Devices"
      MAC_CI_WORK_AGENT_PLIST="$sb/agent.plist" MAC_CI_WORK_PROBE_WAIT_SEC=3
      export PATH MAC_CI_WORK_MOUNT MAC_CI_WORK_IMAGE_DIR MAC_CI_WORK_IMAGE MAC_CI_WORK_STATE MAC_CI_RUNNER_GLOB MAC_CI_SIM_DEVICES MAC_CI_WORK_AGENT_PLIST MAC_CI_WORK_PROBE_WAIT_SEC
      bash "$SELF" "$@" ) 2>&1
  }

  say "── selftest: the CI work volume commands, against stubs ──"

  rc=0; out="$(run cutover)" || rc=$?
  expect "cutover refuses while the image is not attached (rc=$rc)" [ "$rc" != "0" ]
  expect "...and says to attach it" matches "$out" "*is not attached*"
  expect "...and moved nothing" [ -d "$sb/home/actions-runner-ios-1/_work" ] && [ ! -L "$sb/home/actions-runner-ios-1/_work" ]

  rc=0; out="$(run attach)" || rc=$?
  expect "attach fails loudly when the image is not on the SSD (rc=$rc)" [ "$rc" != "0" ]
  : > "$sb/ssd/CIWork.sparsebundle"
  rc=0; out="$(run attach)" || rc=$?
  expect "attach succeeds once the image exists (rc=$rc)" [ "$rc" = "0" ]
  local calls_before
  calls_before="$(wc -l < "$sb/hdiutil.calls")"
  rc=0; out="$(run attach)" || rc=$?
  expect "attach is idempotent: a second call says so and does not call hdiutil again" \
    matches "$out" "*already attached*"
  expect "hdiutil was not called by the second attach" [ "$(wc -l < "$sb/hdiutil.calls")" = "$calls_before" ]

  rc=0; out="$(run create)" || rc=$?
  expect "create refuses to overwrite an existing image (rc=$rc)" [ "$rc" != "0" ]

  touch "$sb/launchd-denied"
  rc=0; out="$(run verify)" || rc=$?
  expect "verify FAILS when the launchd-started process is denied (rc=$rc)" [ "$rc" != "0" ]
  expect "...and prints what the process said" matches "$out" "*Operation not permitted*"
  rc=0; out="$(run cutover)" || rc=$?
  expect "cutover refuses a volume a launchd process cannot use (rc=$rc)" [ "$rc" != "0" ]
  expect "...and leaves _work alone" [ ! -L "$sb/home/actions-runner-ios-1/_work" ]
  rm -f "$sb/launchd-denied"
  rc=0; out="$(run verify)" || rc=$?
  expect "verify passes when the launchd-started process can write, read and exec (rc=$rc)" [ "$rc" = "0" ]
  expect "...and cleans up after itself" [ -z "$(ls -A "$sb/vol" 2>/dev/null | grep -v metadata_never_index || true)" ]

  # Busy runner: one Runner.Worker under runner 2's bin directory.
  printf '%s\n' "$sb/home/actions-runner-ios-2/bin.2.338.2/Runner.Worker spawnclient 3 4" > "$sb/ps.out"
  rc=0; out="$(run cutover)" || rc=$?
  expect "cutover refuses while ANY runner has a job (rc=$rc)" [ "$rc" != "0" ]
  expect "...and names the busy runner" matches "$out" "*actions-runner-ios-2 has a job running*"
  expect "...and has moved NOTHING, not even the idle runner" [ ! -L "$sb/home/actions-runner-ios-1/_work" ]
  : > "$sb/ps.out"
  # A sibling runner's worker must not be mistaken for this one's.
  printf '%s\n' "/elsewhere/actions-runner-ios-9/bin/Runner.Worker spawnclient" > "$sb/ps.out"
  rc=0; out="$(run cutover)" || rc=$?
  expect "a Runner.Worker belonging to some other install does not block (rc=$rc)" [ "$rc" = "0" ]
  rc=0; out="$(run rollback)" || rc=$?
  expect "rollback after it works (rc=$rc)" [ "$rc" = "0" ]
  : > "$sb/ps.out"

  # Booted simulator.
  echo "    ios-e2e-1 (AAAA-1) (Booted)" > "$sb/simctl.out"
  rc=0; out="$(run cutover)" || rc=$?
  expect "cutover refuses while a simulator is booted (rc=$rc)" [ "$rc" != "0" ]
  : > "$sb/simctl.out"

  rc=0; out="$(run cutover)" || rc=$?
  expect "cutover succeeds when attached, verified and idle (rc=$rc)" [ "$rc" = "0" ]
  expect "runner 1's _work is now a link into the volume" [ "$(readlink "$sb/home/actions-runner-ios-1/_work")" = "$sb/vol/actions-runner-ios-1/_work" ]
  expect "runner 2's _work is now a link into the volume" [ "$(readlink "$sb/home/actions-runner-ios-2/_work")" = "$sb/vol/actions-runner-ios-2/_work" ]
  expect "the device set is a link into the volume" [ "$(readlink "$sb/home/dev/Devices")" = "$sb/vol/CoreSimulator/Devices" ]
  expect "runner 1's workspace content came across" [ "$(cat "$sb/vol/actions-runner-ios-1/_work/repo/file")" = "ws-1" ]
  expect "...and is reachable through the link" [ "$(cat "$sb/home/actions-runner-ios-1/_work/repo/file")" = "ws-1" ]
  expect "the device came across" [ -f "$sb/vol/CoreSimulator/Devices/AAAA/device.plist" ]
  expect "the internal copies are gone" [ ! -e "$sb/home/actions-runner-ios-1/_work.pre-ci-work" ] && [ ! -e "$sb/home/dev/Devices.pre-ci-work" ]

  rc=0; out="$(run cutover)" || rc=$?
  expect "a second cutover is a no-op (rc=$rc)" [ "$rc" = "0" ]
  expect "...that says so" matches "$out" "*already linked*"

  # Link points somewhere else: never guess.
  mkdir -p "$sb/elsewhere"; rm "$sb/home/actions-runner-ios-1/_work"; ln -s "$sb/elsewhere" "$sb/home/actions-runner-ios-1/_work"
  rc=0; out="$(run cutover)" || rc=$?
  expect "a _work link to somewhere else is refused, not overwritten (rc=$rc)" [ "$rc" != "0" ]
  expect "...and the other link is left alone" [ "$(readlink "$sb/home/actions-runner-ios-1/_work")" = "$sb/elsewhere" ]
  rm "$sb/home/actions-runner-ios-1/_work"; ln -s "$sb/vol/actions-runner-ios-1/_work" "$sb/home/actions-runner-ios-1/_work"

  rm -f "$sb/attached"
  rc=0; out="$(run rollback)" || rc=$?
  expect "rollback refuses when the volume is detached, rather than lose what is on it (rc=$rc)" [ "$rc" != "0" ]
  expect "...and the link is still there" [ -L "$sb/home/actions-runner-ios-1/_work" ]
  : > "$sb/attached"
  rc=0; out="$(run rollback)" || rc=$?
  expect "rollback succeeds when attached and idle (rc=$rc)" [ "$rc" = "0" ]
  expect "runner 1's _work is a plain directory again, with its content" [ ! -L "$sb/home/actions-runner-ios-1/_work" ] && [ "$(cat "$sb/home/actions-runner-ios-1/_work/repo/file")" = "ws-1" ]
  expect "the device set is a plain directory again, with its device" [ ! -L "$sb/home/dev/Devices" ] && [ -f "$sb/home/dev/Devices/AAAA/device.plist" ]

  # A leftover from an earlier attempt must stop a second cutover, not be clobbered.
  mkdir -p "$sb/home/actions-runner-ios-1/_work.pre-ci-work"
  rc=0; out="$(run cutover)" || rc=$?
  expect "a leftover .pre-ci-work from an earlier attempt stops cutover (rc=$rc)" [ "$rc" != "0" ]
  rmdir "$sb/home/actions-runner-ios-1/_work.pre-ci-work"

  say "── selftest: the attach agent ──"
  rc=0; out="$(run install-agent)" || rc=$?
  expect "install-agent writes the plist (rc=$rc)" [ -f "$sb/agent.plist" ]
  expect "the plist re-runs at load and every minute" \
    matches "$(cat "$sb/agent.plist")" "*<key>RunAtLoad</key><true/>*<key>StartInterval</key><integer>60</integer>*"
  expect "the wrapper bakes in the image path" matches "$(cat "$sb/state/ci-work-attach.sh")" "*CIWork.sparsebundle*"
  bash -n "$sb/state/ci-work-attach.sh" && ok "the wrapper parses" || fail "the wrapper does not parse"
  : > "$sb/hdiutil.calls"
  ( PATH="$stubs:$PATH"; bash "$sb/state/ci-work-attach.sh" ) >/dev/null 2>&1 || true
  expect "the wrapper does nothing when the volume is already attached" [ ! -s "$sb/hdiutil.calls" ]
  rm -f "$sb/attached"
  ( PATH="$stubs:$PATH"; bash "$sb/state/ci-work-attach.sh" ) >/dev/null 2>&1 || true
  expect "the wrapper attaches it when it is not" [ -f "$sb/attached" ]
  rm -f "$sb/attached" "$sb/ssd/CIWork.sparsebundle"
  ( PATH="$stubs:$PATH"; bash "$sb/state/ci-work-attach.sh" ) >/dev/null 2>&1 || true
  expect "the wrapper names the failure when the SSD is not there" matches "$(cat "$sb/state/ci-work-attach.log")" "*NOT attached*"

  say ""
  if [ "$fails" -ne 0 ]; then
    say "mac-ci-work-volume selftest FAILED: $fails case(s)"
    return 1
  fi
  say "selftest passed: the volume is never linked while detached, denied or busy, and what moves is kept"
}

SELF="${BASH_SOURCE[0]}"

case "${1:-status}" in
  status)        status ;;
  create)        create ;;
  attach)        attach ;;
  install-agent) install_agent ;;
  verify)        verify ;;
  cutover)       cutover ;;
  rollback)      rollback ;;
  selftest)      selftest ;;
  *) say "usage: $(basename "$0") <status|create|attach|install-agent|verify|cutover|rollback|selftest>"; exit 2 ;;
esac
