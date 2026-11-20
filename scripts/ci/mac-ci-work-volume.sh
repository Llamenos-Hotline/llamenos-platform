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
# WHAT THE LINK COSTS A WORKFLOW
# ------------------------------
# A job's workspace now has two names: GITHUB_WORKSPACE is the link path
# (~/actions-runner-ios-<N>/_work/...), a step's cwd is the resolved one
# (/Volumes/CIWork/actions-runner-ios-<N>/_work/...). Anything that resolves a
# relative path from the cwd and then relativises it against GITHUB_WORKSPACE
# gets `../../../../../../Volumes/CIWork/actions-runner-ios-<N>/...`, naming
# THIS runner. actions/cache does exactly that, so an entry saved on one runner
# restored into the other runner's workspace (#2785's ejection, 2026-11-16).
# Mac jobs therefore give actions/cache absolute paths under github.workspace;
# mac-ci-work-volume.test.ts fails any workflow that does not.
#
# USAGE (run on the Mac, from an ssh session; no sudo anywhere)
#   mac-ci-work-volume.sh status           what exists, what is attached, where each link points
#   mac-ci-work-volume.sh create           create the sparsebundle on the SSD (once)
#   mac-ci-work-volume.sh attach           attach it (idempotent)
#   mac-ci-work-volume.sh install-agent    LaunchAgent that keeps it attached across logins/drops
#   mac-ci-work-volume.sh verify           prove a LAUNCHD-started process can use the volume
#   mac-ci-work-volume.sh cutover          move idle runners' `_work` and the simulator device set onto it
#   mac-ci-work-volume.sh rollback         put them back on the internal disk
#   mac-ci-work-volume.sh rollback --discard-missing
#                                          the volume is GONE FOR GOOD: replace each dangling link with an
#                                          empty real directory (refuses unless every target is absent)
#   mac-ci-work-volume.sh runner-health    assert a Runner.Listener process exists for every install
#   mac-ci-work-volume.sh runner-start     kickstart installs with no Listener and assert it came up
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
START_WAIT_SEC="${MAC_CI_RUNNER_START_WAIT_SEC:-30}"

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
  runner_has_process "$1" Worker
}

# runner_has_process <runner-root> <Worker|Listener>: is that process running
# from this install's bin directory? The process table is the only honest
# answer: `launchctl list` shows a loaded agent with a `-` PID, and `svc.sh
# start` prints "Started" and exits 0, for an agent that is not running.
runner_has_process() {
  local root="$1" kind="$2"
  ps -Ao command 2>/dev/null | awk -v r="$root/bin" -v k="Runner[.]$kind" 'index($0, r) == 1 && $0 ~ k { f = 1 } END { exit !f }'
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
    # An install that has run jobs: its `_work` exists. A configured-but-never-
    # used install (a registration that was since removed) has none, and gets
    # no link made for it.
    [ -d "$d" ] && [ -f "$d/.runner" ] && { [ -e "$d/_work" ] || [ -L "$d/_work" ]; } && printf '%s\n' "$d"
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
  if [ -f "$STATE/ci-work-attach.failing" ]; then
    say "  FAILING: $(sed -n 1p "$STATE/ci-work-attach.failing") consecutive failed attach attempts, the first at $(sed -n 2p "$STATE/ci-work-attach.failing")"
    say "  the SSD or the image is not coming back; if it is lost for good, see 'rollback --discard-missing'"
  fi
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
    printf 'IMAGE=%q\nMOUNT=%q\nLOG=%q\nFAILFILE=%q\n' "$IMAGE" "$MOUNT" "$STATE/ci-work-attach.log" "$STATE/ci-work-attach.failing"
    cat <<'WRAPPER_BODY'
# Exit status is the signal: 0 only when the volume is attached, 1 when this run
# could not attach it, so `launchctl list` shows a real last-exit code instead
# of a permanent 0 for an agent that has never succeeded. The attempt is made on
# every run (it is cheap and it is how a returning SSD is noticed within a
# minute); what backs off is the LOG, so a lost SSD writes a handful of lines
# rather than one a minute forever. Consecutive failures are counted in
# $FAILFILE (count, then the first failure's time), which `status` reports and
# which is removed the moment the volume is attached.
set -u
now() { date -u +%FT%TZ; }
log() { mkdir -p "$(dirname "$LOG")"; printf '%s %s\n' "$(now)" "$*" >> "$LOG"; tail -500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"; }
mounted() { local l; l="$(mount 2>/dev/null)"; case "$l" in *" on $MOUNT ("*) return 0 ;; esac; return 1; }

if mounted; then rm -f "$FAILFILE"; exit 0; fi

fails=0; since=""
if [ -f "$FAILFILE" ]; then
  read -r fails < "$FAILFILE" || true
  since="$(sed -n 2p "$FAILFILE")"
fi
case "$fails" in ''|*[!0-9]*) fails=0 ;; esac

