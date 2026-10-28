# Server secrets: one role each, and rotating `SERVER_KEK`

Decision D6 (#2171). Every server secret has exactly one job. A secret that does
two jobs couples their rotations and their blast radius: rotating a hashing key
used to break telephony, because the same value also encrypted the stored
provider credentials.

| Secret | Only job | Where it lives | If it leaks | Rotating it |
|---|---|---|---|---|
| `HMAC_SECRET` | Hashing: phone/IP hashes, signed IVR media URLs, preference tokens | `.env` | An attacker with the database can test guessed phone numbers against stored hashes | Safe. Hashes stop matching (ban entries, audit IP hashes). Nothing becomes unreadable |
| `SERVER_KEK` | Encrypts data the server must read back (table below) | `.env` | An attacker with the database reads provider credentials and reply addresses | Needs a re-encrypt (below). **Not** a restart-and-go change |
| `SERVER_SECRET` | HKDF root for the relay and server identity keys | `.env` | Forged relay events | Re-derives the server identity; clients re-pin |
| `BAN_HASH_KEY` | Keys the ban-list hash | Secret **file** `/run/secrets/ban-hash-key`; never `.env`, never a config backup | Same as `HMAC_SECRET` but for the ban list | Empties the ban list: the numbers are not stored, so nothing can be re-hashed |
| `MESSAGING_HASH_KEY` | Keys the per-hub messaging-thread hash | Secret **file** `/run/secrets/messaging-hash-key`; never `.env`, never a config backup | An attacker with the database can test guessed numbers against thread hashes, hub by hub | Every returning contact opens a new thread: the identifiers behind the hashes are sealed, and re-hashing them all would put every contact in memory at once. Messages and reply addresses are untouched |
| `NOTIFIER_TOKEN_SECRET` | Signs/verifies Signal-notifier registration tokens | Compose env (`signal` profile) | Forged registration tokens | Safe; re-issue tokens |
| `SIP_REGISTRAR_SECRET` | Master secret for every volunteer's PJSIP endpoint password | `.env` (asterisk only) | Anyone can derive SIP passwords | Rotates every volunteer's SIP credential at once |

None of these falls back to another. The app refuses to start when `HMAC_SECRET`,
`SERVER_SECRET`, `SERVER_KEK`, the ban key or the messaging key share a value, when
`SERVER_KEK`, the ban key file or the messaging key file is missing, and when
`BAN_HASH_KEY` or `MESSAGING_HASH_KEY` is set as an environment variable. In-app SIP is refused while `SIP_REGISTRAR_SECRET` is unset, and
Signal registration tokens are refused while `NOTIFIER_TOKEN_SECRET` is unset.

## What `SERVER_KEK` seals

Each value is AES-256-GCM under a key derived from `SERVER_KEK` with HKDF and a
domain-separation label. A value sealed under the old KEK cannot be opened under
the new one, and nothing in the schema records which KEK sealed a row.

| Table.column | Label | Content |
|---|---|---|
| `provider_configs.credentials` | `LABEL_STORAGE_CREDENTIAL_WRAP` | Telephony/messaging provider credentials (hex) |
| `signal_registrations.phone_number` | `LABEL_STORAGE_CREDENTIAL_WRAP` | The hub's Signal number (hex) |
| `a2p_registrations.brand_sid`, `.campaign_sid` | `LABEL_STORAGE_CREDENTIAL_WRAP` | A2P registration SIDs (hex) |
| `hub_storage_credentials.encrypted_secret_key` | `LABEL_STORAGE_CREDENTIAL_WRAP` | Hub object-store secret key (hex) |
| `contact_identifiers.encrypted_identifier` | `LABEL_CONTACT_ID` | Conversation reply address (`enc:` + hex) |
| `subscribers.encrypted_identifier` | `LABEL_CONTACT_ID` | Blast subscriber address (`enc:` + hex) |
| `signal_message_queue.recipient_identifier_ciphertext` | `LABEL_CONTACT_ID` | Queued Signal recipient (hex) |
| `signal_message_queue.encrypted_body` | `LABEL_MESSAGE` | Queued Signal body (hex) |

Everything else the server stores is either E2EE to readers' devices (notes,
messages, call records) or sealed under `SERVER_SECRET`-derived keys (the per-user
audit key copy).

## Rotating `SERVER_KEK`

There is no migration tool and none is planned before production: the app is
pre-production and holds no data that needs one. This is the procedure for the day
it does. It is a re-encrypt, run with the app stopped, from a host that holds both
KEKs.

1. **Back up first.** Take a `pg_dump` and verify it restores (`verify-backup-restore.yml`).
   A re-encrypt that fails halfway leaves a mix of old- and new-sealed rows.
2. **Generate the new KEK**: `openssl rand -hex 32`. It must differ from every
   other server secret.
3. **Stop the app** (`docker compose stop app`). Workers and the Signal queue
   drain must not run while rows are mid-rewrite.
4. **Re-seal every row in the table above**, in one database transaction:
   open each value with the old KEK and the label shown, seal the plaintext with the
   new KEK and the same label, write it back. Use the same primitives the app uses
   (`serverDecrypt` / `serverEncrypt` in `apps/worker/lib/crypto.ts`), so the format
   and label cannot drift. Preserve the `enc:` prefix on contact identifiers.
   Count the rows rewritten per column and compare against `SELECT count(*)`
   of the non-null rows; the counts must match exactly.
5. **Change `SERVER_KEK`** in `vars.yml` (Ansible: `server_kek`) or `.env`, redeploy.
6. **Verify on the new KEK before reopening**: start the app, then check a hub's
   telephony provider status in the admin UI (credentials decrypt) and send a test
   reply on an existing conversation (reply address decrypts). A swallowed
   decrypt failure shows as a provider that "has no credentials", so do not skip this.
7. **Destroy the old KEK** everywhere it was copied, including the old `.env`
   in rollback snapshots (`.rollback/services`) and any config backup older than
   the rotation. A backup still containing the old KEK plus a database dump from
   before the rotation reads everything the rotation was meant to protect.

If the KEK is lost without a rotation, every row above is unrecoverable. Provider
credentials can be re-entered by an admin; conversation reply addresses and queued
sends cannot be reconstructed.

## `BAN_HASH_KEY` and `MESSAGING_HASH_KEY` are deliberately not in the backups

The ban key and the messaging key must stay out of the database *and* out of anything that is backed up
with it, or the database plus its backup read the ban list. So it is a file
(`<app_dir>/secrets/<name>` on Ansible hosts, `deploy/docker/secrets/<name>`
for Compose, a separate Secret each for Helm; `<name>` is `ban-hash-key` and
`messaging-hash-key`), outside the services directory that
`backup-config` archives and that `update.yml` snapshots. `backup-config` refuses to
run if a backup path would collect either, and `verify-backup-restore.yml` decrypts the
config archive and asserts both keys are absent.

The consequence is accepted (A16): a full rebuild without your own copy loses every
ban (`ban-hash-key`) and splits every returning contact into a new thread
(`messaging-hash-key`). Keep an offline copy of each: the vault-encrypted `vars.yml` on
the control node (`ban_hash_key`, `messaging_hash_key`) is that copy for Ansible
deployments; for Compose, copy `secrets/ban-hash-key` and `secrets/messaging-hash-key`
somewhere offline when `first-run.sh` creates them.
