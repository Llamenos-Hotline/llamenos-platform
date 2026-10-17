# Disaster Recovery

## Purpose

Recover the Llamenos platform from a complete server loss.

## Recovery Targets

| Metric | Target |
|---|---|
| RTO (Recovery Time Objective) | 2 hours |
| RPO (Recovery Point Objective) | 24 hours (daily backups; there is no WAL archiving, so there is no finer-grained recovery) |

## Prerequisites

- Access to backup storage (rclone remote configured)
- An account with your VPS provider
- Ansible vault password
- SSH key for deployment

## Full Recovery Procedure

### 1. Provision new VPS

Follow the OpenTofu module docs under `deploy/opentofu/modules/` for
your provider:
- Order a VPS (Debian 13, 4GB+ RAM) with full-disk encryption — the
  backup and restore plays refuse to write data at rest on a host that
  declares `llamenos_disk_encrypted: false`
- Add the deploy SSH key
- Note the public IPv4/IPv6

### 2. Update DNS

Update A/AAAA records for `api`, `updates`, `releases` subdomains to new VPS IP.

### 3. Restore backups

```bash
# List available backups
rclone ls <remote>:llamenos-backups/

# Download latest backup
rclone copy <remote>:llamenos-backups/<latest_date>/ /tmp/restore/
```

### 4. Run deployment

```bash
./deploy/scripts/deploy-official.sh
```

### 5. Restore database, object store and config

Do not hand-roll this. `restore.yml` decrypts the archives, drops and
recreates the database, runs `pg_restore`, writes the object store back
into its Docker volume, restores every service's config, and brings the
stack up again — and it brings the stack up even if a step fails.

```bash
# Put the backups where the new host can read them
rsync -av /tmp/restore/ deploy@<new_ip>:/tmp/llamenos-backups/

cd deploy/ansible
ansible-playbook playbooks/restore.yml --ask-vault-pass \
  -e restore_source_dir=/tmp/llamenos-backups \
  -e backup_age_private_key_path=/path/to/backup-key.txt
```

The private key must be reachable for the decrypt step; remove it from
the host again afterwards.

> **The previous version of this runbook was wrong and would have failed
> during an incident.** It told you to `gunzip | psql` a file called
> `postgres-backup.sql.gz` — a name no script has ever produced, in a
> format `psql` cannot read. Backups are `pg_dump --format=custom`,
> age-encrypted, named `llamenos-postgres-<ts>.dump.age`.

### 7. Verify

```bash
curl https://api.llamenos-hotline.org/api/health/ready
curl https://updates.llamenos-hotline.org/health

# Run smoke check
cd deploy/ansible
ansible-playbook playbooks/smoke-check.yml -i inventory-production.yml -e "@vars-production.yml" --ask-vault-pass
```

## Backup Verification

`setup.yml` installs the backup scripts and a daily 03:00 UTC cron on
every deploy, and encryption is mandatory (the scripts refuse to run
without an age recipient; preflight fails the deploy without one).

Offsite copies are **not** automatic: they happen only if
`backup_rclone_remote` is set. Until it is, every backup sits on the
same disk as the database it protects. Check which state you are in:

```bash
ssh deploy@<server>

# Latest artifacts (all must end in .age)
find /opt/llamenos/backups -type f -name 'llamenos-*' -printf '%T@ %p\n' \
  | sort -rn | head -5 | cut -d' ' -f2-

# Backup monitor verdict
tail -20 /opt/llamenos/backups/monitor.log
```

```bash
cd deploy/ansible
just backup-status
```

## Restore Testing

Two different tests. Run both; they prove different things.

**Monthly — does *this host's actual backup* restore?** Restores the
latest real backup into a throwaway container on the host and asserts it
yields a non-empty schema. Non-destructive; production is untouched.

```bash
cd deploy/ansible
just test-restore
```

**On every change — does the *mechanism* still work?** Backs up known
content, destroys it, runs the real `restore.yml`, asserts the content
came back, and asserts no artifact leaks a secret. Runs entirely against
throwaway containers; touches no host. CI runs it on every change under
`deploy/ansible/`.

```bash
cd deploy/ansible
just verify-backup-restore
```

The second test exists because every defect found in the 2026-09-27 audit
of this area — a justfile that did not parse, a restore that validated
against a table dropped years earlier, backups that no deploy installed —
was found by running the playbooks, and none of them by reading the
playbooks. Read-only review of this area has a poor track record. Run it.

This provisions a temporary server, restores from backup, runs health checks, and tears down.
