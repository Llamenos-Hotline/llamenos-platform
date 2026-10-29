# Official Server Deployment Guide

## Purpose

Deploy the Llamenos project's production servers: the platform host on 1984 Hosting (Iceland; full-disk encryption) with the app, PostgreSQL, RustFS, Caddy and the desktop update origin (`updates.`/`releases.`), and the ntfy push relay on its own unencrypted FlokiNET host (see [Two hosts, two tiers](../deployment/first-deploy.md#2-two-hosts-two-tiers)). Monitoring and the Signal notifier are opt-in (`observability_enabled`, `llamenos_signal_enabled`).

> **First deploy on a fresh VPS?** Follow [`docs/deployment/first-deploy.md`](../deployment/first-deploy.md)
> — the full ordered sequence (FDE install → DNS → config → preflight → harden →
> deploy → smoke-check → backups). This runbook covers the official profile
> once the box exists and `ansible_port` already matches the hardened `ssh_port`.

## Prerequisites

- **Platform VPS:** provisioned per [`iso-install.md`](../deployment/iso-install.md) (Debian 13, FDE, dropbear unlock), `llamenos_disk_encrypted: true`; **relay VPS:** stock Debian, `llamenos_disk_encrypted: false`; `playbooks/harden.yml` already run on both
- **DNS:** DNS-only (unproxied) `A` records for `api.`, the apex, `updates.` and `releases.` under your domain pointing at the **platform** VPS, and `push.llamenos-hotline.org` pointing at the **relay** VPS (preflight checks each host's names). TLS terminates on the VPS with a Let's Encrypt cert — the Android client hard-fails on any other chain (see first-deploy.md §1, §4)
- **App image:** `llamenos_app_image` set to an image that exists (the vars.yml default `docker.io/llamenos/llamenos:latest` is not published — first-deploy.md, "Getting the app image onto the server")
- **Ansible Vault:** password shared among maintainers via a secure channel

### Where our real values live

Every deploy runs **from the operator's machine** — there is no GitHub Actions
deploy, and GitHub holds none of this deployment's configuration (no inventory,
vault, SSH key, host or port in any Actions secret, variable or environment).
For the official instance, the filled-in `inventory-production.yml`, the
vault-encrypted `vars-production.yml`, the vault password and the deploy SSH key
live in the operator's **OS keyvault** and the private **`llamenos-internal`**
repo. A self-hoster keeps theirs wherever they keep secrets; the public repo
only ever carries the `*.example` templates.

## Steps

### First-time configuration

```bash
cd deploy/ansible
cp vars-production.example.yml     vars-production.yml       # gitignored; fill in — see the file's comments
cp inventory-production.example.yml inventory-production.yml  # gitignored; ansible_host, key, ansible_port
ansible-vault encrypt vars-production.yml
```

The templates carry no secrets; every secret is empty so preflight fails loudly
if one is forgotten. Which value goes where, and what the vault password is for:
first-deploy.md, step 4.

### Deploy

```bash
./deploy/scripts/deploy-official.sh          # setup.yml: preflight + harden + deploy + smoke-check
./deploy/scripts/deploy-official.sh --tags app   # single service
```

On a **fresh** VPS do not start here: `harden.yml` moves sshd off port 22 and the
inventory must be updated between hardening and deploying (first-deploy.md, step 6).

### Subsequent updates

From local, as every deploy is: `./deploy/scripts/deploy-official.sh`, or the
health-gated `ansible-playbook playbooks/update.yml -i inventory-production.yml -e @vars-production.yml --ask-vault-pass`

## Verification

```bash
# API health
curl https://api.<domain>/api/health/ready

# Update server
curl https://updates.<domain>/health

# Desktop update manifest
curl https://updates.<domain>/desktop/latest.json   # 404 until a release has been published to the box (desktop-update-release.md)
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Vault password error | Wrong password | Verify with `ansible-vault view vars-production.yml` |
| DNS preflight fails | Records not propagated | `dig +short api.<domain>` — wait for propagation |
| `updates.` returns 404/502 | Caddy not running, or artifacts not uploaded | `ssh -p <ssh_port> deploy@<ip> docker compose -f /opt/llamenos/services/caddy/docker-compose.yml ps`; artifacts live in `/opt/llamenos/services/update-server/artifacts/desktop/` |
