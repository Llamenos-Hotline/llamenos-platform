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
#   4. actually BINDS and SERVES: GET /api/health/live and /api/health/ready
#      over the container network both answer 200 (an image that migrates and
#      then fails to bind still passed before this probe existed),
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
# Per-endpoint HTTP probe window, capped at the overall deadline. On the
# 2-vCPU KVM guest the seeding between "Starting application" and the bind is
# emulated and slow; 90s covers it with margin.
PROBE_TIMEOUT_SEC="${PROBE_TIMEOUT_SEC:-90}"
# Obviously-fake credentials for throwaway containers; never real secrets.
PG_PASSWORD="smoke-test-not-a-secret"
# validateConfig() requires three distinct 64-hex secrets plus storage keys
# before the server binds at all — the smoke now asserts the bind, so it must
# supply them. Fixed dummy values: they protect a container that lives for
# seconds on a private network, and fixed keeps the log diff-able run to run.
SMOKE_HMAC_SECRET="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SMOKE_SERVER_SECRET="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
SMOKE_SERVER_KEK="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
# The ban-list and messaging-thread hash keys are file-ONLY (validateConfig
# refuses them as env vars), so the smoke mounts them at /run/secrets — the
# same path the production deploys use. Same dummy-value rationale as above.
SMOKE_BAN_HASH_KEY="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
SMOKE_MESSAGING_HASH_KEY="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

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
net="$SMOKE_ID-net" pg="$SMOKE_ID-pg" app="$SMOKE_ID-app" storage="$SMOKE_ID-storage"
secrets_dir=""
cleanup_native() {
  docker rm -f "$app" "$pg" "$storage" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  [ -z "$secrets_dir" ] || rm -rf "$secrets_dir"
}

