# Operator Handbook

The single consolidated reference for deploying, operating, and troubleshooting a Llamenos instance.

**Audience**: System administrators and operators responsible for running a Llamenos crisis hotline.

**Conventions**: All commands assume a Docker Compose deployment in `/opt/llamenos/deploy/docker/` unless otherwise noted. Run commands as the `deploy` user. Adjust paths for your environment.

**See also**: [Quick Reference Card](QUICK_REFERENCE.md) for a one-page summary of the most common commands.

---

## Table of Contents

1. [Getting Started (First 30 Minutes)](#1-getting-started-first-30-minutes)
2. [Daily Operations](#2-daily-operations)
3. [Weekly Maintenance](#3-weekly-maintenance)
4. [Monthly Tasks](#4-monthly-tasks)
5. [Quarterly Tasks](#5-quarterly-tasks)
6. [Troubleshooting](#6-troubleshooting)
7. [Emergency Procedures](#7-emergency-procedures)
8. [Architecture Overview](#8-architecture-overview)
9. [Command Reference](#9-command-reference)
10. [Glossary](#10-glossary)

---

## 1. Getting Started (First 30 Minutes)

This section walks you from a fresh VPS to a running hotline. For the full step-by-step walkthrough with screenshots and alternatives, see [QUICKSTART.md](QUICKSTART.md).

### 1.1 Prerequisites

- **A VPS**: 2 vCPU, 4 GB RAM, 40 GB SSD minimum. Ubuntu 24.04 LTS. KVM-based (not OpenVZ).
- **A domain name**: A record pointing to your VPS IP. Caddy handles TLS automatically.
- **An SSH key pair**: Ed25519 recommended (`ssh-keygen -t ed25519`).
- **Ansible** (recommended): `pip install ansible`
- **`just`** (recommended): [github.com/casey/just](https://github.com/casey/just)

### 1.2 Recommended VPS Providers

Choose a GDPR-compliant, privacy-respecting provider with EU data centers:

| Provider | Location | Notes |
|----------|----------|-------|
| Hetzner | Germany, Finland | Best value, strong privacy record |
| OVH | France | Dedicated servers available |
| Greenhost | Netherlands | Privacy-focused nonprofit |

Avoid US-based providers subject to NSLs/FISA unless your organization operates under US jurisdiction.

### 1.3 Fastest Path: Ansible Automation

```bash
cd deploy/ansible

# 1. Configure inventory
cp inventory.example.yml inventory.yml
# Edit inventory.yml with your VPS IP, SSH key, domain

# 2. Generate secrets
just generate-secrets
# Copy output into vars.yml

# 3. Encrypt secrets
cp vars.example.yml vars.yml
# Paste generated secrets, then:
just encrypt-vars

# 4. Harden + deploy in one step
just setup-all
```

This runs the hardening playbook (SSH lockdown, firewall, kernel hardening, fail2ban, Docker) then deploys the application with Docker Compose.

### 1.4 What the Setup Does

The Ansible `setup-all` command performs:

**Server hardening**:
- Creates a `deploy` user, disables root SSH and password auth
- Changes SSH port (default 2222), sets `MaxAuthTries 3`
- Configures UFW firewall (SSH, 80, 443 only)
- Applies kernel hardening (reverse path filtering, ICMP redirect blocking, dmesg restriction)
- Installs fail2ban (5 attempts, 1-hour ban)
- Enables unattended security updates
- Installs auditd for file access and privilege escalation logging
- Installs Docker with `userns-remap` and `no-new-privileges`
- Configures NTP (required for Schnorr token validation)

**Application deployment**:
- Clones the repo or pulls latest
- Generates secrets and writes `.env`
- Starts all Docker Compose services
- Waits for health check to pass

### 1.5 Create the Admin Account

1. Visit `https://hotline.yourorg.org` in your browser.
2. The setup wizard guides you through keypair creation, hotline naming, channel selection, and provider configuration.
3. **Download the encrypted backup** and store it in a password manager.

**SECURITY**: The admin nsec is the master key. If compromised, an attacker can manage all volunteers, read admin-wrapped notes, and modify settings. Store it in a hardware security module or high-security password manager (1Password, Bitwarden, KeePassXC). Never reuse this keypair on public WebSocket relays.

### 1.6 Verify Deployment

```bash
# All services healthy?
docker compose -f docker-compose.yml -f docker-compose.production.yml ps

# Health endpoint responding?
curl -s https://hotline.yourorg.org/api/health
# Expected: {"status":"ok"}

# TLS certificate valid?
echo | openssl s_client -connect hotline.yourorg.org:443 -servername hotline.yourorg.org 2>/dev/null \
  | openssl x509 -noout -dates
```

### 1.7 Configure Telephony (Optional)

Telephony is optional -- Llamenos works for messaging and reporting without it.

For Twilio (most common):
1. Buy a phone number with voice capability at twilio.com.
2. In the admin UI: Settings > Telephony Provider > Twilio. Enter Account SID, Auth Token, Phone Number.
3. In the Twilio Console: set Voice webhook to `https://hotline.yourorg.org/telephony/twilio/voice` (POST) and Status Callback to `https://hotline.yourorg.org/telephony/twilio/status`.

Other supported providers: SignalWire, Vonage, Plivo, Asterisk (self-hosted).

### 1.8 Set Up Backups

Backups are critical. Set them up before going live:

```bash
# Install age for encrypted backups
apt install age
age-keygen -o /root/backup-key.txt
# Store the private key offline in a safe place

# Create the backup script
cat > /opt/llamenos/backup.sh << 'SCRIPT'
#!/bin/bash
set -euo pipefail
BACKUP_DIR="/opt/llamenos/backups"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30
AGE_RECIPIENT="age1your-public-key-here"  # Replace with your age public key
mkdir -p "$BACKUP_DIR"
docker compose -f /opt/llamenos/deploy/docker/docker-compose.yml \
  exec -T postgres pg_dump -U llamenos llamenos \
  | gzip | age -r "$AGE_RECIPIENT" \
  > "$BACKUP_DIR/llamenos_${DATE}.sql.gz.age"
find "$BACKUP_DIR" -name "*.age" -mtime +${RETENTION_DAYS} -delete
echo "[$(date)] Backup complete: llamenos_${DATE}.sql.gz.age"
SCRIPT
chmod 700 /opt/llamenos/backup.sh

# Schedule daily backups at 03:00 UTC
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/llamenos/backup.sh >> /var/log/llamenos-backup.log 2>&1") | crontab -
```

### 1.9 Set Up External Monitoring

Set up uptime monitoring with an external service (UptimeRobot, Healthchecks.io, or Uptime Kuma):

- **Endpoint**: `https://hotline.yourorg.org/api/health`
- **Expected**: `200 OK` with `{"status":"ok"}`
- **Interval**: 60 seconds
- **Alert threshold**: 2 consecutive failures

---

## 2. Daily Operations

### 2.1 Health Check

Verify the hotline is operational:

```bash
# Quick health check
curl -s https://hotline.yourorg.org/api/health

# Container status
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Health}}"
```

Both should show all services running and healthy. If the health endpoint returns anything other than `{"status":"ok"}`, proceed to [Troubleshooting](#6-troubleshooting).

### 2.2 Review Logs for Errors

```bash
# Application errors from last 24 hours
docker compose logs --since 24h app | grep -i "error\|warn\|fail"

# Caddy (reverse proxy) errors
docker compose logs --since 24h caddy | grep -i "error"

# Relay errors
docker compose logs --since 24h WebSocket relay | grep -i "error\|warn"
```

### 2.3 Check Disk Space

```bash
df -h /var/lib/docker
```

Alert if usage exceeds 80%. Docker images and logs consume disk over time.

### 2.4 Review fail2ban

```bash
sudo fail2ban-client status sshd
```

Note any banned IPs. Persistent bans from the same ranges may indicate a targeted attack.

---

## 3. Weekly Maintenance

### 3.1 Verify Backup Integrity

```bash
LATEST=$(ls -t /opt/llamenos/backups/*.age | head -1)
age -d -i /root/backup-key.txt "$LATEST" | gunzip | head -50
```

If decryption fails or output is garbled, the backup pipeline is broken. Fix immediately.

### 3.2 Review Audit Logs

In the admin UI, navigate to the Audit Log and review for:
- Unexpected login attempts
- Unauthorized settings changes
- Unusual call patterns

Or query directly:

```bash
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT key, value->>'action' AS action, value->>'timestamp' AS ts
  FROM storage
  WHERE namespace = 'records' AND key LIKE 'audit:%'
  ORDER BY key DESC
  LIMIT 50;
"
```

### 3.3 Check Disk Usage in Detail

```bash
# Docker volumes
docker system df -v

# PostgreSQL data
docker compose exec postgres du -sh /var/lib/postgresql/data/

# Relay data
docker compose exec WebSocket relay du -sh /app/WebSocket relay-db/
```

The relay LMDB should stay small if only ephemeral events (kind 20001) are in use. If it exceeds 1 GB, investigate for unexpected persistent events.

### 3.4 Check Resource Usage

```bash
docker stats --no-stream
free -h
```

If any container consistently uses >80% of available memory, consider upgrading the VPS.

---

## 4. Monthly Tasks

### 4.1 Update Docker Images

```bash
cd /opt/llamenos/deploy/docker
docker compose pull
docker compose up -d
```

Or via Ansible:

```bash
cd /opt/llamenos/deploy/ansible
just update
```

The Ansible update playbook creates a pre-update backup, pulls latest images, rebuilds, restarts, waits for health check, and rolls back automatically on failure.

### 4.2 Database Maintenance

```bash
# Run vacuum and analyze
docker compose exec postgres psql -U llamenos -d llamenos -c "VACUUM ANALYZE;"

# Check database size
docker compose exec postgres psql -U llamenos -d llamenos -c \
  "SELECT pg_size_pretty(pg_database_size('llamenos')) AS db_size;"
```

### 4.3 Review OS Security Updates

Unattended-upgrades handles security patches automatically, but check for pending kernel updates requiring a reboot:

```bash
ssh deploy@your-server
cat /var/run/reboot-required 2>/dev/null || echo "No reboot required"
```

If a reboot is required, schedule it during low-traffic hours:

```bash
sudo shutdown -r +5 "Reboot for kernel update"
```

### 4.4 Dependency Audit

If building from source:

```bash
cd /opt/llamenos
bun audit
```

Review and address any critical or high-severity findings.

### 4.5 Verify Build Integrity

Before applying updates, verify the release:

```bash
scripts/verify-build.sh v1.x.x
```

See [REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md) for details on what this proves and its limitations.

---

## 5. Quarterly Tasks

### 5.1 Secret Rotation

Rotate credentials on a quarterly schedule. Each rotation procedure is detailed in [RUNBOOK.md Section 1](RUNBOOK.md#1-secret-rotation).

| Secret | Rotation Procedure |
|--------|--------------------|
| Database password (`PG_PASSWORD`) | Change in PostgreSQL, update `.env`, restart app |
| Twilio credentials | Rotate API key in Twilio Console, update admin UI or `.env` |
| RustFS credentials | Use `mc` to create new service account, update `.env` |
| HMAC secret | Generate new hex, update `.env`, restart app. **Warning**: invalidates all ban list hashes |
| Asterisk secrets | Update `.env`, update ARI config, restart asterisk + bridge + app |

Annually: `SERVER_SECRET` (only if compromised or deliberately changing server identity).

### 5.2 Full Restore Test

Restore a backup to a staging environment (separate VPS or local Docker) and verify:

1. Backup decrypts successfully
2. Database restores without errors
3. Application starts and health check passes
4. Admin can log in and see expected data

```bash
# On a staging machine:
age -d -i /path/to/backup-key.txt latest-backup.sql.gz.age | gunzip > /tmp/restore.sql
# Start a fresh Docker Compose stack
# Restore: docker compose exec -T postgres psql -U llamenos -d llamenos < /tmp/restore.sql
# Clean up: rm /tmp/restore.sql
```

### 5.3 Security Review

- Review fail2ban logs for attack patterns
- Check that SSH port is still non-default and password auth is disabled
- Verify only expected ports are open: `nmap -p- hotline.yourorg.org`
- Verify security headers: `curl -sI https://hotline.yourorg.org | grep -E 'Strict-Transport|X-Content-Type|X-Frame|Content-Security'`
- Review Docker daemon config for hardening (`userns-remap`, `no-new-privileges`)

### 5.4 Penetration Testing (Annual)

Engage an external security firm for penetration testing annually. Share the [Threat Model](security/THREAT_MODEL.md) and [Deployment Hardening](security/DEPLOYMENT_HARDENING.md) documents with them.

---

## 6. Troubleshooting

Use this symptom-based decision tree to diagnose and resolve issues.

### 6.1 Application Won't Start

```
App container keeps restarting or exits immediately
|
+-- Check logs: docker compose logs app --tail 50
    |
    +-- "PG_PASSWORD is required"
    |   => Missing .env variable. Set PG_PASSWORD in .env.
    |
    +-- "ADMIN_PUBKEY is required"
    |   => Run: bun run bootstrap-admin, set ADMIN_PUBKEY in .env
    +-- "ADMIN_PUBKEY is set but ADMIN_DECRYPTION_PUBKEY is missing"
    |   => bootstrap-admin prints TWO public keys. Set both. The second is
    |      X25519 and is what notes are encrypted to; the server will not
    |      substitute the Ed25519 one, because notes sealed to it are
    |      permanently undecryptable.
    |
    +-- "HMAC_SECRET is required"
    |   => Run: openssl rand -hex 32, set HMAC_SECRET in .env
    |
    +-- "Connection refused" (postgres)
    |   => Database not ready. Check: docker compose ps postgres
    |   => If not running: docker compose up -d postgres, wait 30s
    |
    +-- "ECONNREFUSED" (rustfs)
    |   => RustFS not ready. Check: docker compose ps rustfs
    |
    +-- "out of memory"
        => Insufficient RAM. Upgrade VPS or reduce PG_POOL_SIZE in .env.
```

### 6.2 Site Returns 502 Bad Gateway

```
Browser shows 502 or "Bad Gateway"
|
+-- Is the app container running?
|   => docker compose ps app
|   |
|   +-- Not running => docker compose up -d app, check logs
|   +-- Running but unhealthy => docker compose logs app --tail 20
|
+-- Is the app listening?
|   => docker compose exec app curl -sf http://localhost:3000/api/health
|   |
|   +-- Connection refused => App crashed. Check logs.
|   +-- Returns OK => Caddy routing issue. Check: docker compose logs caddy --tail 20
|
+-- Is Caddy running?
    => docker compose ps caddy
```

### 6.3 Real-Time Events Not Working

```
Call notifications, presence, typing indicators missing
|
+-- Is the relay container running?
|   => docker compose ps WebSocket relay
|   |
|   +-- Not running => docker compose up -d WebSocket relay
|
+-- Is the relay reachable?
|   => curl -sI https://hotline.yourorg.org/WebSocket
|   Expected: 426 Upgrade Required
|   |
|   +-- Connection refused => Caddy not proxying. Check Caddyfile and caddy logs.
|   +-- 502 => Caddy can't reach WebSocket relay. Check Docker network.
|
+-- Is SERVER_SECRET set?
|   => grep SERVER_SECRET .env
|   |
|   +-- Missing => Generate: openssl rand -hex 32, add to .env, restart app
|
+-- NIP-42 auth failures in browser console?
    => Client pubkey may not be allowed. Check relay logs.
    => If SERVER_SECRET was rotated, clients must reconnect.
```

### 6.4 TLS Certificate Issues

```
Browser shows certificate error or insecure connection
|
+-- Check certificate status:
|   echo | openssl s_client -connect hotline.yourorg.org:443 2>/dev/null | openssl x509 -noout -dates
|
+-- Certificate expired or about to expire?
|   => Caddy auto-renews. Check: docker compose logs caddy | grep -i "certificate\|acme"
|   |
|   +-- Rate limit exceeded
|   |   => Wait 1 week, or temporarily use staging CA in Caddyfile
|   |
|   +-- DNS not resolving to this server
|   |   => dig +short hotline.yourorg.org (must return your VPS IP)
|   |
|   +-- Port 80 blocked (ACME HTTP-01 needs it)
|       => sudo ufw status | grep 80 (must show ALLOW)
|
+-- Force renewal (last resort):
    docker compose down caddy
    docker volume rm llamenos_caddy-data
    docker compose up -d caddy
```

### 6.5 Database Disk Full

```
Application errors mention disk space or write failures
|
+-- Check disk: df -h /var/lib/docker
|
+-- Check database size:
|   docker compose exec postgres psql -U llamenos -d llamenos -c \
|     "SELECT pg_size_pretty(pg_database_size('llamenos'));"
|
+-- Reclaim space: docker compose exec postgres psql -U llamenos -d llamenos -c "VACUUM FULL;"
|
+-- Prune Docker: docker system prune -f
|
+-- If still full: resize disk at VPS provider
```

### 6.6 Calls Not Routing

```
Inbound calls fail or don't reach volunteers
|
+-- Is the telephony provider configured?
|   => Admin UI > Settings > Telephony Provider
|
+-- Is the webhook URL correct in the provider console?
|   => Must be: https://hotline.yourorg.org/telephony/<provider>/voice (POST)
|
+-- Are volunteers on shift?
|   => Admin UI > Shifts (check current schedule)
|   => If no shift defined, check if a fallback group exists
|
+-- Provider outage?
|   => Check provider status page (e.g., status.twilio.com)
|   => Consider switching to an alternative provider in admin UI
```

### 6.7 fail2ban Blocking Legitimate Users

```bash
# Check banned IPs
sudo fail2ban-client status sshd

# Unban a specific IP
sudo fail2ban-client set sshd unbanip 203.0.113.50

# Check fail2ban log for details
sudo tail -50 /var/log/fail2ban.log
```

### 6.8 Docker Image Build Fails

```bash
# Clean build cache
docker builder prune -f

# Rebuild without cache
docker compose build --no-cache app

# Ensure sufficient disk (builds need ~2 GB temp space)
df -h /var/lib/docker
```

---

## 7. Emergency Procedures

### 7.1 Emergency Shutdown

Take the hotline offline immediately:

```bash
cd /opt/llamenos/deploy/docker
docker compose down
docker compose ps    # Verify nothing running
```

Bring it back:

```bash
docker compose up -d
docker compose logs -f app    # Watch for health check
```

### 7.2 Incident Response Checklist

When a security incident is suspected, follow this order:

1. **Assess**: What was compromised? When? Is the attacker still active?
2. **Contain**: Revoke compromised credentials. Block attacker IPs. Take offline if needed.
3. **Investigate**: Preserve evidence before making changes.
   ```bash
   docker compose logs > /tmp/incident-logs-$(date +%s).txt
   journalctl --since "2 days ago" > /tmp/system-logs.txt
   sudo fail2ban-client status sshd
   ```
4. **Remediate**: Rotate secrets ([RUNBOOK.md Section 1](RUNBOOK.md#1-secret-rotation)). Patch vulnerabilities. Rebuild containers from known-good code if supply chain suspected.
5. **Recover**: Restart services. Verify health checks. Monitor closely for 48 hours.
6. **Communicate**: GDPR requires breach notification within 72 hours if personal data affected. Notify organizational leadership.

### 7.3 Volunteer Account Compromise

A volunteer's device or credentials have been compromised.

1. **Deactivate immediately** via Admin UI: Volunteers > [volunteer] > Deactivate.
2. If admin UI unavailable:
   ```bash
   docker compose exec postgres psql -U llamenos -d llamenos -c "
     UPDATE storage SET value = jsonb_set(value::jsonb, '{active}', 'false')
     WHERE namespace = 'identity' AND key LIKE 'volunteer:%'
       AND value::jsonb->>'pubkey' = '<compromised_pubkey>';
   "
   docker compose restart app
   ```
3. **E2EE protection**: Past notes with forward-secret encryption remain safe. Only notes created during the compromise window may be readable by the attacker.
4. After resolution: generate a new invite for the volunteer to re-onboard with a fresh keypair. Review audit log for unauthorized actions.

### 7.4 Admin Account Compromise

This is the most severe scenario. See the full procedure in [Key Revocation Runbook](security/KEY_REVOCATION_RUNBOOK.md#1-admin-key-compromise-response).

Summary:
1. Take the application offline: `docker compose stop app`
2. Generate new admin keypair on a trusted machine: `bun run bootstrap-admin`
3. Update `ADMIN_PUBKEY` **and** `ADMIN_DECRYPTION_PUBKEY` in `.env` — rotating
   the seed changes both derived public keys, and a stale
   `ADMIN_DECRYPTION_PUBKEY` would seal new notes to the old admin key
4. Rotate ALL secrets
5. Restart and verify
6. Re-wrap note encryption keys (requires volunteers to be online)

### 7.5 Server Compromise

The VPS itself has been compromised.

**Key insight**: E2EE notes are safe -- the server never has plaintext content. The attacker can access metadata (timestamps, pubkeys, call IDs) but not note content.

1. **Provision a new server** (do not clean the compromised one).
2. **Restore from backup** on the new server.
3. **Rotate ALL secrets** (DB password, HMAC, RustFS, telephony, SSH keys).
4. **Update DNS** to new server.
5. **Notify volunteers** to re-authenticate.
6. **Preserve the compromised server** for forensics if legally required.

### 7.6 Data Breach Response

1. **Do NOT shut down immediately** -- preserve evidence first.
2. Capture forensic data:
   ```bash
   ps auxww > /tmp/forensics-ps-$(date +%s).txt
   ss -tulpn > /tmp/forensics-netstat-$(date +%s).txt
   docker compose logs > /tmp/forensics-logs-$(date +%s).txt
   last > /tmp/forensics-last-$(date +%s).txt
   ```
3. **What is exposed**: Metadata (timestamps, pubkeys, phone hashes, audit entries), telephony credentials, session tokens. **What is NOT exposed**: Note content (E2EE).
4. **Contain**: Rotate HMAC secret to invalidate all sessions:
   ```bash
   NEW_HMAC=$(openssl rand -hex 32)
   sed -i "s|^HMAC_SECRET=.*|HMAC_SECRET=${NEW_HMAC}|" .env
   docker compose restart app
   ```
5. **GDPR**: 72-hour notification deadline to supervisory authority if personal data affected.

### 7.7 Ransomware Response

1. Do NOT pay the ransom.
2. Isolate the server (disable networking at VPS provider dashboard).
3. Provision a new server per [QUICKSTART.md](QUICKSTART.md).
4. Restore from the most recent off-site encrypted backup.
5. Rotate all secrets.
6. Report to law enforcement if appropriate.

### 7.8 Telephony Provider Outage

Calls fail but messaging and notes continue working.

1. Check provider status page (e.g., status.twilio.com).
2. If extended: switch providers in Admin UI > Settings > Telephony Provider.
3. Update webhook URLs at the new provider.

### 7.9 Complete Infrastructure Rebuild

When nothing else is salvageable:

1. Provision a new VPS and follow [QUICKSTART.md](QUICKSTART.md) sections 1-4.
2. Restore database and RustFS from off-site backups.
3. Generate new admin keypair: `bun run bootstrap-admin`
4. Rotate ALL secrets.
5. Update DNS.
6. Notify volunteers to re-authenticate.
7. Admin re-wraps note envelopes (requires volunteers online).

---

## 8. Architecture Overview

### 8.1 Service Topology

```
                        Internet
                           |
                    +------+------+
                    |   Caddy     |  Port 80/443
                    |  (TLS, RP)  |  Auto Let's Encrypt
                    +------+------+
                           |
              +------------+------------+
              |            |            |
        +-----+----+ +----+-----+ +---+----+
        |   App    | |  WebSocket relay  | |  RustFS  |
        | (Node.js)| |  (WebSocket  | | (Blob   |
        | Port 3000| |  Relay)  | | Storage)|
        +-----+----+ | Port 7777| +---------+
              |       +----------+
              |
        +-----+-----+
        | PostgreSQL |
        | Port 5432  |
        +------------+

  Optional profiles:
  - asterisk + asterisk-bridge (self-hosted telephony)
  - whisper (server-side transcription, legacy)
  - signal (Signal messaging channel)
```

### 8.2 Service Descriptions

| Service | Purpose | Persistent Data |
|---------|---------|-----------------|
| **App** | Node.js application server (API, webhooks, business logic) | None (stateless) |
| **PostgreSQL** | Primary data store (identities, notes, settings, audit log) | Yes -- `/var/lib/postgresql/data/` |
| **Caddy** | Reverse proxy, TLS termination, static files | TLS certificates |
| **WebSocket relay** | WebSocket relay for real-time events (calls, presence, typing) | LMDB (ephemeral events not persisted) |
| **RustFS** | S3-compatible blob storage (encrypted reports, IVR audio) | Yes -- uploaded files |

### 8.3 Data Flow

1. **Inbound call**: Telephony provider webhook -> Caddy -> App -> CallRouterDO -> parallel ring via WebSocket relay
2. **Note creation**: Volunteer encrypts note client-side -> App stores encrypted blob -> Admin sees wrapped envelope
3. **Real-time events**: App publishes hub-encrypted WebSocket event -> WebSocket relay forwards to subscribers -> Clients decrypt with hub key
4. **Messaging**: Provider webhook -> App encrypts per-message envelope -> ConversationDO stores -> WebSocket notification to assigned volunteer

### 8.4 Security Boundaries

- **The server never sees plaintext note content.** Notes are encrypted client-side with per-note forward secrecy.
- **The relay sees only encrypted blobs.** All WebSocket event content is encrypted with the hub key. Generic tags prevent event-type inference.
- **Volunteer identity is hidden.** Personal info visible only to admins, never to other volunteers or callers.
- **The admin nsec is the master key.** Protect it as the most critical credential in the system.

### 8.5 Deployment Architectures

| Architecture | Best For | Complexity |
|--------------|----------|------------|
| Docker Compose on VPS | Small orgs (1-10 volunteers) | Low |
| Kubernetes (Helm) | Medium-large orgs (10-100+) | High |
| Cloudflare Workers | Any size, managed infra | Medium |

See [DEPLOYMENT_HARDENING.md](security/DEPLOYMENT_HARDENING.md) for detailed guidance on each architecture.

---

## 9. Command Reference

### 9.1 `just` Commands (deploy/ansible/)

These commands are run from the `deploy/ansible/` directory.

| Command | Description |
|---------|-------------|
| `just` | List all available commands |
| `just setup-all` | Full server setup: harden + deploy. Prompts for vault password. |
| `just harden` | Run hardening playbook only (SSH, firewall, kernel, fail2ban, Docker). |
| `just deploy` | Deploy or update the application only. |
| `just update` | Pull latest images, restart with health check, auto-rollback on failure. |
| `just backup` | Run an encrypted database backup. |
| `just check` | Dry-run: check configuration without making changes (`--check --diff`). |
| `just encrypt-vars` | Encrypt `vars.yml` with Ansible Vault. |
| `just edit-vars` | Edit encrypted `vars.yml` in-place. |
| `just view-vars` | View encrypted `vars.yml` contents. |
| `just ping` | Test SSH connectivity to all inventory hosts. |
| `just facts` | Show gathered Ansible facts (OS, hardware, etc.) for debugging. |
| `just generate-secrets` | Generate random secrets for a new deployment. Copy output to `vars.yml`. |

All playbook commands accept additional Ansible arguments via `*ARGS`, e.g.:

```bash
just deploy --limit llamenos --tags app
just harden --check
```

### 9.2 Docker Compose Commands

Run from `/opt/llamenos/deploy/docker/`. For production, always include the production overlay:

```bash
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.production.yml"

# Status
$COMPOSE ps
$COMPOSE ps --format "table {{.Name}}\t{{.Status}}\t{{.Health}}"

# Logs
$COMPOSE logs -f app                    # Follow app logs
$COMPOSE logs --since 1h app            # Last hour
$COMPOSE logs app | grep -i error       # Filter errors

# Restart
$COMPOSE restart app                    # Restart app only
$COMPOSE up -d                          # Start/restart all services
$COMPOSE down                           # Stop all services

# Database
$COMPOSE exec postgres psql -U llamenos -d llamenos    # Interactive shell
$COMPOSE exec postgres pg_isready -U llamenos          # Health check

# Rebuild
$COMPOSE build --no-cache app           # Rebuild app image
$COMPOSE pull                           # Pull latest images

# Resource usage
docker stats --no-stream
docker system df -v
```

### 9.3 System Administration

```bash
# Firewall
sudo ufw status
sudo ufw allow 2222/tcp comment "SSH"

# fail2ban
sudo fail2ban-client status sshd
sudo fail2ban-client set sshd unbanip <IP>

# Disk
df -h /var/lib/docker
du -sh /opt/llamenos/backups/

# Reboot check
cat /var/run/reboot-required 2>/dev/null || echo "No reboot required"

# Secret generation
openssl rand -hex 32        # For HMAC_SECRET, SERVER_SECRET
openssl rand -base64 24     # For passwords (PG_PASSWORD, RustFS, etc.)
```

### 9.4 Backup Commands

```bash
# Manual backup (encrypted)
docker compose exec -T postgres pg_dump -U llamenos llamenos \
  | gzip | age -r "age1your-public-key" \
  > /opt/llamenos/backups/llamenos_$(date +%Y%m%d_%H%M%S).sql.gz.age

# Verify backup can be decrypted
LATEST=$(ls -t /opt/llamenos/backups/*.age | head -1)
age -d -i /root/backup-key.txt "$LATEST" | gunzip | head -50

# Restore (WARNING: replaces all data)
docker compose stop app
age -d -i /root/backup-key.txt <backup-file>.sql.gz.age | gunzip > /tmp/restore.sql
docker compose exec postgres psql -U llamenos -d postgres -c \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='llamenos';"
docker compose exec postgres psql -U llamenos -d postgres -c "DROP DATABASE llamenos;"
docker compose exec postgres psql -U llamenos -d postgres -c "CREATE DATABASE llamenos OWNER llamenos;"
docker compose exec -T postgres psql -U llamenos -d llamenos < /tmp/restore.sql
rm -f /tmp/restore.sql
docker compose start app

# WebSocket relay backup
docker run --rm -v llamenos_WebSocket-data:/data -v /opt/llamenos/backups:/backup \
  alpine tar czf /backup/WebSocket relay-$(date +%Y%m%d).tar.gz -C /data .
```

---

## 10. Glossary

| Term | Definition |
|------|-----------|
| **Admin** | The operator role with full access to settings, volunteers, audit logs, and admin-wrapped note envelopes. |
| **age** | A modern file encryption tool used for encrypting database backups. |
| **Caddy** | The reverse proxy that handles TLS termination and routes traffic to backend services. |
| **DO (Durable Object)** | A Cloudflare Workers primitive for stateful, single-threaded compute. Used in the CF deployment architecture. |
| **E2EE** | End-to-end encryption. Notes are encrypted client-side; the server never sees plaintext. |
| **ECIES** | Elliptic Curve Integrated Encryption Scheme. Used for wrapping per-note symmetric keys for each reader. |
| **Forward secrecy** | Each note uses a unique random key. Compromising one key does not reveal other notes. |
| **Hub key** | A random symmetric key shared among all members for encrypting WebSocket relay events. Rotated when members depart. |
| **HMAC secret** | Server-side secret used for hashing phone numbers and IPs in ban lists and audit logs. |
| **RustFS** | S3-compatible blob storage for encrypted file uploads (reports, IVR audio). |
| **NIP-42** | WebSocket Implementation Possibility 42: client authentication for relay access control. |
| **WebSocket** | An open protocol for decentralized event relay. Llamenos uses it for real-time communication. |
| **nsec** | A WebSocket secret key (BIP-340 Schnorr). The admin nsec is the master credential. |
| **Parallel ringing** | All on-shift, non-busy volunteers ring simultaneously. First pickup terminates others. |
| **WebSocket relay** | A high-performance C++ WebSocket relay using LMDB storage. The default relay for self-hosted deployments. |
| **Volunteer** | An on-shift responder who answers calls and writes encrypted notes. Cannot see other volunteers' identities. |

---

## Maintenance Schedule Summary

| Task | Frequency | Section |
|------|-----------|---------|
| Health check | Daily | [2.1](#21-health-check) |
| Review error logs | Daily | [2.2](#22-review-logs-for-errors) |
| Check disk space | Daily | [2.3](#23-check-disk-space) |
| Verify backup integrity | Weekly | [3.1](#31-verify-backup-integrity) |
| Review audit logs | Weekly | [3.2](#32-review-audit-logs) |
| Check resource usage | Weekly | [3.4](#34-check-resource-usage) |
| Update Docker images | Monthly | [4.1](#41-update-docker-images) |
| Database vacuum | Monthly | [4.2](#42-database-maintenance) |
| OS kernel reboot check | Monthly | [4.3](#43-review-os-security-updates) |
| Dependency audit | Monthly | [4.4](#44-dependency-audit) |
| Secret rotation | Quarterly | [5.1](#51-secret-rotation) |
| Full restore test | Quarterly | [5.2](#52-full-restore-test) |
| Security review | Quarterly | [5.3](#53-security-review) |
| Penetration test | Annually | [5.4](#54-penetration-testing-annual) |

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [Quick Reference Card](QUICK_REFERENCE.md) | One-page cheat sheet of the most common commands |
| [QUICKSTART.md](QUICKSTART.md) | Full step-by-step first deployment walkthrough |
| [RUNBOOK.md](RUNBOOK.md) | Detailed operational procedures (secret rotation, backup, incident response) |
| [RELAY_OPERATIONS.md](RELAY_OPERATIONS.md) | WebSocket relay deployment, hardening, and monitoring |
| [REPRODUCIBLE_BUILDS.md](REPRODUCIBLE_BUILDS.md) | Build verification and supply chain integrity |
| [DEPLOYMENT_HARDENING.md](security/DEPLOYMENT_HARDENING.md) | Infrastructure security for all deployment architectures |
| [KEY_REVOCATION_RUNBOOK.md](security/KEY_REVOCATION_RUNBOOK.md) | Cryptographic key compromise response procedures |
| [THREAT_MODEL.md](security/THREAT_MODEL.md) | Adversary profiles, trust boundaries, and threat analysis |
