# Incident Response Runbook

**Version:** 1.2
**Date:** 2026-05-18

Procedures for responding to security incidents affecting a Llamenos deployment. For key-specific procedures (admin key compromise, device seizure, hub key rotation), see [Key Revocation Runbook](KEY_REVOCATION_RUNBOOK.md).

**Audience**: Administrators and operators responsible for a Llamenos instance.

---

## Severity Levels

| Level | Definition | Response Time | Examples |
|-------|------------|--------------|---------|
| **Critical** | Active compromise with data exfiltration risk | Immediate (< 1 hour) | Admin key compromise, server breach with running exploit |
| **High** | Confirmed compromise, no active exfiltration detected | < 4 hours | Device seizure, hostile user departure, CI/CD compromise |
| **Medium** | Suspected compromise or vulnerability discovered | < 24 hours | Unusual audit log patterns, dependency vulnerability |
| **Low** | Hardening gap or policy violation | < 1 week | Missing security header, expired backup rotation |

---

## 1. Server Compromise

### Detection Signals
- Unauthorized processes or containers running
- Unexpected configuration changes in audit log
- Anomalous outbound network connections
- Modified application binaries or container images
- Alerts from Trivy / security scanning

### Response

1. **Assess scope**: Determine if the attacker has access to the running application, database, or just the host OS.

2. **E2EE content is safe**: Even with full server access, the attacker cannot read E2EE note content, messages, or files. The server stores only ciphertext and HPKE envelopes.

3. **Rotate all server-side secrets**:
   ```bash
   # Generate new secrets
   openssl rand -hex 32  # New PG_PASSWORD
   openssl rand -hex 32  # New SERVER_SECRET
   openssl rand -hex 32  # New HMAC_SECRET (hashing only; ban entries stop matching)
   # SERVER_KEK is NOT rotated by swapping the value: it needs a re-encrypt, see KEK_ROTATION.md

   # Update .env and redeploy
   docker compose down
   # Update .env with new values
   docker compose up -d
   ```

4. **Rotate telephony credentials**: Regenerate API keys/tokens for Twilio, SignalWire, etc. in their dashboards.

5. **Review audit logs**: Check for unauthorized actions during the compromise window.