out="$(hdiutil attach "$IMAGE" -nobrowse -noverify -quiet 2>&1)"
if mounted; then
  : > "$MOUNT/.metadata_never_index" 2>/dev/null
  if [ "$fails" -gt 0 ]; then log "attached at $MOUNT after $fails failed attempt(s) since $since"; else log "attached at $MOUNT"; fi
  rm -f "$FAILFILE"
  exit 0
fi

fails=$((fails + 1))
[ -n "$since" ] || since="$(now)"
mkdir -p "$(dirname "$FAILFILE")"
printf '%s\n%s\n' "$fails" "$since" > "$FAILFILE"
# Logged on the 1st failure, each power of two after it, and hourly: 1,2,4,8,16,32,64,120,180...
if [ $((fails & (fails - 1))) -eq 0 ] || [ $((fails % 60)) -eq 0 ]; then
  log "NOT attached (attempt $fails, failing since $since): the SSD is not mounted, the image is gone, or $MOUNT is claimed by another volume. ${out:-no output from hdiutil}"
fi
if [ "$fails" -eq 5 ]; then
  log "ALERT: $IMAGE has not attached for 5 consecutive minutes. Every iOS job needs this volume. If the SSD is lost for good, run: mac-ci-work-volume.sh rollback --discard-missing"
fi
exit 1
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
    # --delete: the target must MIRROR the source. A copy left on the volume by an
    # earlier rollback is stale, and merging into it would resurrect files the
    # runner had already removed.
    rsync -a --delete "$link/" "$target/" || die "copying $link to $target failed; $link is untouched"
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
  rsync -a --delete "$target/" "$tmp/" || die "copying $target back failed; $link is untouched"
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
  local roots d discard=0
  case "${1:-}" in
    "") ;;
    --discard-missing) discard=1 ;;
    *) die "rollback: unknown argument '$1' (the only one is --discard-missing)" ;;
  esac
  if [ "$discard" -eq 1 ]; then
    roots="$(runner_roots)"
    # shellcheck disable=SC2086
    discard_missing $roots
    return 0
  fi
  # Not attached means what the links point at is not there to copy back from.
  is_mounted || die "$MOUNT is not attached: attach it first, or what the links point at cannot be copied back and would be lost. If the volume is gone for good (the SSD is dead or missing), run: rollback --discard-missing"
  roots="$(runner_roots)"
  # shellcheck disable=SC2086
  check_idle $roots
  say "── rollback: putting what jobs write back on the internal disk ──"
  for d in $roots; do unlink_back "$d/_work"; done
  unlink_back "$SIM_DEVICES"
}

