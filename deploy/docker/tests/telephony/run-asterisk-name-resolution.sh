#!/usr/bin/env bash
# Prove the PBX image resolves SIP targets given by NAME (#1690), by breaking it.
#
# The upstream image ships no res_resolver_unbound, so Asterisk falls back to
# its built-in "system" resolver, which asks the DNS servers in resolv.conf and
# NEVER reads /etc/hosts. A SIP target that is a name known only from /etc/hosts
# (compose `extra_hosts`, a hosts-file entry on a rehearsal VM) therefore ends
# in res_pjsip's "Resolution completed - 0 viable targets" — which reads like a
# typo in the configuration, not a missing module.
#
# This builds the image from Dockerfile.asterisk, and measures THREE targets
# against a live responder, on two images:
#
#   target        what it is                          pinned base  our image
#   hosts-only    a name only /etc/hosts knows        UNAVAILABLE  AVAILABLE   <- the defect
#   dns-name      a name Docker's DNS resolves        AVAILABLE    AVAILABLE   <- must not regress
#   no-such-name  a name nothing resolves             UNAVAILABLE  UNAVAILABLE <- clear failure
#
# The pinned upstream image is the CONTROL: if it ever resolves hosts-only too,
# this harness could no longer see the defect it exists to catch, and it fails
# rather than pass. The same goes for a "resolver" that loaded but resolves
# nothing: dns-name must stay reachable, so a module that breaks Docker's
# embedded DNS cannot ship.
#
# Usage: deploy/docker/tests/telephony/run-asterisk-name-resolution.sh [--keep]
# Needs: Docker. No network access beyond pulling the images.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
DOCKER_DIR="$ROOT/deploy/docker"
KEEP=false
[[ "${1:-}" == "--keep" ]] && KEEP=true

RUN_ID="ll-name-res-$$"
NET="$RUN_ID"
WORK="$(mktemp -d)"
OURS_IMAGE="$RUN_ID:ours"

# The control is whatever Dockerfile.asterisk builds ON, so bumping the pin there
# moves the control with it.
BASE_IMAGE="$(sed -n 's/^FROM \(andrius\/asterisk@sha256:[0-9a-f]\{64\}\).*/\1/p' "$DOCKER_DIR/Dockerfile.asterisk")"
[[ -n "$BASE_IMAGE" ]] || { echo "FAIL: no andrius/asterisk pin found in Dockerfile.asterisk" >&2; exit 2; }

