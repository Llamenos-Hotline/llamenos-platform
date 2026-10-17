# Backup and Restore

Backups are installed and run by the Ansible playbooks in
`deploy/ansible/playbooks/`. This document describes the procedures as
they were **actually executed and verified**, not as designed — every
command below is one the round-trip test runs.

> **Verified round trip.** `deploy/ansible/scripts/verify-backup-restore.sh`
> backs up a database with known content, destroys it, runs the real
> `playbooks/restore.yml`, and asserts the content came back. It runs in
> CI on every change under `deploy/ansible/`. Run it yourself with
> `just verify-backup-restore`. If you change anything in this document's
> subject matter, change that test first.

## What Gets Backed Up

| Service | Data | Criticality |
|---------|------|-------------|
| **PostgreSQL** | All application data (calls, notes, volunteers, shifts, audit logs, key material) | Critical |
| **RustFS** | File attachments (the `/data` Docker volume, archived directly) | Medium |
| **Config** | `{{ app_dir }}/services/` — every service's Compose file and `.env` — plus the Caddyfile | Critical |

The config archive contains **every service secret**: the database
password, the server identity secret, and every provider credential.
That is why encryption is mandatory (below) and why the archive must
never be handled as an ordinary file.

### What is *not* backed up

- **The Ansible vault.** It lives on your control node, not on the
  server, so no server-side role can reach it. Back it up where it lives.
- **Write-ahead logs.** There is no WAL archiving and therefore no
  point-in-time recovery. RPO is the backup interval — 24 hours by
  default. (A `backup_postgres_wal_enabled` flag used to exist and only
  ever created an empty directory; it was removed rather than left to
  imply a capability that did not exist.)

## Prerequisites

- Ansible installed on the control node
- Inventory configured at `deploy/ansible/inventory.yml`
- **An age keypair.** This is required, not optional — see below.
- (Optional but strongly recommended) `rclone` configured for offsite copies

`age` itself is installed on the server by the backup roles.

## Encryption is mandatory

There is no unencrypted backup path. The backup scripts refuse to run
without a recipient key, and `playbooks/preflight.yml` fails the deploy
if `backup_enabled` is true and `backup_age_public_key` is unset.

Generate the keypair **on your admin machine, never on the server**:

```bash
age-keygen -o backup-key.txt
# public key: age1...
```

Put the `age1...` public half in `backup_age_public_key` in
`deploy/ansible/vars.yml`. Store `backup-key.txt` somewhere safe and off
the server — a private key sitting next to the backups it decrypts
protects nothing, and both the database dump and the archive holding
every `.env` go to the same offsite remote.

Every artifact is written as `*.age`. The round-trip test asserts this,
and additionally greps every artifact (and its gunzipped form) for the
database password to prove nothing readable escapes.

## Backup Procedure

### Automated — part of every deploy

`setup.yml` imports `playbooks/backup.yml`, so a deployed host always has
the backup scripts and the daily cron. Nothing extra to remember.

```bash
cd deploy/ansible
just setup-all           # or: ansible-playbook setup.yml --ask-vault-pass
```

To install or refresh only the backup layer:

```bash
just backup              # ansible-playbook playbooks/backup.yml --ask-vault-pass
```

This installs scripts under `{{ app_dir }}/scripts/` and schedules a
daily run at 03:00 UTC. The cron runs `backup-all.sh`, which calls each
service script in dependency order and writes a manifest with SHA-256
checksums.

### Manual / on-demand

```bash
ssh deploy@YOUR_SERVER
/opt/llamenos/scripts/backup-all.sh
```

Single service:

```bash
/opt/llamenos/scripts/backup-postgres.sh   # PostgreSQL only
/opt/llamenos/scripts/backup-rustfs.sh     # RustFS objects only
/opt/llamenos/scripts/backup-config.sh     # Service configs only
```

Or via Ansible tags:

```bash
just backup-service postgres
just backup-service rustfs
just backup-service config
```

### Layout and retention

```
{{ app_dir }}/backups/
  postgres/{daily,weekly,monthly}/llamenos-postgres-<ts>.dump.age
  rustfs/{daily,weekly,monthly}/llamenos-rustfs-<ts>.tar.gz.age
  config/{daily,weekly,monthly}/llamenos-config-<ts>.tar.gz.age
  manifest-YYYYMMDD-HHMMSS.txt    # checksums, last 30 runs
  manifest.log
  backup.log
```

