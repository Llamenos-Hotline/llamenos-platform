#!/usr/bin/env bash
# Simulator selection for the out-of-CI iOS scripts: resolve to a UDID, address
# the device by `id=`, never by name.
#
# Sourced by scripts/ios-build.sh, scripts/test-ios.sh and
# scripts/test-feature.sh. Must stay bash-3.2-safe: /bin/bash on macOS is 3.2.
#
# WHY
# ---
# `-destination "platform=iOS Simulator,name=iPhone 17"` makes xcodebuild
# resolve the name itself, and whatever it finds is a function of the installed
# Xcode, the installed runtime and whatever another job left in the device set.
# It can bind to a device this run does not own, to the wrong one of several
# with the same name, or adopt/create an Xcode-default device that nothing
# reaps: on the CI Mac one such device sat Shutdown for 61 hours holding
# 3.86 GiB (#1861). The CI jobs (`ios-build-test`, `ios-e2e / build (mac)`)
# `simctl create` their own device and pin it by UDID; the local scripts do the
# same here (#2861).
#
# Two entry points, each returning exactly one UDID on stdout (everything else
# goes to stderr) or failing loudly:
#
#   ios_sim_resolve_dedicated NAME   create-or-reuse the dedicated device NAME.
#                                    0 matches -> create it; 1 -> reuse it;
#                                    2+ -> fail (we cannot know which we own).
#   ios_sim_resolve_override REF     a human asked for a specific device. REF is
#                                    a device name or a UDID. 0 matches -> fail
#                                    (never create: a typo must not mint an
#                                    unowned device); 2+ -> fail, listing the
#                                    UDIDs so the human can pass one.
#
# The Mac's disk guard reaps a dedicated device once it sits Shutdown past
# MAC_SIM_STALE_MAX_AGE_HOURS (default 24h); the next run creates it again.

ios_sim_log() { printf '[ios-sim] %s\n' "$*" >&2; }

# Print the UDID of every available iOS simulator whose name OR udid equals
# REF (case-insensitive on the UDID), one per line.
ios_sim_lookup() {
  xcrun simctl list devices available -j | python3 -c "
import json, sys
ref = sys.argv[1]
data = json.load(sys.stdin)
for runtime, devices in data.get('devices', {}).items():
    if 'iOS' not in runtime:
        continue
    for d in devices:
        if not d.get('isAvailable'):
            continue
        if d.get('name') == ref or d.get('udid', '').lower() == ref.lower():
            print(d['udid'])
" "$1"
}

# Create a device named NAME on the newest available iOS runtime, trying iPhone
# types newest-first until simctl accepts one: a type newer than the installed
# runtime is listed but refused ("Incompatible device"). Prints the new UDID.
ios_sim_create() {
  local name="$1" runtime types type udid errfile
  runtime=$(xcrun simctl list runtimes -j | python3 -c "
import json, sys
rs = [r for r in json.load(sys.stdin)['runtimes']
      if r.get('isAvailable') and r.get('platform') == 'iOS']
if not rs: sys.exit('no available iOS runtime')
print(sorted(rs, key=lambda r: r['version'], reverse=True)[0]['identifier'])
") || return 1
  types=$(xcrun simctl list devicetypes -j | python3 -c "
import json, sys
ts = [t['identifier'] for t in json.load(sys.stdin)['devicetypes']
      if t.get('name', '').startswith('iPhone')]
if not ts: sys.exit('simctl lists no iPhone device types')
for t in ts:
    print(t)
") || return 1
  errfile="${TMPDIR:-/tmp}/ios-simulator-create.$$.err"
  for type in $types; do
    if udid=$(xcrun simctl create "$name" "$type" "$runtime" 2>"$errfile"); then
      rm -f "$errfile"
      ios_sim_log "created simulator: $name ($udid)"
      echo "$udid"
      return 0
    fi
    ios_sim_log "simctl refused $type on $runtime: $(tr '\n' ' ' < "$errfile")"
  done
  rm -f "$errfile"
  ios_sim_log "ERROR: could not create an iPhone simulator on $runtime; simctl refused every iPhone device type"
  return 1
}

ios_sim_resolve_dedicated() {
  local name="$1" matches count
  matches=$(ios_sim_lookup "$name") || return 1
  count=$(printf '%s' "$matches" | grep -c . || true)
  case "$count" in
    0)
      ios_sim_log "no simulator named '$name'; creating the dedicated one"
      ios_sim_create "$name"
      ;;
    1)
      echo "$matches"
      ;;
    *)
      ios_sim_log "ERROR: $count simulators are named '$name' ($(printf '%s' "$matches" | tr '\n' ' '))."
      ios_sim_log "Refusing to guess which one this run owns. Delete the extras (xcrun simctl delete <udid>)."
      return 1
      ;;
  esac
}

ios_sim_resolve_override() {
  local ref="$1" matches count
  matches=$(ios_sim_lookup "$ref") || return 1
  count=$(printf '%s' "$matches" | grep -c . || true)
  case "$count" in
    0)
      ios_sim_log "ERROR: no available iOS simulator has the name or UDID '$ref'."
      ios_sim_log "List them with: xcrun simctl list devices available"
      return 1
      ;;
    1)
      echo "$matches"
      ;;
    *)
      ios_sim_log "ERROR: $count simulators are named '$ref' ($(printf '%s' "$matches" | tr '\n' ' '))."
      ios_sim_log "Pass the UDID of the one you mean instead of its name."
      return 1
      ;;
  esac
}
