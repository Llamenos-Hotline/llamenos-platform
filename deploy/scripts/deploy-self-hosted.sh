#!/usr/bin/env bash
set -euo pipefail

# deploy-self-hosted.sh — Deploy Llamenos with self-hoster profile (default)
# Usage: ./deploy-self-hosted.sh [--check] [ansible-playbook extra args...]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANSIBLE_DIR="$(cd "$SCRIPT_DIR/../ansible" && pwd)"
VARS_FILE="$ANSIBLE_DIR/vars.yml"
INVENTORY_FILE="$ANSIBLE_DIR/inventory.yml"

check_dependencies() {
  for cmd in ansible-playbook ssh; do
    if ! command -v "$cmd" &>/dev/null; then
      echo "Error: $cmd is required but not installed." >&2
      exit 1
    fi
  done
}

prompt_if_missing() {
  if [[ ! -f "$VARS_FILE" ]]; then
    echo "No vars.yml found. Creating from template..."
    echo ""
    read -rp "Domain (e.g., llamenos.example.com): " domain
    read -rp "ACME email for TLS certs: " acme_email
    read -rp "Server IP address: " server_ip
    read -rp "SSH user (default: deploy): " ssh_user
    ssh_user="${ssh_user:-deploy}"

    db_password="$(openssl rand -hex 24)"
    hmac_secret="$(openssl rand -hex 32)"
    server_secret="$(openssl rand -hex 32)"
    server_kek="$(openssl rand -hex 32)"
    ban_hash_key="$(openssl rand -hex 32)"
    messaging_hash_key="$(openssl rand -hex 32)"
    storage_key="$(openssl rand -hex 24)"

    cat > "$VARS_FILE" <<VARS
deployment_profile: "self-hoster"
domain: "$domain"
acme_email: "$acme_email"
app_dir: /opt/llamenos
deploy_user: "$ssh_user"
deploy_group: "$ssh_user"

llamenos_postgres_password: "$db_password"
llamenos_hmac_secret: "$hmac_secret"
llamenos_server_secret: "$server_secret"
server_kek: "$server_kek"
ban_hash_key: "$ban_hash_key"
messaging_hash_key: "$messaging_hash_key"
llamenos_storage_access_key: "$storage_key"
VARS

    cat > "$INVENTORY_FILE" <<INV
all:
  children:
    llamenos_servers:
      hosts:
        vps1:
          ansible_host: $server_ip
          ansible_user: $ssh_user
          ansible_ssh_private_key_file: ~/.ssh/id_ed25519
    llamenos_app:
      hosts:
        vps1: {}
    llamenos_db:
      hosts:
        vps1: {}
    llamenos_proxy:
      hosts:
        vps1: {}
    llamenos_storage:
      hosts:
        vps1: {}
INV

    echo ""
    echo "Generated vars.yml and inventory.yml"
    echo "Review them before proceeding: $VARS_FILE"
    echo ""
    read -rp "Continue with deployment? [y/N] " confirm
    [[ "$confirm" =~ ^[Yy] ]] || exit 0
  fi
}

main() {
  check_dependencies
  prompt_if_missing

  echo "Deploying Llamenos (self-hoster profile)..."
  echo ""

  cd "$ANSIBLE_DIR"
  ansible-playbook setup.yml \
    -i inventory.yml \
    -e "@vars.yml" \
    -e "deployment_profile=self-hoster" \
    "$@"
}

main "$@"
