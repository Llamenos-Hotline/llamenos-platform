#!/usr/bin/env bash
# Smoke-test a BUILT app image against a real PostgreSQL 17 (SCRAM-SHA-256).
#
#   scripts/image-smoke.sh <image>                 # on this host's CPU
#   scripts/image-smoke.sh --cpu kvm64 <image>     # inside a KVM guest whose
#                                                  # virtual CPU hides SSE4.2
#
# Passes only if the image's REAL entrypoint, running with production
# hardening (read-only rootfs, tmpfs /tmp, no-new-privileges, 1 CPU):
#   1. passes scripts/verify-runtime.ts (Bun's simdutf text layer works),
#   2. authenticates to stock postgres:17-alpine over SCRAM-SHA-256,
#   3. applies every migration and reaches "Starting application...",
# and PostgreSQL afterwards holds the migrated schema.
#
# Why --cpu exists: Bun >= 1.4 selects simdutf's no-op stub on a VM CPU model
# that hides SSE4.2 in CPUID (kvm64/qemu64). CI runners expose honest CPUID, so
# a native run can never see that failure; only a KVM guest with a masked CPU
# model reproduces what a VPS host does. See the "simdutf kernel pin" block in
# deploy/docker/Dockerfile. The --cpu mode needs /dev/kvm, qemu-system-x86_64,
# qemu-img and genisoimage, and network access for the guest's apt.
#
# Exit status: 0 = pass, 1 = the image failed the smoke, 2 = usage/environment.
set -euo pipefail

usage() { sed -n '2,6p' "$0" >&2; exit 2; }

CPU_MODEL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu) CPU_MODEL="${2:?--cpu needs a QEMU CPU model}"; shift 2 ;;
    -h|--help) usage ;;
    --) shift; break ;;
    -*) echo "unknown option: $1" >&2; usage ;;
    *) break ;;
  esac
done
IMAGE="${1:-}"
[ -n "$IMAGE" ] || usage

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SMOKE_TIMEOUT_SEC="${SMOKE_TIMEOUT_SEC:-240}"
# Obviously-fake credential for a throwaway container; never a real secret.
PG_PASSWORD="smoke-test-not-a-secret"

# The PostgreSQL image the product actually deploys — read from the compose
# file rather than restated here, so the smoke can never drift from it.
PG_IMAGE="${PG_IMAGE:-$(awk '/^  postgres:/{f=1} f && /image:/{print $2; exit}' "$REPO_ROOT/deploy/docker/docker-compose.yml")}"
[ -n "$PG_IMAGE" ] || { echo "could not read the postgres image from deploy/docker/docker-compose.yml" >&2; exit 2; }

log() { echo "[image-smoke] $*"; }

# ─────────────────────────────────────────────────────────────────────────
# Native mode: run the smoke with this host's CPU.
# ─────────────────────────────────────────────────────────────────────────
# Globals (not locals) because the EXIT trap runs after native_smoke returns.
SMOKE_ID="smoke-$$-$RANDOM"
net="$SMOKE_ID-net" pg="$SMOKE_ID-pg" app="$SMOKE_ID-app"
cleanup_native() {
  docker rm -f "$app" "$pg" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}