6. **Rotate hub key**: If the attacker could have captured hub key material from server memory, rotate immediately (see [Key Revocation Runbook, Section 4](KEY_REVOCATION_RUNBOOK.md#4-hub-key-rotation-ceremony)).

7. **Notify users**: Users' device keys are client-side and unaffected. They may need to re-authenticate after session invalidation.

8. **Forensics**: If the server is a VPS, request a disk image from the provider before rebuilding. Preserve logs.

9. **Rebuild**: Deploy fresh from a known-good commit. Verify with reproducible build (`scripts/verify-build.sh`).

### What the Attacker Could NOT Obtain
- Note content, message content, file content (E2EE)
- Device private keys (client-side only)
- PUK seeds (HPKE-wrapped, server has ciphertext only)

### What the Attacker COULD Obtain
- Plaintext metadata (call timestamps, durations, routing data)
- HMAC secret (lets the holder test guessed phone numbers against stored hashes)
- `SERVER_KEK` (opens provider credentials, reply addresses and queued sends; see [KEK_ROTATION.md](KEK_ROTATION.md))
- The `ban-hash-key` file (lets the holder test guessed numbers against the ban list)
- Telephony credentials (can make API calls to telephony providers)
- Server secret (can impersonate server on WebSocket)
- Hub key (if captured from memory — can decrypt hub events)

---

## 2. CI/CD Compromise

### Detection Signals
- Unauthorized workflow runs in GitHub Actions
- Modified workflow files or repository secrets
- Unexpected deployments or container image pushes
- Supply chain alerts (compromised GitHub Action, dependency)

### Response

1. **Revoke all GitHub repository secrets** immediately.
2. **Audit recent commits** and deployments — check for unauthorized changes.
3. **Verify all GitHub Actions are SHA-pinned** (not floating tags).
4. **Rebuild and redeploy** from a known-good commit:
   ```bash
   git log --oneline --since="2 weeks ago"  # Find last known-good commit
   git checkout <known-good-sha>
   docker compose build --no-cache
   docker compose up -d
   ```
5. **Rotate server-side secrets** (attacker may have exfiltrated from CI environment).
6. **Verify reproducible build**: Run `scripts/verify-build.sh` against the redeployed version.

---

## 3. User Account Compromise

A user's device keys have been compromised (stolen credentials, phishing, malware).

### Response

1. **Deactivate the user** in admin panel (sessions auto-revoked).
2. **Deauthorize compromised device** via sigchain (`remove-device` entry).
3. **Assess exposure**:
   - The compromised user's notes are accessible to the attacker (author envelope)
   - Other users' notes are NOT accessible (per-note HPKE wrapping, different keys)
   - Hub events during the compromise window may be accessible if the user held the hub key
   - If only the user's signing key is compromised (not encryption key): attacker can impersonate the user but cannot decrypt notes (key separation)
   - If device was seized: Argon2id (64MB memory, 3 iterations, 4 parallelism) provides meaningful delay against GPU brute-force of the PIN — begin hub key rotation within 1 hour
4. **Rotate hub key** (Section 4 of Key Revocation Runbook).
5. **Generate a new invite** for the user to re-onboard with fresh device keys.

---

## 4. Signal-Notifier Compromise

The signal-notifier sidecar (port 3100) handles Signal message delivery and contact resolution.

### Detection Signals
- Unusual entries in `signal_audit_log` table (PostgreSQL)
- Rate limiter triggering on unexpected IPs
- Bearer token auth failures in logs
- Unexpected `notify_failed` or `rate_limited` audit actions

### Response

1. **Rotate the bearer token** (`SIGNAL_NOTIFIER_BEARER_TOKEN`). The sidecar supports timing-safe comparison and token rotation (current + previous key):
   ```bash
   # Generate new token
   openssl rand -hex 32
   # Update in both app .env and signal-notifier .env
   # Restart both services
   docker compose restart app signal-notifier
   ```

2. **Review audit logs**: Query `signal_audit_log` for anomalous actions:
   ```sql
   SELECT action, identifier_hash, success, error_message, created_at
   FROM signal_audit_log
   WHERE created_at > NOW() - INTERVAL '24 hours'
   ORDER BY created_at DESC;
   ```

3. **Assess exposure**: The signal-notifier uses zero-knowledge contact resolution (HMAC-hashed identifiers). An attacker with sidecar access could:
   - Send Signal messages to hashed identifiers they enumerate
   - Observe which identifiers have Signal registrations
   - NOT reverse HMAC hashes without the HMAC secret (held by the app, not the sidecar)

4. **If the HMAC secret is also compromised**: The attacker can test guessed phone numbers against stored hashes. Rotate `HMAC_SECRET` in the app; stored hashes (ban entries, audit IP hashes) stop matching rather than being re-hashed, because the numbers are not stored. `HMAC_SECRET` only hashes (D6): rotating it does not touch provider credentials or any encrypted data. If `SERVER_KEK` is also exposed, follow [KEK_ROTATION.md](KEK_ROTATION.md): it is a re-encrypt, not a restart.

### Key Separation Note

The server's event signing key and event encryption key are derived independently from `SERVER_SECRET` using separate HKDF labels. A signing key compromise (attacker can publish fake events) does NOT compromise event content confidentiality, and vice versa. When assessing server compromise scope, determine which derived key was exposed.

---

## 5. Dependency Vulnerability

A critical vulnerability is discovered in a dependency (Rust crate, npm package, Docker base image).

### Response

1. **Assess impact**: Is the vulnerability exploitable in Llamenos's usage of the dependency?
2. **Patch immediately** if exploitable:
   ```bash
   # Rust dependencies
   cargo update -p <crate-name>
   cargo test --manifest-path packages/crypto/Cargo.toml --features mobile
   cargo audit

   # npm dependencies
   bun update <package-name>
   bun audit

   # Docker base images
   # Update SHA256 pins in docker-compose.yml and Dockerfile
   docker compose build --no-cache
   ```
3. **Deploy the patched version**.
4. **If the vulnerability is in crypto dependencies** (`hpke`, `ed25519-dalek`, `x25519-dalek`, `aes-gcm`): Treat as Critical severity regardless of CVSS score. These crates underpin all E2EE properties.

---

## 6. Data Breach Notification (GDPR)

If personal data of callers or users may have been exposed:

### Timeline
- **72 hours**: Notify supervisory authority (from time of becoming aware)
- **Without undue delay**: Notify affected data subjects (if high risk)

### Notification Content
1. Nature of the breach and compromised data types
2. Categories and approximate number of data subjects affected
3. Likely consequences
4. Measures taken (key rotation, session invalidation, patches)
5. Contact details of DPO or responsible person

### Documenting the Breach
Record in the audit log:
- Discovery timestamp
- Scope assessment
- Actions taken with timestamps
- GDPR notification status

---

## 7. Communication Templates

### Internal (to users)

> **Security Notice**: We detected [unauthorized access to / a vulnerability in] our infrastructure on [date]. Your encrypted notes and messages remain protected — our end-to-end encryption ensures the server cannot read your data. As a precaution, we have [rotated keys / invalidated sessions / etc.]. You may need to re-authenticate. If you notice any unusual activity, contact your administrator immediately.

### External (to supervisory authority)

> We are reporting a personal data breach pursuant to Article 33 GDPR. On [date], we became aware that [description]. The breach affects approximately [N] data subjects. Due to our end-to-end encryption architecture, [note content / messages / files] were not accessible to the attacker. The following plaintext data may have been exposed: [metadata types]. We have taken the following remediation steps: [list].

---

## 7. Blast/Broadcast Abuse

The blast system sends bulk messages to subscriber lists across SMS, WhatsApp, Signal, Telegram, and RCS channels. An attacker who gains access to a hub admin account can misuse this to send malicious bulk messages to all subscribers.

### Detection Signals

- Unexpected blast creation or scheduling in audit log
- Unusual message content in blast deliveries
- Subscriber complaint volume spike
- Rate limiter events on delivery channels (`rateLimits: { sms: 10/s, whatsapp: 25/s, ... }`)
- `maxBlastsPerDay` (default: 10) limit triggered unexpectedly

### Impact Assessment

- Blast/broadcast abuse cannot expose E2EE note/message content (separate system)
- Subscriber identifiers are HMAC-hashed — an attacker with DB access cannot reverse them without `HMAC_SECRET`
- Blast content arrives in plaintext at carrier/provider — exposure is at the telco layer, not the Llamenos server

### Response

1. **Immediately deactivate the compromised admin account** via database:
   ```bash
   docker compose exec postgres psql -U llamenos -d llamenos -c "
     UPDATE users SET active = false
     WHERE signing_pubkey = '<admin_pubkey>';
   "
   ```

2. **Cancel any pending blasts**:
   ```bash
   docker compose exec postgres psql -U llamenos -d llamenos -c "
     UPDATE blasts SET status = 'cancelled'
     WHERE status IN ('draft', 'scheduled')
       AND hub_id = '<affected_hub_id>';
   "
   ```

3. **Rotate telephony provider credentials** (Twilio/SignalWire/etc. dashboard) to prevent further delivery even if the blast job queue is still running.

4. **Review audit log** for all blast-related actions in the compromise window:
   ```sql
   SELECT action, actor_pubkey, resource_type, resource_id, created_at
   FROM audit_log
   WHERE action LIKE '%blast%'
     AND created_at > NOW() - INTERVAL '24 hours'
   ORDER BY created_at DESC;
   ```

5. **Rotate the compromised admin's keys** (see [Key Revocation Runbook, Section 1](KEY_REVOCATION_RUNBOOK.md#1-admin-key-compromise-response)).

6. **Notify subscribers** if harmful content was delivered. Use a separate communication channel (not the blast system).

7. **Assess GDPR obligations**: If subscriber personal data (phone numbers, preferences) was accessed or exported, notify per Section 6 below.

---

## 8. Recovery Group Compromise

A recovery group holder's device has been compromised or seized, potentially exposing their Shamir share of a user's PUK seed.

### Severity Assessment

A single compromised holder share reveals **zero information** about the PUK seed (information-theoretic security below threshold K). The scenario only becomes critical if K or more holders are compromised simultaneously.

| Holders compromised | Risk level | Action |
|--------------------|------------|--------|
| < K (threshold) | Low — no secret derivable | Rotate recovery group, remove compromised holder |
| ≥ K (threshold) | Critical — PUK seed reconstructible | Rotate PUK immediately + rotate recovery group |

### Response

1. **Remove the compromised holder** from the recovery group via admin UI.

2. **If < K holders are compromised**: Rotate the recovery group (new shares, new holders) per [Key Revocation Runbook, Section 9](KEY_REVOCATION_RUNBOOK.md#9-recovery-group-key-rotation-ep09). The PUK itself may not need rotation.

3. **If ≥ K holders are compromised** (critical path):
   - Rotate the user's PUK immediately (new seed, new sigchain `rotate-puk` entry)
   - Generate new Shamir shares of the new PUK seed
   - Enroll a new recovery group with trusted holders

4. **Audit recovery sessions**: Check if any recovery session was initiated during the compromise window:
   ```sql
   SELECT id, hub_id, status, initiated_at, completed_at
   FROM recovery_sessions
   WHERE created_at > NOW() - INTERVAL '7 days'
   ORDER BY created_at DESC;
   ```

5. **Assess data exposure**: Even with PUK reconstruction, the attacker needs device keys to decrypt individual note envelopes. PUK alone enables future items key derivation but does not retroactively decrypt past notes unless device keys are also available.

---

## 9. Entity Evidence Chain Tampering

Entity records (cases) support an evidence chain — a hash-chained custody log for attached evidence files. Tampering with the chain can obstruct legal proceedings or destroy forensic integrity.

### Detection Signals

- `verify_integrity` endpoint returns `integrityValid: false`
- Missing or orphaned custody chain entries in audit log
- File hashes in `evidence_metadata` don't match stored objects in RustFS
- Unexpected `custody_chain` entries with anomalous `actor_pubkey` values

### Impact Assessment

- Evidence chain integrity does NOT affect E2EE properties of notes/messages
- Tampering affects admissibility/reliability of case evidence, not user privacy
- Server-side tampering is possible if an attacker has database write access (see Server Compromise scenario)

### Response

1. **Verify the chain** for affected records:
   ```bash
   curl -H "Authorization: Bearer <token>" \
     "https://api.example.com/records/<case_id>/evidence/<evidence_id>/verify"
   ```
   The response includes `integrityValid`, `hashChainValid`, and per-entry verification status.

2. **Preserve the original state**: Before any remediation, dump the current `custody_chain` table entries to an offline record.

3. **Identify the tampered entries**: `integrityValid: false` entries will have a `lastValidEntryId` pointing to the last trusted entry.

4. **If tampering was server-side** (database access): Treat as Server Compromise (Section 1). The attacker may have had write access to alter entry hashes.

5. **If tampering was client-side** (fabricated custody entry submitted via API): Check audit log for the submitting `actor_pubkey` and revoke that device's access.

6. **Notify affected parties**: Cases with compromised evidence chains should be flagged for legal review.

---

## Post-Incident Review

After every Critical or High severity incident:

1. **Timeline reconstruction**: Document what happened, when, and how it was detected.
2. **Root cause analysis**: Identify the underlying vulnerability or failure.
3. **Remediation verification**: Confirm all fixes are deployed and effective.
4. **Process improvements**: Update this runbook, hardening guide, or monitoring based on lessons learned.
5. **Update threat model**: If the incident revealed a new attack vector, update [THREAT_MODEL.md](THREAT_MODEL.md).

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-05-18 | 1.2 | EP01–EP09 update: added Section 7 (blast/broadcast abuse — cancel pending blasts, rotate telephony creds, audit blast log); added Section 8 (recovery group compromise — threshold analysis, holder removal, PUK rotation if ≥K compromised); added Section 9 (entity evidence chain tampering — integrity verification, chain preservation, remediation) |
| 2026-05-03 | 1.1 | Added signal-notifier compromise scenario (Section 4); added key separation note (signing vs encryption keys); added Argon2id timeline guidance for device seizure; renumbered sections |
| 2026-05-02 | 1.0 | Initial incident response runbook |
