# Production Deployment Checklist

Pre-launch checklist for self-hosted Llamenos instances. Complete all items before accepting real calls.

## Operational Runbooks

Detailed procedures are in `docs/runbooks/`:

- [Self-Hosted Deployment](../docs/runbooks/deploy-self-hosted.md) — first-time setup for self-hosters
- [Official Deployment](../docs/runbooks/deploy-official.md) — production server deployment
- [DNS Migration](../docs/runbooks/dns-migration.md) — Cloudflare to 1984 cutover
- [Desktop Update Release](../docs/runbooks/desktop-update-release.md) — update server operations
- [Android Release](../docs/runbooks/android-release.md) — Play Console procedures
- [Rollback](../docs/runbooks/rollback.md) — rollback procedures
- [Disaster Recovery](../docs/runbooks/disaster-recovery.md) — full server recovery

## Infrastructure

- [ ] Server provisioned in Iceland (1984 Hosting) — GDPR compliance + privacy jurisdiction
- [ ] SSH access restricted to admin IPs only (not 0.0.0.0/0)
- [ ] SSH key authentication only (password auth disabled)
- [ ] Firewall rules: only 80, 443, and SSH port open
- [ ] Unattended security updates enabled
- [ ] fail2ban configured and running
- [ ] NTP synchronized (critical for Schnorr token validation)
- [ ] LUKS2 disk encryption active (verify: `cryptsetup status`)

## Docker Compose

- [ ] All images pinned to digest hashes (not `latest`)
- [ ] `.env` file has strong, unique secrets (not defaults)
- [ ] `PG_PASSWORD` is cryptographically random (≥24 chars)
- [ ] `HMAC_SECRET` is 64 hex chars (`openssl rand -hex 32`)
- [ ] `SERVER_SECRET` is 64 hex chars
- [ ] `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` are unique and >= 24 chars
- [ ] `ADMIN_PUBKEY` set to real admin's Ed25519 pubkey
- [ ] `ADMIN_DECRYPTION_PUBKEY` set to the admin's X25519 pubkey — the SECOND key
      `bun run bootstrap-admin` prints, a different value from `ADMIN_PUBKEY`.
      Required whenever `ADMIN_PUBKEY` is set; the server refuses to boot without
      it rather than encrypt notes to a key that cannot decrypt them (#1283).
- [ ] `DOMAIN` set to actual production domain
- [ ] `ACME_EMAIL` set for Let's Encrypt notifications
- [ ] `ENVIRONMENT=production` (not development)
- [ ] Docker network isolation: internal services not exposed to host
- [ ] Read-only root filesystem for app container
- [ ] Non-root user in all containers

## TLS & Domain

See [DNS Migration](../docs/runbooks/dns-migration.md) for DNS cutover procedures.

- [ ] Domain DNS A record points to server IP
- [ ] Caddy has auto-provisioned TLS certificate
- [ ] HTTPS works end-to-end (test with `curl -I https://yourdomain.org`)
- [ ] HTTP redirects to HTTPS
- [ ] HSTS header present with `includeSubDomains; preload`
- [ ] CSP header blocks inline scripts

## Health & Monitoring

- [ ] `/api/health/ready` returns 200 with all checks passing
- [ ] `/api/health/live` returns 200
- [ ] Docker healthchecks passing for all containers
- [ ] Structured JSON logs visible in `docker compose logs`
- [ ] Log rotation configured (≤50MB per file, ≤5 files)

## Backups

See [Disaster Recovery](../docs/runbooks/disaster-recovery.md) for backup and restore procedures.

- [ ] Automated daily backups configured and running
- [ ] Backup encryption key generated and stored OFFLINE
- [ ] Test restore verified (run `just test-restore`)
- [ ] Off-site backup destination configured (rclone)
- [ ] Backup retention policy: 7 daily, 4 weekly, 3 monthly

## RustFS (Object Storage)

- [ ] RustFS container running and healthy
- [ ] `llamenos-files` bucket exists (the app creates it on first start; confirm in the app logs)
- [ ] `STORAGE_ACCESS_KEY` and `STORAGE_SECRET_KEY` are unique and >= 24 chars
- [ ] SSE (server-side encryption) enabled (`storage_sse_enabled: true`)
- [ ] RustFS is **not** published on a host port (Docker network only) — desktop updates are served from the box's filesystem, not from RustFS (see below and `docs/deployment/first-deploy.md` §5)

## Desktop Distribution

See [Desktop Update Release](../docs/runbooks/desktop-update-release.md) for release artifact upload and updater configuration, and [First deploy §5](../docs/deployment/first-deploy.md#5-serving-desktop-updates-from-this-box) for the current status of the updater channel.

- [ ] `updates.<domain>` and `releases.<domain>` DNS A records (DNS-only, unproxied) point to the server IP
- [ ] `llamenos_update_server_enabled: true` (official profile); Caddy serves both hostnames from `/opt/llamenos/services/update-server/artifacts`
- [ ] `https://updates.<domain>/health` returns `ok`
- [ ] Release artifacts + `latest.json` uploaded under `artifacts/desktop/` (layout in the runbook)
- [ ] Tauri updater manifest reachable at `https://updates.<domain>/desktop/latest.json` and lists every shipped platform
- [ ] Code signing certificates configured (Windows: Authenticode, macOS: Developer ID)
- [ ] SLSA provenance attestation generated for each release
- [ ] CHECKSUMS.txt published with each release

## Telephony

- [ ] Twilio account configured (or Asterisk PBX set up)
- [ ] Phone number purchased and configured
- [ ] Inbound calls route correctly to the app
- [ ] Parallel ringing works (multiple volunteers ring)
- [ ] Call notes can be created and encrypted

## Application

- [ ] Admin account created (`bun run bootstrap-admin`)
- [ ] Admin can log in and access all features
- [ ] Volunteer invite flow works end-to-end
- [ ] E2EE notes: volunteer creates note, admin can decrypt
- [ ] Ban list functionality works
- [ ] Shift scheduling works

## Security

- [ ] Admin keypair backed up securely
- [ ] Hub key generated and distributed to team
- [ ] No secrets in Docker Compose file (all in `.env`)
- [ ] `.env` file permissions: 600 (owner-only read)
- [ ] No debug endpoints exposed in production
- [ ] WebSocket relay only accessible via authenticated connections

## Kubernetes (if using Helm)

- [ ] `helm lint` passes
- [ ] Secrets stored in Kubernetes Secrets (not values.yaml)
- [ ] PodDisruptionBudget configured for app
- [ ] Resource limits set for all containers
- [ ] RustFS uses StatefulSet (not Deployment)
- [ ] Liveness probe: `/api/health/live`
- [ ] Readiness probe: `/api/health/ready`
- [ ] NetworkPolicy restricts pod-to-pod traffic
- [ ] HPA configured for app deployment (if multi-replica)

## Post-Launch

- [ ] Verify calls work end-to-end (make a test call)
- [ ] Verify backup runs on schedule
- [ ] Set up uptime monitoring (e.g., UptimeRobot on `/api/health/ready`)
- [ ] Emergency procedures documented — see [Rollback](../docs/runbooks/rollback.md) and [Disaster Recovery](../docs/runbooks/disaster-recovery.md)
- [ ] Schedule regular security review cadence