native_smoke() {
  trap cleanup_native EXIT

  log "image=$IMAGE postgres=$PG_IMAGE cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs) cpuid_sse4_2=$(grep -qw sse4_2 /proc/cpuinfo && echo yes || echo no)"
  docker network create "$net" >/dev/null
  docker run -d --name "$pg" --network "$net" \
    -e POSTGRES_DB=llamenos -e POSTGRES_USER=llamenos -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    "$PG_IMAGE" >/dev/null

  # The docker-entrypoint-initdb phase runs a temporary server on the unix
  # socket only; wait for the real server on TCP.
  local i
  for i in $(seq 1 90); do
    if docker exec "$pg" psql -h 127.0.0.1 -U llamenos -d llamenos -tAc 'select 1' >/dev/null 2>&1; then break; fi
    [ "$i" = 90 ] && { log "FAIL: postgres never became ready"; docker logs "$pg" 2>&1 | tail -20; return 1; }
    sleep 1
  done
  local enc
  enc="$(docker exec "$pg" psql -h 127.0.0.1 -U llamenos -d llamenos -tAc 'show password_encryption')"
  [ "$enc" = "scram-sha-256" ] || { log "FAIL: expected password_encryption=scram-sha-256, got '$enc'"; return 1; }

  docker run -d --name "$app" --network "$net" \
    --read-only --tmpfs /tmp:size=64M --security-opt no-new-privileges:true --cpus 1 \
    -e DATABASE_URL="postgresql://llamenos:${PG_PASSWORD}@${pg}:5432/llamenos" \
    "$IMAGE" >/dev/null

  local deadline=$(( $(date +%s) + SMOKE_TIMEOUT_SEC )) started=0 stopped=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if docker logs "$app" 2>&1 | grep -q '^\[entrypoint\] Starting application'; then started=1; break; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$app")" != "true" ]; then
      # The container is EXPECTED to exit here: it is started with only
      # DATABASE_URL, so validateConfig() throws on HMAC_SECRET milliseconds
      # after the entrypoint prints "Starting application". That left a race —
      # if it printed the line and died in the gap between the grep above and
      # this check, the loop concluded "never started" while the very logs it
      # then dumped contained the line. Observed on at least four unrelated
      # branches. A stopped container still has logs, so re-read them once
      # before concluding; exiting is not by itself a failure.
      docker logs "$app" 2>&1 | grep -q '^\[entrypoint\] Starting application' && started=1
      stopped=1
      break
    fi
    sleep 2
  done

  local logs
  logs="$(docker logs "$app" 2>&1 || true)"
  echo "$logs" | grep -E '^\[(entrypoint|verify-runtime|migrate)\]|All migrations applied|FAILED' | sed 's/^/[image-smoke]   app: /' || true
  if [ "$started" != 1 ]; then
    if [ "$stopped" = 1 ]; then
      log "FAIL: the container exited before the entrypoint reached 'Starting application' (exit=$(docker inspect -f '{{.State.ExitCode}}' "$app"))"
    else
      log "FAIL: the entrypoint did not reach 'Starting application' within ${SMOKE_TIMEOUT_SEC}s (still running)"
    fi
    echo "$logs" | tail -30 | sed 's/^/[image-smoke]   app: /'
    docker logs "$pg" 2>&1 | grep -E 'FATAL|DETAIL' | sed 's/^.* UTC \[[0-9]*\] //' | sort | uniq -c | sort -rn | head -6 \
      | sed 's/^/[image-smoke]   postgres: /' || true
    return 1
  fi
  echo "$logs" | grep -q '^\[verify-runtime\] text layer OK' || { log "FAIL: verify-runtime did not report OK"; return 1; }
  # Paired with the CONTRACT comment in scripts/run-migrations.ts, which
  # prints this as its final line on success.
  echo "$logs" | grep -q 'All migrations applied successfully' || { log "FAIL: migrations did not report success"; return 1; }

  local tables
  tables="$(docker exec "$pg" psql -h 127.0.0.1 -U llamenos -d llamenos -tAc \
    "select count(*) from information_schema.tables where table_schema='public'")"
  [ "${tables:-0}" -gt 0 ] || { log "FAIL: no tables in the public schema after migrations"; return 1; }
  log "PASS: SCRAM auth + migrations complete ($tables tables)"
}

# ─────────────────────────────────────────────────────────────────────────
# KVM mode: re-run this script's native mode inside a Debian 13 guest whose
# virtual CPU model is $CPU_MODEL, with the images handed in as raw disks.
# ─────────────────────────────────────────────────────────────────────────
# Dated build + checksum, so the guest is reproducible (not ".../latest").
CLOUD_IMAGE_URL="https://cloud.debian.org/images/cloud/trixie/20260914-2601/debian-13-genericcloud-amd64-20260914-2601.qcow2"
CLOUD_IMAGE_SHA512="95e110dfcdbd0ed8a82a75ed9579802f9950cabf51a810dcc6388e81bc778188713878b9f28d583a0ea602fbf48b35996ae9ad37f584166d8fbd6489df248f53"