PostgreSQL is dumped with `pg_dump --format=custom` from inside the
container — a consistent logical snapshot, restored with `pg_restore`.
It is **not** a `.sql.gz` and `psql` cannot read it.

RustFS is archived by streaming a tarball of the Docker volume behind the
container's `/data` mount. This needs no S3 client and no credentials.

### Offsite copies

Set `backup_rclone_remote` in `vars.yml`. Without it, every copy sits on
the same disk as the database it protects, so host loss is total data
loss. Preflight warns when it is empty.

Note: retention pruning currently applies to the local directories only.
An offsite remote needs its own lifecycle policy.

### Monitoring

Set `backup_monitor_webhook_url` in `vars.yml`. Without it the daily
health check still runs, but writes only to
`{{ app_dir }}/backups/monitor.log`, which nobody reads — a missed backup
is then discovered during the incident that needs it. Preflight warns
when it is empty.

---

## Restore Procedure

**Restore is destructive**: it drops and recreates the database. Do a dry
run first.

Restoring brings the stack back up **even if the restore fails part
way**. The start-the-stack step lives in the playbook's `always` block
precisely so that a failed recovery cannot also leave the application
down.

### Dry run

```bash
cd deploy/ansible
just restore-dry-run
```

### Full restore from the latest backup

```bash
cd deploy/ansible
just restore
# equivalently:
# ansible-playbook playbooks/restore.yml --ask-vault-pass \
#   -e backup_age_private_key_path=/path/to/backup-key.txt
```

Order:

1. Stop every service Compose project under `{{ app_dir }}/services/*/`
2. Decrypt and restore the config archive (the whole `services/` tree, plus the Caddyfile)
3. Start PostgreSQL only; drop, recreate and `pg_restore` the database
4. Validate — count tables in the `public` schema; **fail loudly if zero**
5. Stop RustFS, write the restored objects back into its data volume, start it
6. Start every service Compose project and wait for `/api/health`

### Point-in-time (from a specific backup)

```bash
ansible-playbook playbooks/restore.yml --ask-vault-pass \
  -e restore_timestamp=20260308-030000
```

### A single service

```bash
ansible-playbook playbooks/restore.yml --ask-vault-pass --tags postgres
ansible-playbook playbooks/restore.yml --ask-vault-pass --tags rustfs
ansible-playbook playbooks/restore.yml --ask-vault-pass --tags config
```

### Cross-host restore

```bash
rsync -av deploy@OLD_SERVER:/opt/llamenos/backups/ /tmp/llamenos-backups/

ansible-playbook playbooks/restore.yml --ask-vault-pass \
  -e restore_source_dir=/tmp/llamenos-backups \
  -e backup_age_private_key_path=/path/to/backup-key.txt
```

The private key must be reachable from the target host for the decrypt
step. Remove it again when the restore finishes.

---

## Verification

### After a restore

```bash
# Tables actually present (the restore playbook asserts this is non-zero)
docker compose -f /opt/llamenos/services/postgres/docker-compose.yml \
  exec -T postgres psql -U llamenos -d llamenos -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"

# Spot-check a table you expect to have rows
docker compose -f /opt/llamenos/services/postgres/docker-compose.yml \
  exec -T postgres psql -U llamenos -d llamenos -tAc \
  "SELECT count(*) FROM hubs"

# Application health
curl -sf http://localhost:3000/api/health
curl -sf http://localhost:3000/health/ready

# Every service Compose project
for f in /opt/llamenos/services/*/docker-compose.yml; do
  echo "== $f"; docker compose -f "$f" ps
done
```

### Ongoing

```bash
just backup-status          # is the backup monitor healthy?
just test-restore           # monthly: restore the host's latest REAL backup
                            # into a scratch container and assert a schema
just verify-backup-restore  # local: full round trip, no host involved
```

`just verify-backup-restore` is the one that proves the *mechanism*;
`just test-restore` is the one that proves *this host's actual backups*
are restorable. Do both.

---

## See Also

- `deploy/ansible/scripts/verify-backup-restore.sh` — the verified round trip (CI runs this)
- `deploy/ansible/playbooks/backup.yml` — backup orchestration, imported by `setup.yml`
- `deploy/ansible/playbooks/restore.yml` — restore
- `deploy/ansible/playbooks/test-restore.yml` — on-host restore drill
- `deploy/ansible/group_vars/all/compose.yml` — canonical per-service Compose paths
- `docs/runbooks/disaster-recovery.md` — full server-loss recovery