cleanup() {
  if $KEEP; then
    echo "kept: network $NET, work dir $WORK, image $OURS_IMAGE" >&2
    return
  fi
  docker rm -f "$RUN_ID-pbx" "$RUN_ID-peer" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rmi "$OURS_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== building Dockerfile.asterisk"
docker build -q -f "$DOCKER_DIR/Dockerfile.asterisk" -t "$OURS_IMAGE" "$DOCKER_DIR" >/dev/null

docker network create "$NET" >/dev/null

# A responder that answers SIP OPTIONS with 200, so "Avail" means the request
# really reached it. The pinned image carries python3, so it doubles as one.
cat >"$WORK/peer.py" <<'PY'
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(("0.0.0.0", 5060))
while True:
    data, addr = s.recvfrom(65535)
    lines = data.decode(errors="replace").split("\r\n\r\n")[0].split("\r\n")
    if not lines[0].startswith("OPTIONS"):
        continue
    keep = []
    for line in lines[1:]:
        name = line.split(":")[0].lower()
        if name in ("via", "from", "call-id", "cseq"):
            keep.append(line)
        elif name == "to":
            keep.append(line + ";tag=peer")
    s.sendto("\r\n".join(["SIP/2.0 200 OK"] + keep + ["Content-Length: 0", "", ""]).encode(), addr)
PY

# `dns-name` is resolved through Docker's embedded DNS (a network alias);
# `hosts-only` exists only as an /etc/hosts entry on the PBX container.
cat >"$WORK/pjsip.conf" <<'CONF'
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060

[hosts-only]
type=aor
contact=sip:hosts-only.pbx.internal
qualify_frequency=2
qualify_timeout=1.0
[hosts-only-ep]
type=endpoint
aors=hosts-only

[dns-name]
type=aor
contact=sip:dns-name.pbx.internal
qualify_frequency=2
qualify_timeout=1.0
[dns-name-ep]
type=endpoint
aors=dns-name

[no-such-name]
type=aor
contact=sip:no-such-name.pbx.internal
qualify_frequency=2
qualify_timeout=1.0
[no-such-name-ep]
type=endpoint
aors=no-such-name
CONF

# Debug lines must reach the container log for the "viable targets" evidence.
cat >"$WORK/logger.conf" <<'CONF'
[general]
[logfiles]
console => notice,warning,error,debug
CONF

docker run -d --name "$RUN_ID-peer" --network "$NET" --network-alias dns-name.pbx.internal \
  -v "$WORK/peer.py:/peer.py:ro" --entrypoint python3 "$OURS_IMAGE" /peer.py >/dev/null
PEER_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$RUN_ID-peer")"

FAILURES=0
fail() { echo "  FAIL: $*" >&2; FAILURES=$((FAILURES + 1)); }

pbx() { docker exec "$RUN_ID-pbx" asterisk -rx "$@"; }

# Status of the single contact on an AOR, after qualify has had time to settle.
contact_status() {
  local aor="$1" status="" i
  for i in $(seq 1 30); do
    status="$(pbx "pjsip show contacts" | awk -v aor="$aor/" 'index($2, aor) == 1 { print $4 }')"
    [[ -n "$status" && "$status" != "NonQual" && "$status" != "Unknown" ]] && break
    sleep 0.5
  done
  echo "${status:-missing}"
}

measure() {
  local label="$1" image="$2" expect_hosts_only="$3"
  echo "== $label ($image)"
  docker rm -f "$RUN_ID-pbx" >/dev/null 2>&1 || true
  docker run -d --name "$RUN_ID-pbx" --network "$NET" \
    --add-host "hosts-only.pbx.internal:$PEER_IP" \
    -v "$WORK/pjsip.conf:/etc/asterisk/pjsip.conf:ro" \
    -v "$WORK/logger.conf:/etc/asterisk/logger.conf:ro" \
    --entrypoint asterisk "$image" -f -T -W -vvv >/dev/null
  for _ in $(seq 1 60); do pbx "core waitfullybooted" >/dev/null 2>&1 && break; sleep 0.5; done
  pbx "core set debug 2" >/dev/null

  local hosts_only dns_name no_such
  hosts_only="$(contact_status hosts-only)"
  dns_name="$(contact_status dns-name)"
  no_such="$(contact_status no-such-name)"
  echo "  hosts-only=$hosts_only dns-name=$dns_name no-such-name=$no_such"
  echo "  resolver modules: $(pbx "module show like resolver" | tail -1)"

  [[ "$hosts_only" == "$expect_hosts_only" ]] || fail "$label: hosts-only is $hosts_only, expected $expect_hosts_only"
  [[ "$dns_name" == "Avail" ]] || fail "$label: dns-name is $dns_name — a name Docker's DNS resolves must be reachable"
  [[ "$no_such" == "Unavail" ]] || fail "$label: no-such-name is $no_such — a name nothing resolves must fail"

  # Evidence that it is the RESOLVER that failed: Asterisk logs the count for
  # every lookup it makes. Printed, not asserted — it grows with elapsed time.
  local viable
  viable="$(docker logs "$RUN_ID-pbx" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c 'Resolution completed - 0 viable targets' || true)"
  echo "  lookups that ended in '0 viable targets': $viable"
}

measure control "$BASE_IMAGE" Unavail
measure ours "$OURS_IMAGE" Avail

# `ours` ran above as the image's DEFAULT user (no --user override): it must be
# unprivileged, and the resolver must work for that user.
OURS_USER="$(docker inspect -f '{{.Config.User}}' "$OURS_IMAGE")"
[[ "$OURS_USER" == "asterisk" ]] || fail "ours: image default user is '${OURS_USER:-root}', expected asterisk"

if ! docker exec "$RUN_ID-pbx" asterisk -rx "module show like res_resolver_unbound" | grep -q "res_resolver_unbound.so.*Running"; then
  fail "ours: res_resolver_unbound is not running"
fi

if [[ "$FAILURES" -ne 0 ]]; then
  echo "FAIL: $FAILURES check(s) failed" >&2
  exit 1
fi
echo "PASS: names known only to /etc/hosts resolve with the resolver module and fail without it; DNS names and unresolvable names are unchanged"