kvm_smoke() {
  local tool
  for tool in qemu-system-x86_64 qemu-img genisoimage curl sha512sum; do
    command -v "$tool" >/dev/null || { echo "--cpu mode needs '$tool'" >&2; exit 2; }
  done
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || { echo "--cpu mode needs read/write access to /dev/kvm" >&2; exit 2; }

  local cache="${IMAGE_SMOKE_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/llamenos-image-smoke}"
  mkdir -p "$cache"
  local base="$cache/$(basename "$CLOUD_IMAGE_URL")"
  if [ ! -f "$base" ] || ! echo "$CLOUD_IMAGE_SHA512  $base" | sha512sum -c --status; then
    log "downloading $(basename "$CLOUD_IMAGE_URL")"
    curl -sSfL -o "$base.part" "$CLOUD_IMAGE_URL"
    echo "$CLOUD_IMAGE_SHA512  $base.part" | sha512sum -c --status || { echo "cloud image checksum mismatch" >&2; exit 2; }
    mv "$base.part" "$base"
  fi

  work="$(mktemp -d "${TMPDIR:-/tmp}/image-smoke-kvm.XXXXXX")"
  trap 'rm -rf "$work"' EXIT

  docker image inspect "$PG_IMAGE" >/dev/null 2>&1 || docker pull -q "$PG_IMAGE" >/dev/null
  # `docker save` of a digest reference keeps no name, and the guest would
  # re-pull it from a registry; hand the guest a local tag instead.
  local guest_pg="image-smoke/postgres:pinned"
  docker tag "$PG_IMAGE" "$guest_pg"
  log "exporting images for the guest"
  docker save "$IMAGE" -o "$work/app.tar"
  docker save "$guest_pg" -o "$work/pg.tar"
  # A raw virtio disk must be a whole number of sectors; tar ignores the
  # trailing zeros this adds.
  truncate -s %1M "$work/app.tar" "$work/pg.tar"

  mkdir -p "$work/seed"
  cp "$0" "$work/seed/image-smoke.sh"
  cp "$REPO_ROOT/deploy/docker/docker-compose.yml" "$work/seed/docker-compose.yml"
  printf 'instance-id: image-smoke\nlocal-hostname: image-smoke\n' > "$work/seed/meta-data"
  cat > "$work/seed/user-data" <<EOF
#cloud-config
write_files:
  - path: /root/guest.sh
    permissions: '0755'
    content: |
      #!/bin/sh
      # Everything goes to a file first: serial-getty hangs up ttyS0 during
      # boot. The kernel console replays each line from /dev/kmsg instead.
      {
        echo "cpu=\$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2) cpuid_sse4_2=\$(grep -qw sse4_2 /proc/cpuinfo && echo yes || echo no)"
        mkdir -p /seed/deploy/docker /seed/scripts
        mount -o ro /dev/sr0 /mnt
        cp /mnt/image-smoke.sh /seed/scripts/image-smoke.sh
        cp /mnt/docker-compose.yml /seed/deploy/docker/docker-compose.yml
        DEBIAN_FRONTEND=noninteractive apt-get -qq update && DEBIAN_FRONTEND=noninteractive apt-get -qq install -y docker.io >/dev/null
        docker load -q -i /dev/vdb
        docker load -q -i /dev/vdc
        if PG_IMAGE='$guest_pg' SMOKE_TIMEOUT_SEC='$SMOKE_TIMEOUT_SEC' bash /seed/scripts/image-smoke.sh '$IMAGE'; then
          echo "IMAGE-SMOKE-RESULT PASS"
        else
          echo "IMAGE-SMOKE-RESULT FAIL"
        fi
      } > /root/smoke.log 2>&1
      while IFS= read -r line; do echo "IMAGE-SMOKE-GUEST \$line" > /dev/kmsg; done < /root/smoke.log
      poweroff
runcmd:
  - [ sh, /root/guest.sh ]
EOF
  genisoimage -quiet -output "$work/seed.iso" -volid cidata -joliet -rock \
    "$work/seed/user-data" "$work/seed/meta-data" "$work/seed/image-smoke.sh" "$work/seed/docker-compose.yml"

  qemu-img create -q -f qcow2 -F qcow2 -b "$base" "$work/root.qcow2" 16G
  log "booting KVM guest with -cpu $CPU_MODEL (image=$IMAGE)"
  local rc=0
  timeout "${KVM_TIMEOUT_SEC:-1500}" qemu-system-x86_64 -enable-kvm -cpu "$CPU_MODEL" -m 3072 -smp 2 \
    -nographic -no-reboot -monitor none -display none \
    -drive "file=$work/root.qcow2,if=virtio" \
    -drive "file=$work/app.tar,if=virtio,format=raw,readonly=on" \
    -drive "file=$work/pg.tar,if=virtio,format=raw,readonly=on" \
    -cdrom "$work/seed.iso" \
    -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
    -serial "file:$work/serial.log" >/dev/null 2>&1 || rc=$?
  [ "$rc" = 0 ] || log "qemu exited with status $rc"

  # Guest lines arrive via the kernel console as "[   12.34] IMAGE-SMOKE-GUEST ...".
  local guest
  guest="$(tr -d '\r' < "$work/serial.log" | sed -n 's/^.*IMAGE-SMOKE-GUEST //p')"
  echo "$guest" | sed 's/^/[image-smoke] guest: /'

  case "$CPU_MODEL" in
    kvm64|qemu64)
      # The whole point of this mode: prove the guest really hid SSE4.2, so a
      # PASS can't come from a guest that quietly exposed the host CPU.
      echo "$guest" | grep -q '^cpu=.* cpuid_sse4_2=no$' \
        || { log "FAIL: guest did not report a CPUID-masked CPU (cpuid_sse4_2=no)"; return 1; } ;;
  esac
  if echo "$guest" | grep -qx 'IMAGE-SMOKE-RESULT PASS'; then
    log "PASS on KVM guest -cpu $CPU_MODEL"
    return 0
  fi
  log "FAIL on KVM guest -cpu $CPU_MODEL"
  return 1
}

if [ -n "$CPU_MODEL" ]; then
  kvm_smoke
else
  native_smoke
fi
