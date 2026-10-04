# Operator Runbook

> **See also**: The [Operator Handbook](OPERATOR_HANDBOOK.md) is the consolidated operator reference that organizes procedures by task frequency (daily, weekly, monthly, quarterly) with troubleshooting decision trees and a full command reference. The [Quick Reference Card](QUICK_REFERENCE.md) provides a one-page cheat sheet.

This runbook provides procedures for common operational tasks, incident response, and troubleshooting for Llamenos self-hosted deployments.

**Audience**: System administrators and operators responsible for maintaining a Llamenos instance.

**Conventions**: Commands assume a Docker Compose deployment in `/opt/llamenos/deploy/docker/`. Adjust paths if your deployment differs. All commands should be run as the `deploy` user unless otherwise noted.

---

## Table of Contents

1. [Secret Rotation](#1-secret-rotation)
2. [TLS Certificate Troubleshooting](#2-tls-certificate-troubleshooting)
3. [Database Operations](#3-database-operations)
4. [Backup and Recovery](#4-backup-and-recovery)
5. [Incident Response](#5-incident-response)
6. [Log Analysis and Monitoring](#6-log-analysis-and-monitoring)
7. [Common Issues and Solutions](#7-common-issues-and-solutions)
8. [Scaling Considerations](#8-scaling-considerations)
9. [Emergency Procedures](#9-emergency-procedures)
10. [Disaster Recovery Drills](#10-disaster-recovery-drills)
11. [Case Management System (CMS)](#11-case-management-system-cms)

> **Key Revocation and Rotation**: For cryptographic key compromise, volunteer departure key revocation, device seizure response, and hub key rotation procedures, see the dedicated [Key Revocation Runbook](security/KEY_REVOCATION_RUNBOOK.md).

---

## 1. Secret Rotation

### 1.1 Database Password Rotation

**Frequency**: Quarterly, or immediately after any suspected compromise.

```bash
cd /opt/llamenos/deploy/docker

# 1. Generate new password
NEW_PG_PASSWORD=$(openssl rand -base64 24)
echo "New PG_PASSWORD: $NEW_PG_PASSWORD"

# 2. Change the password in PostgreSQL
docker compose exec postgres psql -U llamenos -d llamenos -c \
  "ALTER USER llamenos PASSWORD '${NEW_PG_PASSWORD}';"

# 3. Update .env
sed -i "s|^PG_PASSWORD=.*|PG_PASSWORD=${NEW_PG_PASSWORD}|" .env

# 4. Restart the application (not the database)
docker compose restart app

# 5. Verify
docker compose exec app curl -sf http://localhost:3000/api/health
echo "Password rotation complete"
```

### 1.2 HMAC Secret Rotation

**Frequency**: Annually, or immediately after suspected compromise.

**WARNING**: Rotating the HMAC secret invalidates all existing phone and IP hashes. Ban list entries will no longer match incoming callers until the ban list is rebuilt. Audit log IP hashes from before the rotation will not match new hashes.

```bash
cd /opt/llamenos/deploy/docker

# 1. Generate new secret (must be exactly 64 hex characters)
NEW_HMAC=$(openssl rand -hex 32)

# 2. Update .env
sed -i "s|^HMAC_SECRET=.*|HMAC_SECRET=${NEW_HMAC}|" .env

# 3. Restart the application
docker compose restart app

# 4. Verify
docker compose exec app curl -sf http://localhost:3000/api/health
```

After rotation, re-add banned phone numbers through the admin UI so they are hashed with the new secret.

### 1.3 RustFS Credentials Rotation

**Frequency**: Annually, or after suspected compromise.

```bash
cd /opt/llamenos/deploy/docker

# 1. Generate new credentials
NEW_ACCESS_KEY=$(openssl rand -base64 16 | tr -dc 'a-zA-Z0-9' | head -c 20)
NEW_SECRET_KEY=$(openssl rand -base64 24)

# 2. Update RustFS credentials via mc (RustFS client)
docker compose exec rustfs mc alias set local http://localhost:9000 \
  "${STORAGE_ACCESS_KEY}" "${STORAGE_SECRET_KEY}"
docker compose exec rustfs mc admin user svcacct add local "${NEW_ACCESS_KEY}" \
  --secret-key "${NEW_SECRET_KEY}"

# 3. Update .env with new credentials
sed -i "s|^STORAGE_ACCESS_KEY=.*|STORAGE_ACCESS_KEY=${NEW_ACCESS_KEY}|" .env
sed -i "s|^STORAGE_SECRET_KEY=.*|STORAGE_SECRET_KEY=${NEW_SECRET_KEY}|" .env

# 4. Restart both RustFS and the app
docker compose restart rustfs app

# 5. Verify
docker compose exec app curl -sf http://localhost:3000/api/health
```

### 1.4 Twilio Credentials Rotation

**Frequency**: Quarterly, or immediately after compromise.

1. Go to the Twilio Console > Account > API Keys.
2. Create a new API key.
3. Update the credentials:

```bash
cd /opt/llamenos/deploy/docker

# Update .env with new values
# TWILIO_AUTH_TOKEN=<new auth token>

docker compose restart app
```

Alternatively, rotate credentials through the admin UI at Settings > Telephony Provider without touching `.env`.

4. Revoke the old API key in the Twilio Console.

### 1.6 Server WebSocket Secret Rotation

**Frequency**: Only when compromised, or when deliberately changing the server's WebSocket identity.

**WARNING**: Rotating `SERVER_SECRET` changes the server's WebSocket keypair. All clients will see a new server pubkey after re-authenticating. Active relay subscriptions will need to be re-established.

```bash
cd /opt/llamenos/deploy/docker

# 1. Generate new secret (must be exactly 64 hex characters)
NEW_SERVER_SECRET=$(openssl rand -hex 32)

# 2. Update .env
sed -i "s|^SERVER_SECRET=.*|SERVER_SECRET=${NEW_SERVER_SECRET}|" .env

# 3. Restart the application (relay does not need restart)
docker compose restart app

# 4. Verify
docker compose exec app curl -sf http://localhost:3000/api/health
```

After rotation:
- All connected clients will automatically reconnect and accept the new server identity
- Historical events signed by the old server key will fail verification (acceptable — ephemeral events are not persisted)

### 1.5 Asterisk / SIP Bridge Secrets Rotation

Only applicable if using the `asterisk` profile (`sip-bridge` + Asterisk PBX).

```bash
cd /opt/llamenos/deploy/docker

# Generate new secrets
NEW_ARI_PASSWORD=$(openssl rand -base64 24)
NEW_BRIDGE_SECRET=$(openssl rand -base64 24)

# Update .env
sed -i "s|^ARI_PASSWORD=.*|ARI_PASSWORD=${NEW_ARI_PASSWORD}|" .env
sed -i "s|^BRIDGE_SECRET=.*|BRIDGE_SECRET=${NEW_BRIDGE_SECRET}|" .env

# Recreate all affected services. Asterisk's ARI password is rendered from
# ARI_PASSWORD into a compose config at container creation, so `restart`
# would keep the old password — the containers must be recreated.
docker compose --profile asterisk up -d --force-recreate asterisk sip-bridge app
```

---

## 2. TLS Certificate Troubleshooting

Caddy handles TLS certificates automatically via Let's Encrypt (or ZeroSSL). Most certificate issues resolve themselves. Intervene only if automatic renewal fails.

### 2.1 Check Certificate Status

```bash
# View Caddy logs for certificate operations
docker compose logs caddy | grep -i "tls\|certificate\|acme"

# Check certificate expiry from outside
echo | openssl s_client -connect hotline.yourorg.org:443 -servername hotline.yourorg.org 2>/dev/null \
  | openssl x509 -noout -dates
```

### 2.2 Common Certificate Issues

#### DNS not pointing to server

```bash
# Verify DNS resolution
dig +short hotline.yourorg.org

# Should return your server's IP address
# If not, update your DNS records and wait for propagation
```

#### Port 80 blocked (ACME HTTP-01 challenge)

Let's Encrypt requires port 80 to be accessible for HTTP-01 challenges.

```bash
# Verify port 80 is open in the firewall
sudo ufw status | grep 80

# Verify Caddy is listening
docker compose port caddy 80

# Test from outside
curl -I http://hotline.yourorg.org
```

#### Rate limit exceeded

Let's Encrypt rate limits: 5 duplicate certificates per week, 50 certificates per domain per week. If you hit this, wait or use the staging endpoint temporarily.

```bash
# Switch to staging (untrusted certs, no rate limits)
# Add to your Caddyfile, inside the site block:
#   tls {
#     ca https://acme-staging-v02.api.letsencrypt.org/directory
#   }

# Then restart Caddy
docker compose restart caddy
```

Remove the staging directive once rate limits reset (1 week).

#### Force certificate renewal

```bash
# Remove Caddy's stored certificates
docker compose exec caddy caddy untrust
docker compose down caddy
docker volume rm llamenos_caddy-data
docker compose up -d caddy

# Caddy will obtain new certificates on startup
docker compose logs -f caddy
```

### 2.3 Custom Certificates

If you manage certificates externally (e.g., Cloudflare Origin CA):

Edit the `Caddyfile` to specify your certificate and key:

```
hotline.yourorg.org {
    tls /etc/caddy/certs/cert.pem /etc/caddy/certs/key.pem
    # ... rest of config
}
```

Mount the certificate files as a Docker volume in `docker-compose.yml`.

---

## 3. Database Operations

### 3.1 Connect to PostgreSQL

```bash
# Interactive psql session
docker compose exec postgres psql -U llamenos -d llamenos

# Run a single query
docker compose exec postgres psql -U llamenos -d llamenos -c "SELECT count(*) FROM storage;"
```

### 3.2 Check Database Size

```bash
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT pg_size_pretty(pg_database_size('llamenos')) AS db_size;
"
```

### 3.3 Check Active Connections

```bash
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT count(*), state
  FROM pg_stat_activity
  WHERE datname = 'llamenos'
  GROUP BY state;
"
```

### 3.4 Vacuum and Analyze

PostgreSQL runs autovacuum by default. If you notice performance degradation:

```bash
docker compose exec postgres psql -U llamenos -d llamenos -c "VACUUM ANALYZE;"
```

---

## 4. Backup and Recovery

### 4.1 Manual Database Backup

```bash
cd /opt/llamenos/deploy/docker

# Create backup directory
mkdir -p /opt/llamenos/backups

# Dump, compress, and encrypt
docker compose exec -T postgres pg_dump -U llamenos llamenos \
  | gzip \
  | age -r "age1your-public-key-here" \
  > /opt/llamenos/backups/llamenos_$(date +%Y%m%d_%H%M%S).sql.gz.age

echo "Backup complete: $(ls -lh /opt/llamenos/backups/ | tail -1)"
```

**NOTE**: You need the `age` encryption tool. Install with: `apt install age`. Generate a keypair with: `age-keygen -o /root/backup-key.txt`. The public key is used for encryption; the private key (stored securely offline) is needed for decryption.

### 4.2 Automated Backup Script

Create `/opt/llamenos/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/opt/llamenos/backups"
DATE=$(date +%Y%m%d_%H%M%S)
RETENTION_DAYS=30
AGE_RECIPIENT="age1your-public-key-here"  # Replace with your age public key

mkdir -p "$BACKUP_DIR"

# Database backup (compressed + encrypted)
docker compose -f /opt/llamenos/deploy/docker/docker-compose.yml \
  exec -T postgres pg_dump -U llamenos llamenos \
  | gzip \
  | age -r "$AGE_RECIPIENT" \
  > "$BACKUP_DIR/llamenos_${DATE}.sql.gz.age"

# Rotate old backups
find "$BACKUP_DIR" -name "*.age" -mtime +${RETENTION_DAYS} -delete

# Optional: upload to off-site storage
# rclone copy "$BACKUP_DIR/llamenos_${DATE}.sql.gz.age" remote:llamenos-backups/

echo "[$(date)] Backup complete: llamenos_${DATE}.sql.gz.age"
```

```bash
chmod 700 /opt/llamenos/backup.sh

# Add to crontab (runs daily at 03:00 UTC)
(crontab -l 2>/dev/null; echo "0 3 * * * /opt/llamenos/backup.sh >> /var/log/llamenos-backup.log 2>&1") | crontab -
```

### 4.3 Verify Backup Integrity

Periodically verify that backups can be decrypted and restored:

```bash
# Decrypt and inspect (do NOT restore to production)
LATEST=$(ls -t /opt/llamenos/backups/*.age | head -1)
age -d -i /root/backup-key.txt "$LATEST" | gunzip | head -50
```

### 4.4 Restore from Backup

**WARNING**: This replaces all data in the database. All changes since the backup will be lost.

```bash
cd /opt/llamenos/deploy/docker

# 1. Stop the application (keep database running)
docker compose stop app

# 2. Decrypt the backup
age -d -i /root/backup-key.txt /opt/llamenos/backups/llamenos_20260223_030000.sql.gz.age \
  | gunzip > /tmp/restore.sql

# 3. Drop and recreate the database
docker compose exec postgres psql -U llamenos -d postgres -c "
  SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='llamenos';
"
docker compose exec postgres psql -U llamenos -d postgres -c "DROP DATABASE llamenos;"
docker compose exec postgres psql -U llamenos -d postgres -c "CREATE DATABASE llamenos OWNER llamenos;"

# 4. Restore
docker compose exec -T postgres psql -U llamenos -d llamenos < /tmp/restore.sql

# 5. Clean up the unencrypted dump
rm -f /tmp/restore.sql

# 6. Restart the application
docker compose start app

# 7. Verify
docker compose exec app curl -sf http://localhost:3000/api/health
```

### 4.5 WebSocket Relay Backup

Back up the WebSocket relay LMDB data directory:

```bash
# Back up the WebSocket relay-db Docker volume
docker run --rm -v llamenos_WebSocket-data:/data -v /opt/llamenos/backups:/backup \
  alpine tar czf /backup/WebSocket relay-$(date +%Y%m%d).tar.gz -C /data .
```

**Note**: If all events are ephemeral (kind 20001), the relay database is small and contains only relay state — not user data. Backup is recommended but not critical.

### 4.6 RustFS Blob Backup

RustFS stores uploaded files (encrypted reports, IVR audio). Back it up separately:

```bash
# Install RustFS client if needed
docker compose exec rustfs mc alias set local http://localhost:9000 \
  "$STORAGE_ACCESS_KEY" "$STORAGE_SECRET_KEY"

# Mirror to local directory
docker compose exec rustfs mc mirror local/llamenos-files /tmp/rustfs-backup/

# Or use rclone for remote backup
# rclone sync rustfs:llamenos-files remote:llamenos-rustfs-backup/
```

---

## 5. Incident Response

### 5.1 Incident Response Checklist

When a security incident is suspected, follow this checklist in order:

1. **Assess**: Determine the scope and severity.
   - What was compromised? (server, account, credentials, code)
   - When did the compromise occur? (check audit logs)
   - Is the attacker still active? (check active sessions, unusual processes)

2. **Contain**: Limit the damage.
   - Revoke compromised credentials immediately.
   - If the server is compromised, take it offline if safe to do so.
   - Block attacker IP addresses in the firewall.

3. **Investigate**: Gather evidence.
   - Export application audit logs from the admin panel.
   - Preserve Docker container logs: `docker compose logs > /tmp/incident-logs-$(date +%s).txt`
   - Preserve system logs: `journalctl --since "2 days ago" > /tmp/system-logs.txt`
   - Check fail2ban logs: `sudo fail2ban-client status sshd`

4. **Remediate**: Fix the vulnerability.
   - Rotate all relevant secrets (see [Section 1](#1-secret-rotation)).
   - Apply any needed patches.
   - Rebuild containers from known-good code if supply chain is suspected.

5. **Recover**: Restore service.
   - Restart services after remediation.
   - Verify health checks pass.
   - Monitor closely for 48 hours.

6. **Communicate**: Notify affected parties.
   - Notify your organization's leadership.
   - If volunteer or caller data may have been exposed, follow your organization's breach notification policy.
   - GDPR requires breach notification within 72 hours if personal data is affected.

### 5.2 Volunteer Account Compromise

> **See also**: The [Key Revocation Runbook](security/KEY_REVOCATION_RUNBOOK.md) covers volunteer departure key revocation (friendly and hostile), device seizure response, and hub key rotation procedures.

A volunteer's device or credentials have been compromised.

```bash
# 1. Deactivate the volunteer immediately via the admin UI
#    This revokes ALL active sessions automatically.
#    Navigate to: Volunteers > [volunteer] > Deactivate

# 2. If admin UI is not accessible, deactivate via the database:
docker compose exec postgres psql -U llamenos -d llamenos -c "
  UPDATE storage
  SET value = jsonb_set(value::jsonb, '{active}', 'false')
  WHERE namespace = 'identity'
    AND key LIKE 'volunteer:%'
    AND value::jsonb->>'pubkey' = '<compromised_pubkey>';
"

# 3. Restart the app to clear any cached sessions
docker compose restart app
```

**Note on E2EE protection**: The compromised volunteer's V2 notes (forward-secret encryption) remain protected. Each note uses a unique ephemeral key -- compromising the identity key does not reveal past note content. However, any notes the volunteer creates while the attacker has access may be readable by the attacker.

After the incident:
- Generate a new invite for the volunteer to re-onboard with a fresh keypair.
- Review the audit log for any unauthorized actions during the compromise window.

### 5.3 Admin Account Compromise

> **See also**: The [Key Revocation Runbook](security/KEY_REVOCATION_RUNBOOK.md) covers the full cryptographic response procedure for admin key compromise, including hub key rotation, envelope re-wrapping, GDPR assessment, and maximum response timeframes.

This is the most severe account compromise scenario.

1. **Immediately** take the application offline:
   ```bash
   docker compose stop app
   ```

2. Generate a new admin keypair:
   ```bash
   # On a trusted machine
   bun run bootstrap-admin
   ```

3. Update the server configuration:
   ```bash
   # Update BOTH derived public keys in .env. bootstrap-admin prints both;
   # rotating the seed changes both, and a stale ADMIN_DECRYPTION_PUBKEY would
   # seal new notes to the OLD admin key.
   sed -i "s|^ADMIN_PUBKEY=.*|ADMIN_PUBKEY=<new_pubkey>|" .env
   sed -i "s|^ADMIN_DECRYPTION_PUBKEY=.*|ADMIN_DECRYPTION_PUBKEY=<new_decryption_pubkey>|" .env
   ```

4. Rotate all secrets (database, HMAC, RustFS, telephony).

5. Restart the application:
   ```bash
   docker compose up -d
   ```

6. Review the audit log for unauthorized actions.

7. Re-wrap note encryption keys. Admin-wrapped envelopes created with the old admin key are no longer decryptable by the new admin key. Volunteers must be online to re-wrap their notes for the new admin.

### 5.4 Server Compromise

The VPS itself has been compromised (SSH breach, container escape, provider-level access).

**Key insight**: E2EE notes are safe. The server never has plaintext note content. The attacker can access metadata (who wrote what, when, call IDs) but not note content.

1. **Provision a new server** (do not attempt to clean the compromised server).

2. **Restore from backup** on the new server following the [Quick Start Guide](QUICKSTART.md).

3. **Rotate ALL secrets**:
   - Database password
   - HMAC secret
   - RustFS credentials
   - Twilio/telephony credentials
   - Asterisk / SIP bridge credentials (`ARI_PASSWORD`, `BRIDGE_SECRET`) if using the asterisk profile
   - SSH keys (generate new key pairs for the new server)

4. **Update DNS** to point to the new server.

5. **Notify all volunteers** to re-authenticate. Their client-side keys are not affected by a server compromise.

6. **Preserve the compromised server** for forensic analysis if legally required. Do not destroy evidence.

---

## 6. Log Analysis and Monitoring

### 6.1 View Application Logs

```bash
cd /opt/llamenos/deploy/docker

# All services, last 100 lines
docker compose logs --tail 100

# Follow specific service logs
docker compose logs -f app
docker compose logs -f caddy
docker compose logs -f postgres

# Filter by time
docker compose logs --since "1h" app
docker compose logs --since "2026-02-23T10:00:00" app
```

### 6.2 Application Audit Log

The application maintains its own audit log accessible through the admin UI. It records:

- Login/logout events
- Volunteer account changes (create, deactivate, delete)
- Settings modifications
- Call events (answered, missed, voicemail)
- Note creation and edits
- Telephony provider configuration changes

Export audit logs via the admin panel or query the database directly:

```bash
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT key, value->>'action' AS action, value->>'timestamp' AS ts
  FROM storage
  WHERE namespace = 'records' AND key LIKE 'audit:%'
  ORDER BY key DESC
  LIMIT 20;
"
```

### 6.3 System Monitoring

#### Disk usage

```bash
# Docker volumes
docker system df -v

# PostgreSQL data directory
docker compose exec postgres du -sh /var/lib/postgresql/data/

# Overall disk
df -h /var/lib/docker
```

#### Memory and CPU

```bash
# Per-container resource usage
docker stats --no-stream

# System-wide
free -h
top -bn1 | head -20
```

#### Container health

```bash
# Health check status for all containers
docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Health}}"
```

### 6.4 Log Rotation

Docker log rotation is configured in the daemon settings (`/etc/docker/daemon.json`):

```json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

This limits each container to 30 MB of logs (3 files x 10 MB). Adjust if you need more history.

### 6.5 WebSocket Relay Monitoring

Monitor the WebSocket relay (core service):

```bash
# Check relay health
docker compose exec WebSocket relay curl -sf http://localhost:7777

# View relay logs
docker compose logs WebSocket relay --tail 50

# Check LMDB database size
docker compose exec WebSocket relay du -sh /app/WebSocket relay-db/

# Check relay container resource usage
docker stats WebSocket relay --no-stream
```

For detailed relay monitoring and troubleshooting, see [`docs/RELAY_OPERATIONS.md`](RELAY_OPERATIONS.md).

### 6.6 External Monitoring

Set up an external uptime monitor to alert on downtime:

- **Endpoint**: `https://hotline.yourorg.org/api/health`
- **Expected response**: `200 OK` with body `{"status":"ok"}`
- **Check interval**: 60 seconds
- **Alert threshold**: 2 consecutive failures

Recommended services: UptimeRobot (free tier), Healthchecks.io (free tier), or Uptime Kuma (self-hosted).

---

## 7. Common Issues and Solutions

### 7.1 Application Won't Start

**Symptom**: `docker compose up` fails or the app container keeps restarting.

```bash
# Check container logs
docker compose logs app --tail 50

# Check if database is ready
docker compose exec postgres pg_isready -U llamenos
```

**Common causes**:

| Error | Cause | Solution |
|-------|-------|----------|
| `PG_PASSWORD is required` | Missing `.env` variable | Set `PG_PASSWORD` in `.env` |
| `ADMIN_PUBKEY is required` | Missing admin key | Run `bun run bootstrap-admin` and set the key |
| `ADMIN_PUBKEY is set but ADMIN_DECRYPTION_PUBKEY is missing or empty` | Only one of the admin's two public keys is configured | `bun run bootstrap-admin` prints both. Set `ADMIN_DECRYPTION_PUBKEY` to the X25519 one — a different value. The server refuses to boot rather than encrypt notes to the Ed25519 key, which succeeds and makes them permanently unreadable |
| `ADMIN_DECRYPTION_PUBKEY is identical to ADMIN_PUBKEY` | One key pasted into both slots | They are different keys for different algorithms; copy both values from `bootstrap-admin` |
| `HMAC_SECRET is required` | Missing HMAC secret | Generate with `openssl rand -hex 32` |
| `Connection refused` (postgres) | Database not ready | Wait for postgres health check; check `docker compose ps` |
| `ECONNREFUSED` (rustfs) | RustFS not ready | Wait for RustFS health check |
| `out of memory` | Insufficient RAM | Increase VPS RAM or reduce `PG_POOL_SIZE` |

### 7.2 Caddy Returns 502 Bad Gateway

The reverse proxy cannot reach the application.

```bash
# Verify the app container is running and healthy
docker compose ps app

# Check if the app is listening
docker compose exec app curl -sf http://localhost:3000/api/health

# Check Caddy logs
docker compose logs caddy --tail 20
```

**Likely causes**: The app container is still starting (wait for health check), or it crashed (check app logs).

### 7.3 WebSocket Relay Connection Fails

**Symptom**: Real-time updates (call notifications, presence indicators) do not work.

```bash
# Check if the relay container is running
docker compose ps WebSocket relay

# Check the relay health
docker compose exec WebSocket relay curl -sf http://localhost:7777

# Test the WebSocket proxy endpoint from outside
curl -sI https://hotline.yourorg.org/WebSocket
# Should return 426 Upgrade Required (not a proper WS handshake, but confirms routing)

# Check browser console for relay errors
# Common: "Failed to connect to wss://hotline.yourorg.org/WebSocket"
```

**Common causes**:

| Symptom | Cause | Solution |
|---------|-------|----------|
| Relay container not running | Container stopped or failed | `docker compose up -d WebSocket relay` |
| 502 on `/WebSocket` | Caddy can't reach WebSocket relay | Check `docker compose logs caddy` for upstream errors |
| Auth failures in browser console | `SERVER_SECRET` missing or changed | Verify `.env` has `SERVER_SECRET`; restart app if changed |
| Events not delivered | NIP-42 auth failing | Check relay logs; verify client pubkey is allowed |
| Cloudflare 524 timeout | CF drops idle WebSocket after 100s | Enable WebSocket in Cloudflare dashboard; app sends periodic pings |

### 7.4 Database Disk Full

```bash
# Check disk usage
docker compose exec postgres du -sh /var/lib/postgresql/data/

# Check for bloat
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT schemaname, tablename,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename))
  FROM pg_tables
  WHERE schemaname = 'public'
  ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;
"

# Run vacuum to reclaim space
docker compose exec postgres psql -U llamenos -d llamenos -c "VACUUM FULL;"
```

If the volume is genuinely full, resize the Docker volume or the underlying disk at your VPS provider.

### 7.5 Health Check Failures

```bash
# Check what the health endpoint returns
docker compose exec app curl -v http://localhost:3000/api/health

# If database connection is failing
docker compose exec postgres pg_isready -U llamenos

# If RustFS is failing
docker compose exec rustfs mc ready local
```

### 7.6 Docker Image Build Fails

```bash
# Clean Docker build cache
docker builder prune -f

# Rebuild without cache
docker compose build --no-cache app

# Check available disk space (builds need ~2 GB temporary space)
df -h /var/lib/docker
```

### 7.7 fail2ban Blocking Legitimate Users

```bash
# Check banned IPs
sudo fail2ban-client status sshd

# Unban a specific IP
sudo fail2ban-client set sshd unbanip 203.0.113.50

# Check fail2ban log
sudo tail -50 /var/log/fail2ban.log
```

---

## 8. Scaling Considerations

### 8.1 Single-Server Limits

The Docker Compose deployment on a single VPS is designed for small organizations (1-10 volunteers). Expected limits:

| Resource | Capacity |
|----------|----------|
| Concurrent calls | ~50 (limited by telephony provider, not server) |
| Concurrent WebSocket relay subscriptions | ~500 (WebSocket relay handles thousands; practical limit is app-side) |
| Database storage | Limited by disk size |
| API requests | ~1000/s (Hono on Node.js) |

### 8.2 Vertical Scaling

The simplest scaling approach: upgrade your VPS to a larger instance.

- **More RAM**: Increase `PG_POOL_SIZE` in `.env` (default: 10).
- **More CPU**: Benefits the app container and any transcription workloads.
- **More disk**: Resize the VPS disk or Docker volume.

### 8.3 Horizontal Scaling (Kubernetes)

For larger deployments (10-100+ volunteers), migrate to the Kubernetes deployment using the Helm chart at `deploy/helm/llamenos/`. The Helm chart supports:

- Multiple app replicas behind an Ingress controller
- External PostgreSQL (e.g., AWS RDS, Cloud SQL) for database HA
- NetworkPolicy for pod isolation
- Pod autoscaling

See `docs/security/DEPLOYMENT_HARDENING.md` for the full Kubernetes deployment guide.

### 8.4 Database Performance

If you observe slow queries:

```bash
# Enable slow query logging
docker compose exec postgres psql -U llamenos -d llamenos -c "
  ALTER SYSTEM SET log_min_duration_statement = 1000;  -- Log queries >1s
  SELECT pg_reload_conf();
"

# Check for missing indexes
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT schemaname, tablename, seq_scan, idx_scan
  FROM pg_stat_user_tables
  WHERE seq_scan > idx_scan
  ORDER BY seq_scan DESC;
"
```

---

## 9. Emergency Procedures

### 9.1 Emergency Shutdown

If you need to take the hotline offline immediately:

```bash
cd /opt/llamenos/deploy/docker

# Stop all services
docker compose down

# Verify nothing is running
docker compose ps
```

To bring it back:

```bash
docker compose up -d
# Wait for health checks
docker compose logs -f app
```

### 9.2 Data Breach Response

If you suspect unauthorized access to data:

1. **Do NOT shut down the server immediately** -- preserve evidence.

2. **Capture forensic data**:
   ```bash
   # Capture running processes
   ps auxww > /tmp/forensics-ps-$(date +%s).txt

   # Capture network connections
   ss -tulpn > /tmp/forensics-netstat-$(date +%s).txt

   # Capture Docker state
   docker compose ps > /tmp/forensics-docker-$(date +%s).txt
   docker compose logs > /tmp/forensics-logs-$(date +%s).txt

   # Capture login history
   last > /tmp/forensics-last-$(date +%s).txt
   lastb > /tmp/forensics-lastb-$(date +%s).txt
   ```

3. **Assess the impact**:
   - **E2EE notes are NOT exposed** even in a full server breach. The server never has plaintext note content.
   - **Metadata IS exposed**: call timestamps, volunteer pubkeys, caller phone hashes, audit log entries.
   - **Telephony credentials** stored in `.env` or the database may be exposed.
   - **Session tokens** in the database may be exposed (attacker could impersonate users until tokens expire).

4. **Contain**:
   ```bash
   # Revoke all active sessions by restarting with new HMAC secret
   NEW_HMAC=$(openssl rand -hex 32)
   sed -i "s|^HMAC_SECRET=.*|HMAC_SECRET=${NEW_HMAC}|" .env
   docker compose restart app
   ```

5. **GDPR notification** (if applicable): You have 72 hours to notify the supervisory authority if personal data was breached. Prepare a report covering:
   - Nature of the breach
   - Categories and approximate number of data subjects affected
   - Likely consequences
   - Measures taken to address the breach

### 9.3 Ransomware Response

If the server is encrypted by ransomware:

1. **Do NOT pay the ransom.**
2. Isolate the server (disable networking at the VPS provider dashboard).
3. Provision a new server following the [Quick Start Guide](QUICKSTART.md).
4. Restore from the most recent encrypted backup (stored off-site).
5. Rotate all secrets.
6. Report to law enforcement if appropriate for your jurisdiction.

### 9.4 Complete Infrastructure Rebuild

If you need to rebuild from scratch (server unrecoverable, no trust in existing infrastructure):

```bash
# On a new, clean server:

# 1. Follow the Quick Start Guide sections 1-4
# 2. Restore database from off-site backup
# 3. Restore RustFS blobs from off-site backup
# 4. Generate new admin keypair (bun run bootstrap-admin)
# 5. Rotate ALL secrets
# 6. Update DNS to point to new server
# 7. Notify volunteers to re-authenticate
```

The admin will need to re-wrap note encryption envelopes with the new admin keypair. This requires volunteers to be online.

### 9.5 Telephony Provider Outage

If your telephony provider is down (Twilio outage, etc.):

1. Calls will fail to route. The application itself continues to function for messaging and notes.
2. Check provider status pages (e.g., status.twilio.com).
3. If the outage is extended, consider switching providers:
   - Go to Settings > Telephony Provider in the admin UI.
   - Select an alternative provider and enter its credentials.
   - Save and test.
4. Update the phone number's webhook URLs at the new provider.

---

## 10. Disaster Recovery Drills

Regular DR drills verify that backups are restorable and that the team can execute recovery procedures under time pressure.

**Full DR scenario documentation**: See [DR_SCENARIOS.md](DR_SCENARIOS.md) for five detailed scenarios covering server total loss, database corruption, ransomware, key compromise, and hosting provider shutdown.

### 10.1 Run an Automated DR Drill

The DR test playbook provisions a fresh, isolated Docker environment (port 3333, project name `llamenos-dr-test`), restores from the latest backup, validates all services, measures time-to-recovery, and tears down. It never touches production data.

```bash
cd deploy/ansible
just dr-test
```

The playbook supports both encrypted (`.age`) and unencrypted (`.sql.gz`) backups. Results are saved as JSON in the `dr-results/` directory for historical tracking.

### 10.2 Review DR History

```bash
cd deploy/ansible
just dr-status
```

Displays the last 5 DR test results and RTO compliance.

### 10.3 Drill Schedule

Run automated DR drills **quarterly**. Alternate between full restore tests and tabletop exercises (walking through a scenario without executing). See [DR_SCENARIOS.md](DR_SCENARIOS.md) for the recommended quarterly rotation.

### 10.4 RTO Targets

| Scenario | Target RTO |
|----------|-----------|
| Server total loss | < 4 hours |
| Database corruption | < 1 hour |
| Ransomware | < 4 hours |
| Key compromise | < 2 hours |
| Hosting provider shutdown | < 8 hours |

If a DR drill exceeds the target RTO, investigate the bottleneck (provisioning speed, backup download time, DNS propagation) and address it before the next drill.

---

## Appendix: Maintenance Schedule

| Task | Frequency | Procedure |
|------|-----------|-----------|
| Verify backups | Weekly | [Section 4.3](#43-verify-backup-integrity) |
| Review audit logs | Weekly | Admin UI > Audit Log |
| Check disk usage | Weekly | [Section 6.3](#63-system-monitoring) |
| OS security updates | Automatic | `unattended-upgrades` |
| Docker image updates | Monthly | `docker compose pull && docker compose up -d` |
| Secret rotation | Quarterly | [Section 1](#1-secret-rotation) |
| TLS certificate | Automatic | Caddy auto-renewal |
| Database vacuum | Monthly | [Section 3.4](#34-vacuum-and-analyze) |
| Dependency audit | Monthly | `bun audit` against latest source |
| Backup retention cleanup | Automatic | Cron script (30-day default) |
| DR drill (automated) | Quarterly | `just dr-test` — [Section 10](#10-disaster-recovery-drills) |
| Penetration test | Annually | Engage external security firm |

---

## 11. Case Management System (CMS)

The CMS is an optional module that adds structured case tracking, contact management, and field reporting to Llamenos. Everything in the CMS is template-driven -- entity types, fields, statuses, and report types are all defined by JSON templates, not hardcoded.

For template authoring details, see the [Template Authoring Guide](TEMPLATE_AUTHORING.md).

### 11.1 Enabling CMS

CMS is disabled by default. To enable it:

1. Log in as an admin.
2. Navigate to **Settings > Case Management**.
3. Toggle **Enable Case Management** to on.
4. The toggle calls `PUT /api/settings/cms/case-management` with `{ "enabled": true }`.

Once enabled, the Cases, Contacts, and Reports navigation items appear for users with appropriate permissions.

### 11.2 Applying a Template

Templates define the structure of your CMS. You must apply at least one template before creating cases.

1. Navigate to **Settings > Case Management > Template Browser**.
2. Browse the 14 bundled templates. Each shows a name, description, and tags.
   - The API endpoint is `GET /api/settings/cms/templates`, which returns all bundled templates with metadata.
   - To view full template details: `GET /api/settings/cms/templates/:id`.
3. Select a template and click **Apply**.
   - This calls `POST /api/settings/cms/templates/apply` with `{ "templateId": "jail-support" }`.
4. The system creates:
   - All entity types defined in the template (with fields, statuses, severities)
   - Relationship types between entity types and contacts
   - Report types (if the template defines them)
   - The template's suggested roles become available for creation

**What applying does NOT do**: It does not create volunteer roles automatically. After applying, go to **Settings > Roles > Create from Template** to create roles from the template's suggestions. This gives you the chance to review and customize permissions before activating them.

**Applying multiple templates**: You can apply more than one template. Entity types from different templates coexist. If two templates define entity types with the same `name`, the second application merges new fields into the existing entity type.

**Checking for updates**: `GET /api/settings/cms/templates/updates` compares applied template versions against bundled versions and reports available updates.

### 11.3 Customizing Entity Types

After applying a template, you can customize entity types through the Schema Editor:

1. Navigate to **Settings > Case Management > Entity Types**.
2. Select an entity type to edit.
3. You can:
   - **Add fields**: New fields are appended to the entity type. Set the `name`, `type`, `accessLevel`, and `order`.
   - **Modify statuses**: Add, rename, reorder, or remove statuses. Ensure `closedStatuses` stays consistent.
   - **Change access levels**: Adjust `defaultAccessLevel` on the entity type or `accessLevel` on individual fields.
   - **Toggle features**: Enable/disable `allowSubRecords`, `allowFileAttachments`, `allowInteractionLinks`, `showInNavigation`, `showInDashboard`.

**API endpoints**:
- List entity types: `GET /api/settings/cms/entity-types`
- Create entity type: `POST /api/settings/cms/entity-types`
- Update entity type: `PATCH /api/settings/cms/entity-types/:id`
- Delete entity type: `DELETE /api/settings/cms/entity-types/:id`

**Report types** are managed separately:
- List report types: `GET /api/settings/cms/cms-report-types`
- Create report type: `POST /api/settings/cms/cms-report-types`
- Update report type: `PATCH /api/settings/cms/cms-report-types/:id`
- Delete report type: `DELETE /api/settings/cms/cms-report-types/:id`

### 11.4 Understanding Encryption Tiers

CMS data is encrypted at three tiers:

| Tier | What It Covers | Who Can Read | How It Works |
|------|---------------|--------------|--------------|
| **Summary** | Entity type, status, severity, timestamps, case number | All users with `cases:read-*` permission | Encrypted with the hub key. Visible in list views and dashboards. |
| **Fields** | All non-PII custom fields (descriptions, dates, select values) | Users matching the field's `accessLevel` | Encrypted per-field. Decrypted client-side only when the user has the appropriate access level. |
| **PII** | Fields listed in `piiFields` (names, addresses, phone numbers, financial data) | Users with explicit `contacts:view-pii` permission | Encrypted with a restricted key. Requires a separate permission grant. Excluded from previews and notifications. |

The encryption tier is determined automatically based on the template configuration:
- Fields listed in `piiFields` get the PII tier.
- All other fields get the standard Fields tier.
- Summary data (status, timestamps, case number) gets the Summary tier.

### 11.5 Contact Directory

The contact directory provides a deduplicated view of all contacts across cases. Contacts are linked to cases via relationship types with specific roles (e.g., "Tenant", "Attorney", "Caller").

**Deduplication via blind index**: When a new contact is created, the system computes a blind index (HMAC) from the contact's key identifiers (name + phone or name + email). If a matching blind index already exists, the system offers to link the existing contact rather than creating a duplicate.

Key operations:
- Contacts are created when linking a person to a case for the first time.
- The same contact can be linked to multiple cases in different roles.
- Contact PII (full name, phone, address) is encrypted at the PII tier.
- The blind index allows server-side duplicate detection without the server seeing plaintext contact data.

### 11.6 CMS Troubleshooting

#### Template not appearing in the browser

| Symptom | Cause | Solution |
|---------|-------|----------|
| Template missing from list | Template JSON not in `packages/protocol/templates/` | Add the file and rebuild |
| Template shows but cannot be applied | JSON validation error | Check server logs for schema validation errors. Common: missing `options` on select fields, duplicate field names |
| "Template already applied" warning | Template was previously applied | This is informational. Re-applying merges new fields without duplicating existing ones |

#### Fields not saving

| Symptom | Cause | Solution |
|---------|-------|----------|
| Field appears but value is not persisted | Field `name` contains invalid characters | Use lowercase letters and underscores only |
| Conditional field never appears | `showWhen` references wrong field name | Verify the `field` value in `showWhen` matches an existing field's `name` |
| Select field shows empty dropdown | Missing or empty `options` array | Add `options` with `key` and `label` for each choice |

#### Access denied errors

| Symptom | Cause | Solution |
|---------|-------|----------|
| Volunteer cannot see cases | Missing `cases:read-own` or `cases:read-assigned` permission | Add the permission to their role |
| Volunteer cannot see PII fields | Missing `contacts:view-pii` permission | Add if appropriate; PII access is intentionally restricted |
| Volunteer cannot create reports | Missing `reports:create` permission | Add to their role. Check that report types exist (template must define them) |
| "Case management not enabled" | CMS feature toggle is off | Admin must enable via Settings > Case Management |

#### Auto-assignment not working

Auto-assignment (`PUT /api/settings/cms/auto-assignment`) routes new cases to available volunteers. If cases are not being assigned:

1. Verify auto-assignment is enabled: **Settings > Case Management > Auto-Assignment**.
2. Check that volunteers have `cases:accept` permission.
3. Verify volunteers are on shift and not marked as busy.

#### Database queries for CMS data

```bash
# Count entity types configured
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT key, value->>'id' AS entity_type
  FROM storage
  WHERE namespace = 'settings' AND key = 'entityTypes';
"

# Count cases by namespace
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT namespace, count(*)
  FROM storage
  WHERE namespace LIKE 'case:%'
  GROUP BY namespace;
"

# Check applied templates
docker compose exec postgres psql -U llamenos -d llamenos -c "
  SELECT value
  FROM storage
  WHERE namespace = 'settings' AND key = 'appliedTemplates';
"
```