# GET a path on the app container over the smoke network, from a throwaway
# container started from the image under test (Bun is in it) — the same path
# Caddy takes to the app in the compose deployment, so it proves the server
# bound on the interface, not just loopback. Prints "HTTP <status>" then the
# response body; exit 0 iff the status is 200. A connection failure prints
# "HTTP 000" with the error text as the body.
http_probe() {
  docker run --rm --network "$net" \
    --read-only --tmpfs /tmp:size=16M --security-opt no-new-privileges:true \
    --entrypoint bun "$IMAGE" -e "
      fetch('http://${app}:3000$1')
        .then(async (r) => {
          console.log('HTTP ' + r.status)
          console.log(await r.text())
          process.exit(r.status === 200 ? 0 : 1)
        })
        .catch((err) => {
          console.log('HTTP 000')
          console.log(String(err))
          process.exit(1)
        })
    "
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

  # Minimal storage stand-in for the readiness gate: /api/health/ready fails
  # (503) unless the storage endpoint answers, and this network has no RustFS.
  # The stub is the image under test itself (Bun is in it), so nothing extra is
  # pulled and the KVM guest needs nothing beyond the tar it already loads.
  # 403 is what an unauthenticated probe of a real RustFS gets, and what
  # checkStorage (apps/worker/routes/health.ts) accepts as "reachable".
  docker run -d --name "$storage" --network "$net" \
    --read-only --tmpfs /tmp:size=16M --security-opt no-new-privileges:true \
    --entrypoint bun "$IMAGE" -e \
    "Bun.serve({ hostname: '0.0.0.0', port: 9000, fetch: () => new Response('image-smoke storage stub', { status: 403 }) })" >/dev/null

  # A full (throwaway) config: the smoke now asserts the server binds and
  # serves, and it cannot bind at all unless validateConfig() passes.
  # ENVIRONMENT=staging keeps production's WEBHOOK_BASE_URL requirement and
  # development's OpenAPI snapshot write (this rootfs is read-only) out of the
  # way; the dev HTTP surface stays closed (DEV_ROUTES_ENABLED is unset).
  # The two hash keys validateConfig accepts ONLY as files go through a
  # read-only bind mount at /run/secrets, like the production deploys.
  secrets_dir="$(mktemp -d "${TMPDIR:-/tmp}/image-smoke-secrets.XXXXXX")"
  printf '%s' "$SMOKE_BAN_HASH_KEY" > "$secrets_dir/ban-hash-key"
  printf '%s' "$SMOKE_MESSAGING_HASH_KEY" > "$secrets_dir/messaging-hash-key"
  # The app runs as the non-root llamenos user: mktemp's 0700 dir would make
  # the bind mount untraversable, and the container would boot-fail on
  # "Required secret file ban-hash-key is missing" with the files right there.
  chmod 755 "$secrets_dir"
  chmod 444 "$secrets_dir/ban-hash-key" "$secrets_dir/messaging-hash-key"
  docker run -d --name "$app" --network "$net" \
    --read-only --tmpfs /tmp:size=64M --security-opt no-new-privileges:true --cpus 1 \
    -v "$secrets_dir:/run/secrets:ro" \
    -e DATABASE_URL="postgresql://llamenos:${PG_PASSWORD}@${pg}:5432/llamenos" \
    -e HMAC_SECRET="$SMOKE_HMAC_SECRET" \
    -e SERVER_SECRET="$SMOKE_SERVER_SECRET" \
    -e SERVER_KEK="$SMOKE_SERVER_KEK" \
    -e HOTLINE_NAME="image-smoke" \
    -e ENVIRONMENT=staging \
    -e STORAGE_ACCESS_KEY="smoke-storage-access-key" \
    -e STORAGE_SECRET_KEY="smoke-storage-secret-key" \
    -e STORAGE_ENDPOINT="http://${storage}:9000" \
    "$IMAGE" >/dev/null

  local deadline=$(( $(date +%s) + SMOKE_TIMEOUT_SEC )) started=0 stopped=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if docker logs "$app" 2>&1 | grep -q '^\[entrypoint\] Starting application'; then started=1; break; fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$app")" != "true" ]; then
      # With a full config the container is expected to STAY RUNNING, so an
      # exit before the marker is a genuine failure — no longer the old
      # expected-exit race (the smoke used to start the app with only
      # DATABASE_URL, and validateConfig threw milliseconds after the marker).
      # `.State.Running` can flip false before the log driver flushes the last
      # lines, so re-read the logs after the container is fully reaped.
      docker wait "$app" >/dev/null 2>&1 || true
      if docker logs "$app" 2>&1 | grep -q '^\[entrypoint\] Starting application'; then started=1; fi
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

  # The HTTP assertion. The smoke used to end at the log marker above, so an
  # image that migrated and then failed to bind still passed. Probe both
  # Kubernetes health endpoints over the container network until each answers
  # 200, within a bounded wait capped by the overall deadline. In --cpu mode
  # this script IS the guest's script (kvm_smoke ships it in on the seed
  # ISO), so the guest run asserts the same two endpoints.
  local probe_deadline=$(( $(date +%s) + PROBE_TIMEOUT_SEC ))
  # `if`, not a bare && list: under `set -euo pipefail` a false && aborts.
  if [ "$probe_deadline" -gt "$deadline" ]; then probe_deadline="$deadline"; fi
  local path probe_ok probe_out
  for path in /api/health/live /api/health/ready; do
    probe_ok=0 probe_out=""
    while [ "$(date +%s)" -lt "$probe_deadline" ]; do
      if probe_out="$(http_probe "$path" 2>&1)"; then probe_ok=1; break; fi
      sleep 2
    done
    if [ "$probe_ok" = 1 ]; then
      # Line 1 is "HTTP 200"; the rest is the response body (the readiness
      # body names each dependency check, so it belongs in the log).
      log "probe GET $path -> $(echo "$probe_out" | head -1)"
      echo "$probe_out" | tail -n +2 | sed 's/^/[image-smoke]   probe: /'
    else
      log "FAIL: GET $path did not return 200 within ${PROBE_TIMEOUT_SEC}s of probing; last attempt:"
      echo "$probe_out" | sed 's/^/[image-smoke]   probe: /'
      docker logs "$app" 2>&1 | tail -20 | sed 's/^/[image-smoke]   app: /'
      return 1
    fi
  done

  # The pre-deploy migration gate (deploy/ansible: the app role and
  # playbooks/update.yml run it from the image about to be deployed, before
  # that image migrates anything) must load from this image's production
  # dependencies and read a real ledger and catalog. Against the database just
  # migrated nothing is pending, so it must report OK without a backup.
  local gate
  if ! gate="$(docker run --rm --network "$net" \
    --read-only --tmpfs /tmp:size=64M --security-opt no-new-privileges:true --cpus 1 \
    -e DATABASE_URL="postgresql://llamenos:${PG_PASSWORD}@${pg}:5432/llamenos" \
    --entrypoint bun "$IMAGE" scripts/check-migration-safety.ts --target 2>&1)"; then
    log "FAIL: the migration safety gate did not pass inside the image"
    echo "$gate" | tail -20 | sed 's/^/[image-smoke]   gate: /'
    return 1
  fi
  echo "$gate" | sed 's/^/[image-smoke]   gate: /'
  echo "$gate" | grep -q '^\[migration-safety\] OK' || { log "FAIL: the migration safety gate did not report OK"; return 1; }
  log "PASS: SCRAM auth + migrations ($tables tables); /api/health/live + /api/health/ready serve 200; migration safety gate runs in the image"
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
        if PG_IMAGE='$guest_pg' SMOKE_TIMEOUT_SEC='$SMOKE_TIMEOUT_SEC' PROBE_TIMEOUT_SEC='$PROBE_TIMEOUT_SEC' bash /seed/scripts/image-smoke.sh '$IMAGE'; then
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
