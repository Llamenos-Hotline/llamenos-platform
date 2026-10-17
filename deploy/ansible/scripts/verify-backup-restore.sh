#!/usr/bin/env bash
#
# Backup/restore round-trip verification — the acceptance evidence for
# issue #1125.
#
# Creates a throwaway "deployment" in a scratch directory, backs up a
# database with known content using the real Ansible backup roles,
# destroys that content, runs the real playbooks/restore.yml, and asserts
# the content came back. Tears the containers down afterwards.
#
# This NEVER touches a real host. It runs against localhost with a
# connection type of `local`, and the playbook itself refuses to start
# unless app_dir points inside a path containing 'llamenos-roundtrip'.
#
# Requirements: docker, ansible-playbook, age, age-keygen.
#
# Usage:
#   deploy/ansible/scripts/verify-backup-restore.sh
#   KEEP_SCRATCH=1 deploy/ansible/scripts/verify-backup-restore.sh   # keep artifacts for inspection

set -euo pipefail

ANSIBLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d -t llamenos-roundtrip-XXXXXX)"
PROJECT="rt$(basename "${SCRATCH}" | tr -dc 'a-z0-9' | tail -c 8)"

RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
[ -t 1 ] || { RED=""; GREEN=""; DIM=""; RESET=""; }

log() { echo "${DIM}[roundtrip]${RESET} $*"; }

for tool in docker ansible-playbook age age-keygen; do
  command -v "${tool}" >/dev/null 2>&1 || {
    echo "${RED}missing required tool: ${tool}${RESET}" >&2
    exit 1
  }
done

cleanup() {
  local rc=$?
  log "tearing down scratch containers"
  for svc in postgres rustfs; do
    f="${SCRATCH}/app/services/${svc}/docker-compose.yml"
    [ -f "${f}" ] && docker compose -f "${f}" down -v --remove-orphans >/dev/null 2>&1 || true
  done
  rm -f "${ANSIBLE_DIR}/.roundtrip-inventory.yml"
  if [ "${KEEP_SCRATCH:-0}" = "1" ]; then
    log "scratch tree kept at ${SCRATCH}"
  else
    rm -rf "${SCRATCH}"
  fi
  if [ "${rc}" -eq 0 ]; then
    echo "${GREEN}round trip PASSED${RESET}"
  else
    echo "${RED}round trip FAILED (exit ${rc})${RESET}" >&2
  fi
  exit "${rc}"
}
trap cleanup EXIT

log "scratch tree: ${SCRATCH}"
mkdir -p "${SCRATCH}/app"

# Throwaway keypair. The private half stays in the scratch tree and is
# deleted with it; this is exactly the split a real deployment must keep
# (public key on the server, private key off it).
log "generating a throwaway age keypair"
age-keygen -o "${SCRATCH}/backup-key.txt" 2>/dev/null
AGE_PUB="$(age-keygen -y "${SCRATCH}/backup-key.txt")"

# Distinct, greppable values so the plaintext-leak scan is meaningful.
MARKER="RT-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
CANARY="CANARY-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
PGPASS="pw-$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"

cat > "${SCRATCH}/vars.yml" <<VARS
---
app_dir: "${SCRATCH}/app"
deploy_user: "$(id -un)"
deploy_group: "$(id -gn)"

llamenos_postgres_image: "${ROUNDTRIP_PG_IMAGE:-postgres:17-alpine}"
backup_rustfs_helper_image: "${ROUNDTRIP_HELPER_IMAGE:-alpine:3.22}"

backup_enabled: true
backup_age_public_key: "${AGE_PUB}"
backup_age_private_key_path: "${SCRATCH}/backup-key.txt"
backup_rclone_remote: ""

pg_password: "${PGPASS}"
roundtrip_project: "${PROJECT}"
roundtrip_marker: "${MARKER}"
roundtrip_canary_secret: "${CANARY}"

# No application container in the scratch deployment, so do not spend
# 100 seconds waiting for a health endpoint that cannot exist.
restore_health_retries: 1
restore_health_delay: 1
restore_rustfs_retries: 1
restore_rustfs_delay: 1
VARS

# The inventory lives inside deploy/ansible, not in the scratch tree, so
# that group_vars/all/ is picked up the same way it is on a real run --
# that is where the canonical Compose paths are defined, and a test that
# supplied them itself would not prove the wiring works.
INVENTORY="${ANSIBLE_DIR}/.roundtrip-inventory.yml"
cat > "${INVENTORY}" <<INV
---
# Throwaway inventory for the round-trip test. 'llamenos_disk_encrypted'
# is declared true because the backup and restore plays refuse to write
# data at rest on an undeclared host; this "host" is a scratch directory
# that is deleted when the test finishes.
all:
  hosts:
    localhost:
      ansible_connection: local
      ansible_python_interpreter: "{{ ansible_playbook_python }}"
      llamenos_disk_encrypted: true
INV

log "running the round trip"
cd "${ANSIBLE_DIR}"
ANSIBLE_ROLES_PATH="${ANSIBLE_DIR}/roles" \
ansible-playbook \
  -i "${INVENTORY}" \
  -e "roundtrip_vars=${SCRATCH}/vars.yml" \
  -e "@${SCRATCH}/vars.yml" \
  -e ansible_become=false \
  playbooks/verify-backup-restore.yml "$@"