# The link's target as an absolute path (a relative one is relative to the
# link's own directory, not to the cwd).
link_target() { # link_target <link>
  local t
  t="$(readlink "$1")"
  case "$t" in /*) printf '%s\n' "$t" ;; *) printf '%s/%s\n' "$(dirname "$1")" "$t" ;; esac
}

# rollback --discard-missing: the volume is lost for good, so the links can never
# be followed and there is nothing to copy back. Replaces each dangling link with
# an empty real directory so the runner and CoreSimulator have somewhere to write.
#
# Proceeds ONLY on proof that nothing is being thrown away: every link's target
# is absent, and the image is not on disk (an image that exists is a volume that
# merely needs attaching, and discarding then would destroy what is on it). One
# present target, or a present image, refuses and changes nothing; so does a
# partially attached volume. The whole check is done before the first removal.
discard_missing() { # discard_missing <runner-root...>
  local d link target links="" present="" n=0
  for d in "$@"; do
    if [ -L "$d/_work" ]; then links="$links$d/_work
"; fi
  done
  if [ -L "$SIM_DEVICES" ]; then links="$links$SIM_DEVICES
"; fi
  if [ -z "$links" ]; then
    say "nothing to discard: no CI work volume links exist (already rolled back)"
    return 0
  fi
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    target="$(link_target "$link")"
    if [ -e "$target" ] || [ -L "$target" ]; then present="$present  $link -> $target
"; fi
  done <<EOF
$links
EOF
  [ -z "$present" ] || die "refusing --discard-missing: these link targets still exist, so the volume is not provably lost (attach it and run a plain rollback):
$present"
  if [ -e "$IMAGE" ]; then
    die "refusing --discard-missing: $IMAGE still exists, so the volume can be attached and its contents copied back. Run attach, then a plain rollback."
  fi
  if is_mounted; then die "refusing --discard-missing: $MOUNT is attached. Run a plain rollback."; fi
  check_idle "$@"
  say "── rollback --discard-missing: the CI work volume is lost; discarding what its links pointed at ──"
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    target="$(link_target "$link")"
    rm "$link" || die "could not remove the dangling link $link"
    mkdir "$link" || die "removed $link but could not create a directory in its place"
    say "  DISCARDED: $link -> $target (absent); now an empty directory"
    n=$((n + 1))
  done <<EOF
$links
EOF
  say ""
  say "$n link(s) replaced. Whatever they pointed at is lost: the next job re-checks out its workspace, and"
  say "CoreSimulator starts with no devices (the job creates its own). Run runner-start to bring the runners up."
}

# ── runner liveness ─────────────────────────────────────────────────────────
#
# `svc.sh start` can print "Load failed: 5: Input/output error" then
# "Started: - 0 <label>" (a `-` PID: not running) and exit 0; `launchctl list`
# shows the agent loaded with `-` and last exit 0. Neither is a measurement of
# whether the runner is running. The process table is, and `launchctl kickstart
# -k` is what actually starts a loaded agent.

runner_label() { # runner_label <runner-root>: the launchd label of the install's service
  local plist
  [ -f "$1/.service" ] || return 1
  plist="$(head -n 1 "$1/.service")"
  [ -n "$plist" ] || return 1
  basename "$plist" .plist
}

runner_health() {
  local roots d down=0
  roots="$(runner_roots)"
  [ -n "$roots" ] || die "no runner installs match $RUNNER_GLOB"
  for d in $roots; do
    if runner_has_process "$d" Listener; then
      say "  running: $(basename "$d") (Runner.Listener)"
    else
      say "  NOT RUNNING: $(basename "$d") has no Runner.Listener process (a loaded launchd agent with a '-' PID is not running)"
      down=$((down + 1))
    fi
  done
  [ "$down" -eq 0 ] || return 1
}

runner_start() {
  local roots d label waited failed=0 rc
  roots="$(runner_roots)"
  [ -n "$roots" ] || die "no runner installs match $RUNNER_GLOB"
  command -v launchctl >/dev/null 2>&1 || die "launchctl not found: this runs on the Mac"
  for d in $roots; do
    if runner_has_process "$d" Listener; then say "  already running: $(basename "$d")"; continue; fi
    label="$(runner_label "$d")" || { say "  FAILED: $(basename "$d") has no readable .service file naming its launchd agent"; failed=$((failed + 1)); continue; }
    say "  kickstarting $label"
    rc=0; launchctl kickstart -k "gui/$(id -u)/$label" || rc=$?
    [ "$rc" -eq 0 ] || say "  (launchctl kickstart returned $rc)"
    waited=0
    until runner_has_process "$d" Listener || [ "$waited" -ge "$START_WAIT_SEC" ]; do sleep 1; waited=$((waited + 1)); done
    if runner_has_process "$d" Listener; then
      say "  started: $(basename "$d") (Runner.Listener is running)"
    else
      say "  FAILED: $(basename "$d") has no Runner.Listener ${START_WAIT_SEC}s after kickstart; the agent is loaded but nothing is running"
      failed=$((failed + 1))
    fi
  done
  [ "$failed" -eq 0 ] || return 1
}

# ── selftest ────────────────────────────────────────────────────────────────
#
# Drives every command above against stubs, anywhere (Linux CI included). The
# stubs stand in for the macOS tools; what is under test is this script's own
# decisions: that it will not move a busy runner's workspace, will not link
# onto a detached volume, keeps the data it moves, and says so when a removal
# did not happen.

# shellcheck disable=SC2016  # expect_that takes its condition as a single-quoted string, evaluated later
selftest() {
  local sb fails=0 stubs out rc
  sb="$(mktemp -d "${TMPDIR:-/tmp}/ci-work-selftest.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$sb'" EXIT
  stubs="$sb/stubs"; mkdir -p "$stubs"

  ok()   { say "  ok    $1"; }
  fail() { say "  FAIL  $1"; fails=$((fails + 1)); }
  expect() { local label="$1"; shift; if "$@"; then ok "$label"; else fail "$label"; fi; }
  # expect_that <label> '<condition>': the WHOLE condition is evaluated, so a
  # `[ a ] && [ b ]` cannot pass on its first clause alone.
  expect_that() { if eval "$2"; then ok "$1"; else fail "$1"; fi; }
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
  kickstart) echo "\$@" >> "$sb/kickstart.calls"
             if [ -f "$sb/kickstart-works" ]; then for n in "\$@"; do :; done; n="\${n##*ios-}"; echo "$sb/home/actions-runner-ios-\$n/bin.2.338.2/Runner.Listener run --startuptype service" >> "$sb/ps.out"; fi
             exit 0 ;;
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
  for n in 1 2; do echo "/Users/x/Library/LaunchAgents/actions.runner.test.ios-$n.plist" > "$sb/home/actions-runner-ios-$n/.service"; done
  # Everything the script reads from the environment, pointed at the sandbox.
  run() {
    ( PATH="$stubs:$PATH"
      MAC_CI_WORK_MOUNT="$sb/vol" MAC_CI_WORK_IMAGE_DIR="$sb/ssd" MAC_CI_WORK_IMAGE="$sb/ssd/CIWork.sparsebundle"
      MAC_CI_WORK_STATE="$sb/state" MAC_CI_RUNNER_GLOB="$sb/home/actions-runner-ios-*" MAC_CI_SIM_DEVICES="$sb/home/dev/Devices"
      MAC_CI_WORK_AGENT_PLIST="$sb/agent.plist" MAC_CI_WORK_PROBE_WAIT_SEC=3 MAC_CI_RUNNER_START_WAIT_SEC=2
      export PATH MAC_CI_WORK_MOUNT MAC_CI_WORK_IMAGE_DIR MAC_CI_WORK_IMAGE MAC_CI_WORK_STATE MAC_CI_RUNNER_GLOB MAC_CI_SIM_DEVICES MAC_CI_WORK_AGENT_PLIST MAC_CI_WORK_PROBE_WAIT_SEC MAC_CI_RUNNER_START_WAIT_SEC
      bash "$SELF" "$@" ) 2>&1
  }

  say "── selftest: the CI work volume commands, against stubs ──"

  rc=0; out="$(run cutover)" || rc=$?
  expect "cutover refuses while the image is not attached (rc=$rc)" [ "$rc" != "0" ]
  expect "...and says to attach it" matches "$out" "*is not attached*"
  expect_that "...and moved nothing" '[ -d "$sb/home/actions-runner-ios-1/_work" ] && [ ! -L "$sb/home/actions-runner-ios-1/_work" ]'

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

  # A stale copy left on the volume by an earlier rollback must not leak into the
  # new workspace: the target is made to mirror the source.
  mkdir -p "$sb/vol/actions-runner-ios-1/_work/repo"; echo stale > "$sb/vol/actions-runner-ios-1/_work/repo/stale-file"
  rc=0; out="$(run cutover)" || rc=$?
  expect "cutover succeeds when attached, verified and idle (rc=$rc)" [ "$rc" = "0" ]
  expect "a stale file left on the volume by an earlier rollback does not survive the cutover" [ ! -e "$sb/vol/actions-runner-ios-1/_work/repo/stale-file" ]
  expect "runner 1's _work is now a link into the volume" [ "$(readlink "$sb/home/actions-runner-ios-1/_work")" = "$sb/vol/actions-runner-ios-1/_work" ]
  expect "runner 2's _work is now a link into the volume" [ "$(readlink "$sb/home/actions-runner-ios-2/_work")" = "$sb/vol/actions-runner-ios-2/_work" ]
  expect "the device set is a link into the volume" [ "$(readlink "$sb/home/dev/Devices")" = "$sb/vol/CoreSimulator/Devices" ]
  expect "runner 1's workspace content came across" [ "$(cat "$sb/vol/actions-runner-ios-1/_work/repo/file")" = "ws-1" ]
  expect "...and is reachable through the link" [ "$(cat "$sb/home/actions-runner-ios-1/_work/repo/file")" = "ws-1" ]
  expect "the device came across" [ -f "$sb/vol/CoreSimulator/Devices/AAAA/device.plist" ]
  expect_that "the internal copies are gone" '[ ! -e "$sb/home/actions-runner-ios-1/_work.pre-ci-work" ] && [ ! -e "$sb/home/dev/Devices.pre-ci-work" ]'

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
  expect_that "runner 1's _work is a plain directory again, with its content" '[ ! -L "$sb/home/actions-runner-ios-1/_work" ] && [ "$(cat "$sb/home/actions-runner-ios-1/_work/repo/file")" = "ws-1" ]'
  expect_that "the device set is a plain directory again, with its device" '[ ! -L "$sb/home/dev/Devices" ] && [ -f "$sb/home/dev/Devices/AAAA/device.plist" ]'

  # A leftover from an earlier attempt must stop a second cutover, not be clobbered.
  mkdir -p "$sb/home/actions-runner-ios-1/_work.pre-ci-work"
  rc=0; out="$(run cutover)" || rc=$?
  expect "a leftover .pre-ci-work from an earlier attempt stops cutover (rc=$rc)" [ "$rc" != "0" ]
  rmdir "$sb/home/actions-runner-ios-1/_work.pre-ci-work"

  say "── selftest: rollback --discard-missing (the volume is lost for good) ──"
  # State here: rolled back, so _work and the device set are plain directories.
  rc=0; out="$(run rollback --discard-missing)" || rc=$?
  expect "discard-missing with no links is an idempotent no-op (rc=$rc)" [ "$rc" = "0" ]
  expect "...that says there was nothing to discard" matches "$out" "*nothing to discard*"
  expect_that "...and left the plain directories and their content alone" '[ "$(cat "$sb/home/actions-runner-ios-1/_work/repo/file")" = "ws-1" ] && [ -f "$sb/home/dev/Devices/AAAA/device.plist" ]'

  rc=0; out="$(run rollback --bogus)" || rc=$?
  expect "rollback rejects an unknown argument (rc=$rc)" [ "$rc" != "0" ]

  rc=0; out="$(run cutover)" || rc=$?
  expect_that "(setup) cutover links again (rc=$rc)" '[ "$rc" = "0" ] && [ -L "$sb/home/actions-runner-ios-1/_work" ]'
  # Lost volume, but one target survives (runner 1's workspace): a partial loss must refuse.
  rm -f "$sb/attached" "$sb/ssd/CIWork.sparsebundle"
  rm -rf "$sb/vol/actions-runner-ios-2" "$sb/vol/CoreSimulator"
  rc=0; out="$(run rollback --discard-missing)" || rc=$?
  expect "discard-missing refuses when one link target is still present (rc=$rc)" [ "$rc" = "1" ]
  expect "...and names the present target" matches "$out" "*actions-runner-ios-1/_work -> *"
  expect_that "...and every link is still a link" '[ -L "$sb/home/actions-runner-ios-1/_work" ] && [ -L "$sb/home/actions-runner-ios-2/_work" ] && [ -L "$sb/home/dev/Devices" ]'
  # Every target gone but the image file is still on the SSD: it can be attached, so it is not lost.
  rm -rf "$sb/vol/actions-runner-ios-1"
  : > "$sb/ssd/CIWork.sparsebundle"
  rc=0; out="$(run rollback --discard-missing)" || rc=$?
  expect "discard-missing refuses while the image still exists (rc=$rc)" [ "$rc" = "1" ]
  expect "...and tells the operator to attach it" matches "$out" "*Run attach*"
  expect_that "...and every link is still a link" '[ -L "$sb/home/actions-runner-ios-1/_work" ] && [ -L "$sb/home/dev/Devices" ]'
  rm -f "$sb/ssd/CIWork.sparsebundle"
  # A job is running: never signalled, never discarded under.
  printf '%s\n' "$sb/home/actions-runner-ios-2/bin.2.338.2/Runner.Worker spawnclient 3 4" > "$sb/ps.out"
  rc=0; out="$(run rollback --discard-missing)" || rc=$?
  expect_that "discard-missing refuses while a runner has a job (rc=$rc)" '[ "$rc" = "1" ] && [ -L "$sb/home/actions-runner-ios-2/_work" ]'
  : > "$sb/ps.out"
  # Every target provably absent, no image: proceed, and say what was discarded.
  rc=0; out="$(run rollback --discard-missing)" || rc=$?
  expect "discard-missing proceeds when every target is absent (rc=$rc)" [ "$rc" = "0" ]
  expect_that "...runner 1's _work is an empty real directory" '[ -d "$sb/home/actions-runner-ios-1/_work" ] && [ ! -L "$sb/home/actions-runner-ios-1/_work" ] && [ -z "$(ls -A "$sb/home/actions-runner-ios-1/_work")" ]'
  expect_that "...runner 2's _work is an empty real directory" '[ -d "$sb/home/actions-runner-ios-2/_work" ] && [ ! -L "$sb/home/actions-runner-ios-2/_work" ] && [ -z "$(ls -A "$sb/home/actions-runner-ios-2/_work")" ]'
  expect_that "...the device set is an empty real directory" '[ -d "$sb/home/dev/Devices" ] && [ ! -L "$sb/home/dev/Devices" ] && [ -z "$(ls -A "$sb/home/dev/Devices")" ]'
  expect "...and each discarded link is named in the report" matches "$out" "*DISCARDED: $sb/home/actions-runner-ios-1/_work -> *DISCARDED: $sb/home/actions-runner-ios-2/_work -> *DISCARDED: $sb/home/dev/Devices -> *"
  rc=0; out="$(run rollback --discard-missing)" || rc=$?
  expect_that "a second discard-missing is an idempotent no-op (rc=$rc)" '[ "$rc" = "0" ] && matches "$out" "*nothing to discard*"'
  # Put the sandbox back for the cases below.
  : > "$sb/ssd/CIWork.sparsebundle"; : > "$sb/attached"

  say "── selftest: runner liveness ──"
  : > "$sb/ps.out"; rm -f "$sb/kickstart.calls"
  rc=0; out="$(run runner-health)" || rc=$?
  expect "runner-health fails when no Runner.Listener is running (rc=$rc)" [ "$rc" = "1" ]
  expect "...and names each install that is down" matches "$out" "*NOT RUNNING: actions-runner-ios-1*NOT RUNNING: actions-runner-ios-2*"
  printf '%s\n' "$sb/home/actions-runner-ios-1/bin.2.338.2/Runner.Listener run --startuptype service" > "$sb/ps.out"
  rc=0; out="$(run runner-health)" || rc=$?
  expect_that "runner-health still fails when only one install has a Listener (rc=$rc)" '[ "$rc" = "1" ] && matches "$out" "*running: actions-runner-ios-1*NOT RUNNING: actions-runner-ios-2*"'
  : > "$sb/ps.out"
  rc=0; out="$(run runner-start)" || rc=$?
  expect "runner-start FAILS when kickstart leaves no process, whatever launchctl printed (rc=$rc)" [ "$rc" = "1" ]
  expect "...and says nothing is running" matches "$out" "*FAILED: actions-runner-ios-1 has no Runner.Listener*"
  expect "...it kickstarted by the label from .service, not svc.sh" matches "$(cat "$sb/kickstart.calls")" "*kickstart -k gui/*/actions.runner.test.ios-1*"
  touch "$sb/kickstart-works"; : > "$sb/ps.out"; rm -f "$sb/kickstart.calls"
  rc=0; out="$(run runner-start)" || rc=$?
  expect_that "runner-start succeeds once the Listener exists (rc=$rc)" '[ "$rc" = "0" ] && matches "$out" "*started: actions-runner-ios-1*started: actions-runner-ios-2*"'
  rm -f "$sb/kickstart.calls"
  rc=0; out="$(run runner-start)" || rc=$?
  expect_that "runner-start leaves a running install alone (rc=$rc)" '[ "$rc" = "0" ] && [ ! -e "$sb/kickstart.calls" ] && matches "$out" "*already running: actions-runner-ios-1*"'
  rc=0; out="$(run runner-health)" || rc=$?
  expect "runner-health passes when every install has a Listener (rc=$rc)" [ "$rc" = "0" ]
  : > "$sb/ps.out"; rm -f "$sb/kickstart-works"

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

  # A lost SSD: every run exits non-zero (launchd's last-exit is no longer a permanent 0),
  # the failure is counted, and the log backs off instead of growing one line a minute.
  wrap() { ( PATH="$stubs:$PATH"; bash "$sb/state/ci-work-attach.sh" ) >/dev/null 2>&1; }
  rm -f "$sb/state/ci-work-attach.log" "$sb/state/ci-work-attach.failing"
  rc=0; wrap || rc=$?
  expect "the wrapper exits non-zero when it could not attach (rc=$rc)" [ "$rc" = "1" ]
  expect "...and records the failure count" [ "$(sed -n 1p "$sb/state/ci-work-attach.failing")" = "1" ]
  for _ in 2 3 4; do wrap || true; done
  expect "the wrapper counts consecutive failures" [ "$(sed -n 1p "$sb/state/ci-work-attach.failing")" = "4" ]
  expect "...but logs only attempts 1, 2 and 4 (backoff), not one line per run" [ "$(grep -c 'NOT attached' "$sb/state/ci-work-attach.log" || true)" = "3" ]
  expect "...and has not alerted yet" [ "$(grep -c 'ALERT' "$sb/state/ci-work-attach.log" || true)" = "0" ]
  wrap || true
  expect "the fifth consecutive failure logs a loud ALERT naming the way out" matches "$(cat "$sb/state/ci-work-attach.log")" "*ALERT*rollback --discard-missing*"
  out="$(run status)" || true
  expect "status reports the attach agent as FAILING" matches "$out" "*FAILING: 5 consecutive failed attach attempts*"
  : > "$sb/ssd/CIWork.sparsebundle"
  rc=0; wrap || rc=$?
  expect_that "the wrapper exits 0 once the volume attaches (rc=$rc)" '[ "$rc" = "0" ] && [ -f "$sb/attached" ]'
  expect "...and clears the failure record" [ ! -e "$sb/state/ci-work-attach.failing" ]
  expect "...and logs how long it was down" matches "$(cat "$sb/state/ci-work-attach.log")" "*after 5 failed attempt(s)*"

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
  rollback)      shift; rollback "$@" ;;
  runner-health) runner_health ;;
  runner-start)  runner_start ;;
  selftest)      selftest ;;
  *) say "usage: $(basename "$0") <status|create|attach|install-agent|verify|cutover|rollback [--discard-missing]|runner-health|runner-start|selftest>"; exit 2 ;;
esac
