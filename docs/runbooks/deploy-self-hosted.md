# Self-Hosted Deployment Guide

> **Known broken (2026-09-25):** `deploy/scripts/deploy-self-hosted.sh` cannot
> currently produce a working deployment. `deploy/ansible/vars.yml` is committed,
> so the script never reaches its "generate `vars.yml`" branch; and that branch
> writes `llamenos_postgres_password` / `llamenos_hmac_secret` /
> `llamenos_storage_access_key`, while preflight requires `pg_password`,
> `hmac_secret`, `server_secret`, `storage_access_key`, `storage_secret_key` and
> `webhook_base_url`. Use [`docs/deployment/first-deploy.md`](../deployment/first-deploy.md)
> and `deploy/ansible/vars-production.example.yml` instead (drop the
> `deployment_profile: official` block and the updates/DNS settings for a
> plain self-host).

## Purpose

Deploy a standalone Llamenos instance on your own server. This guide covers first-time setup and subsequent updates.

## Prerequisites

- **Server:** Debian 12+ or Ubuntu 22.04/24.04, 2+ CPU cores, 4GB+ RAM, 40GB+ disk,
  **installed with full-disk encryption** (see [Disk tier](#disk-tier-required))
- **DNS:** A record pointing your domain to the server IP (e.g., `llamenos.example.com`)
- **SSH:** Key-based access to the server as a non-root user with sudo
- **Local tools:** `ansible` (ansible-core **2.18+**; preflight checks), `ssh`, `openssl`

## Disk tier (required)

Every host in the inventory must declare whether its disk is encrypted:

```yaml
llamenos_servers:
  hosts:
    hub1:
      ansible_host: 203.0.113.10
      llamenos_disk_encrypted: true    # installed with LUKS full-disk encryption
```

Preflight fails if the marker is missing or is not a YAML boolean. A host marked
`false` is a **no-secrets-at-rest** host: preflight refuses to place the app,
PostgreSQL, RustFS, the Signal sidecar, the PBX or internal-TLS keys on it — also
through an **empty** inventory group, which means "every host" — and backups,
restores, updates and observability skip it. A single-host deployment therefore
needs `true`: a box without disk encryption cannot hold the database.

### Optional: the push relay on a second, cheaper host

The ntfy push relay (Android wake-ups) is the one service that may run on a host
**without** disk encryption, e.g. to put it with a different provider for
reachability. Add the host with `llamenos_disk_encrypted: false`, put it in the
`llamenos_ntfy` and `llamenos_proxy` groups, list your encrypted host explicitly
in `llamenos_app`, `llamenos_db` and `llamenos_storage`, and point
`push.<your domain>` at the relay's IP (preflight checks each host's names). See
the two-tier example at the end of `deploy/ansible/inventory.example.yml`, and
[`docs/deployment/first-deploy.md` → Two hosts, two tiers](../deployment/first-deploy.md#2-two-hosts-two-tiers)
for what that host holds and the checks that keep it that way.

On such a host ntfy keeps no message cache on disk, logs at `warn` into a single
1 MB file, and Caddy writes no access log and strips client addresses and topics
from its error log. Splitting the app from PostgreSQL/RustFS across hosts is not
supported (the app's `.env` addresses them by Docker-network name).

## Steps

### 1. Clone the repository

```bash
git clone https://github.com/Llamenos-Hotline/llamenos-platform.git
cd llamenos-platform
```

### 2. Run the deploy script

```bash
./deploy/scripts/deploy-self-hosted.sh
```

The script will:
- Check that Ansible and SSH are available
- Prompt for your domain, email, server IP, and SSH user (if no `vars.yml` exists)
- Generate secure random passwords for PostgreSQL, HMAC, and storage keys
- Create `vars.yml` and `inventory.yml`
- Run preflight validation, deployment, and smoke checks

### 3. Review generated configuration

Before confirming deployment, review:
- `deploy/ansible/vars.yml` — all configuration values
- `deploy/ansible/inventory.yml` — server connection details

### 4. Verify deployment

After the script completes, verify:

```bash
# Health check
curl https://your-domain.com/api/health/ready
# Expected: {"status":"ok"}

# TLS certificate
curl -vI https://your-domain.com 2>&1 | grep "subject:"
```

### 5. Generate admin keypair

```bash
bun run bootstrap-admin
```

Save the output — this is your admin key for first login.

## Updates

Re-run the deploy script to update:

```bash
./deploy/scripts/deploy-self-hosted.sh
```

Or update only the app:

```bash
cd deploy/ansible
ansible-playbook setup.yml -i inventory.yml -e "@vars.yml" --tags app
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Preflight fails on SSH | Key not authorized | `ssh-copy-id user@server` |
| Health check times out | Caddy TLS provisioning | Wait 2 minutes, check `docker logs caddy` |
| Port 443 blocked | Firewall | `sudo ufw allow 443/tcp` (done automatically by playbook) |
| Database connection refused | PostgreSQL not started | `docker compose -f /opt/llamenos/services/postgres/docker-compose.yml up -d` |
