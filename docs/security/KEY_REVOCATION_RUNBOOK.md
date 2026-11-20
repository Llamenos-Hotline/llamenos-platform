# Key Revocation Runbook

**Version:** 2.2
**Date:** 2026-05-18

Operational procedures for emergency key revocation, rotation, and compromise response in Llamenos deployments.

**Audience**: Administrators responsible for operating a Llamenos instance.

**Related documents**:
- [Crypto Architecture](CRYPTO_ARCHITECTURE.md) — Key hierarchy and cryptographic protocols
- [Threat Model](THREAT_MODEL.md) — Threat analysis and trust boundaries
- [Incident Response](INCIDENT_RESPONSE.md) — General incident response procedures
- [Deployment Hardening](DEPLOYMENT_HARDENING.md) — Infrastructure security

**Conventions**: Commands assume a Docker Compose deployment in `/opt/llamenos/deploy/docker/`. All commands should be run as the `deploy` user unless otherwise noted.

---

## Table of Contents

1. [Admin Key Compromise Response](#1-admin-key-compromise-response)
2. [User Departure and Device Revocation](#2-user-departure-and-device-revocation)
3. [Device Seizure Response](#3-device-seizure-response)
4. [Hub Key Rotation Ceremony](#4-hub-key-rotation-ceremony)
5. [Hub Event Key Epoch Rotation](#5-hub-event-key-epoch-rotation)
6. [PUK Rotation on Departure](#6-puk-rotation-on-departure)
7. [Device Wipe (EP08)](#7-device-wipe-ep08)
8. [Account Erasure and Platform Ban Key Handling (EP08)](#8-account-erasure-and-platform-ban-key-handling-ep08)
9. [Recovery Group Key Rotation (EP09)](#9-recovery-group-key-rotation-ep09)
10. [Response Timeframe Summary](#10-response-timeframe-summary)

---

## 1. Admin Key Compromise Response

The admin device keys are the most privileged credentials in the system. Compromise grants the attacker the ability to decrypt all admin-wrapped note envelopes, all admin-wrapped message envelopes, and (if the admin held the hub key) all hub-encrypted WebSocket events. This is the highest-severity key compromise scenario.

**Responsible party**: The administrator (or a designated backup administrator with access to deployment infrastructure).

### 1.1 Immediate Actions (within 1 hour)

1. **Generate a new admin keypair** on a trusted device (not the compromised device):
   ```bash
   bun run bootstrap-admin
   ```
   This generates new Ed25519 signing + X25519 encryption keys. Record the new public keys securely.

2. **Update the deployment configuration** with the new admin public key:
   ```bash
   cd /opt/llamenos/deploy/docker
   sed -i "s|^ADMIN_PUBKEY=.*|ADMIN_PUBKEY=<new_pubkey>|" .env
   ```

3. **Redeploy the application**:
   ```bash
   docker compose restart app
   ```

4. **Verify the deployment** is running with the new key:
   ```bash
   docker compose exec app curl -sf http://localhost:3000/api/health/ready
   ```

5. **Deauthorize the compromised device** via sigchain. Publish a `remove-device` sigchain entry from another authorized admin device, referencing the compromised device's pubkey.

6. **Begin hub key rotation** immediately (see [Section 4](#4-hub-key-rotation-ceremony)).

### 1.2 Short-Term Actions (within 24 hours)

7. **Complete hub key rotation** (Section 4).

8. **Rotate PUK** for the admin user — generate new PUK seed, HPKE-wrap for remaining authorized devices, publish `rotate-puk` sigchain entry.

9. **Re-wrap all admin note envelopes** with the new admin X25519 pubkey. Each note's admin envelope must be re-HPKE-wrapped. Notes whose authors are offline cannot be re-wrapped until those users reconnect. Track progress in the admin UI.

10. **Re-wrap all admin message envelopes** similarly.

11. **Review the audit log** for anomalous access during the compromise window:
    - Unusual login times or IP addresses
    - Bulk data access or export
    - Settings or configuration changes
    - User account modifications

### 1.3 Assessment

12. **Determine what data was accessible**. The compromised admin key could decrypt:
    - All note envelopes HPKE-wrapped for the admin's X25519 pubkey
    - All message envelopes HPKE-wrapped for the admin
    - If the admin held the hub key: all hub-encrypted WebSocket events until hub key rotation

13. **Assess GDPR notification obligations**. If personal data may have been exposed, notify the supervisory authority within 72 hours.

### 1.4 Verification Checklist

- [ ] New admin keypair is active — admin can authenticate with new Ed25519 key
- [ ] Old admin device is deauthorized via sigchain `remove-device` entry
- [ ] Hub key has been rotated — test by publishing a hub event; active members can decrypt
- [ ] PUK rotated — old PUK seed excluded from new device wrapping
- [ ] All active user sessions are functional
- [ ] Audit log shows compromise response actions
- [ ] GDPR notification filed (if applicable) within 72 hours
- [ ] Re-wrapping progress tracked

---

## 2. User Departure and Device Revocation

When a user leaves the organization, their devices must be deauthorized via sigchain and they must be excluded from future key distributions.

**Responsible party**: An administrator.

### 2.1 Friendly Departure

1. **Deactivate the user** via the admin UI. This immediately revokes all active sessions.

2. **Deauthorize all user devices** via sigchain. Publish `remove-device` entries for each of the user's authorized devices. This is the authoritative record that these devices are no longer trusted.

3. **Rotate the hub key** (see [Section 4](#4-hub-key-rotation-ceremony)). The departed user does NOT receive the new key.

4. **Rotate PUK for affected data** (see [Section 6](#6-puk-rotation-on-departure)) — exclude the departed user from future PUK seed distributions.

5. **Verify post-departure access boundaries**:
   - Departed user CAN decrypt notes they authored (they have the author envelope keys)
   - Departed user CANNOT decrypt new hub events (new hub key)
   - Departed user CANNOT decrypt other users' notes (they never had those HPKE envelopes)
   - Departed user CANNOT access the application (sessions revoked, devices deauthorized)

6. **Document the departure** in the audit log.

#### Verification Checklist

- [ ] User is deactivated (status: inactive)
- [ ] All user devices deauthorized via sigchain
- [ ] No active sessions remain
- [ ] Hub key rotated — departed user excluded
- [ ] At least one remaining member confirms they can decrypt new hub events
- [ ] Departure documented in audit log

### 2.2 Hostile Departure

The user is leaving on bad terms, has been terminated, or is suspected of acting against the organization.

1. **Deactivate the user immediately** via admin UI. If UI is unavailable:
   ```bash
   docker compose exec postgres psql -U llamenos -d llamenos -c "
     UPDATE users SET active = false
     WHERE signing_pubkey = '<user_pubkey>';
   "
   docker compose restart app
   ```

2. **Deauthorize all devices via sigchain** — publish `remove-device` entries immediately.

3. **Rotate the hub key immediately** (Section 4).

4. **Rotate PUK** (Section 6).

5. **Revoke all WebAuthn credentials** for the user's devices.

6. **Conduct an access assessment**:
   - What notes did they author or have access to?
   - What hub events were encrypted with keys they possessed?
   - Did they have admin-level access at any point?
   - Review audit logs for data exfiltration patterns.

7. **If the user was an admin**: Treat as admin key compromise (Section 1).

8. **Assess GDPR notification obligations** based on accessible data.

#### Verification Checklist

- [ ] User deactivated — no active sessions
- [ ] All devices deauthorized via sigchain
- [ ] Hub key rotated — departed user excluded
- [ ] PUK rotated — departed user excluded
- [ ] All WebAuthn credentials revoked
- [ ] Access assessment documented
- [ ] GDPR notification filed (if applicable)

---

## 3. Device Seizure Response

A user's device has been physically seized. The threat is physical access to extract device keys from platform secure storage.

### 3.1 Panic Wipe (User Action)

If the user still has momentary access before seizure:

1. **Lock the app** (triggers zeroization of device keys from Rust CryptoState/MobileState).
2. On desktop (Tauri): Close the application — Stronghold seals on shutdown.
3. On mobile: Force-quit the app.

### 3.2 Hub-Side Response (Administrator Action)

Whether or not the panic action was taken, assume worst case:

4. **Deactivate the user** immediately via admin UI.

5. **Deauthorize the seized device** via sigchain (`remove-device` entry). If the user has other devices, only the seized device needs deauthorization.

6. **Rotate the hub key** (Section 4).

7. **Revoke WebAuthn credentials** for the seized device.

### 3.3 PIN/Passphrase Protection Assessment

Device private keys are encrypted under a credential-derived key using Argon2id (64MB memory, 3 iterations, 4 parallelism). Minimum credential is 8 decimal digits; alphanumeric passphrases (8+ chars with at least one letter) are also accepted.

| Credential Type | Argon2id brute-force cost (GPU) | Assessment |
|-----------------|--------------------------------|------------|
| 8-digit PIN | High (memory-bound) | Provides meaningful delay; begin hub rotation within 1 hour |
| 10-digit PIN | Very high | Provides days to weeks even on GPU clusters |
| Alphanumeric passphrase (8+ chars) | Extremely high | Strong protection; rotate hub key within 24 hours |

Argon2id's 64MB memory cost makes GPU/ASIC parallelization expensive compared to PBKDF2. However, PIN protection is still a delay mechanism, not a permanent barrier for well-funded adversaries. Hub key rotation must complete before expiration of the delay budget.

### 3.4 Post-Seizure Re-Onboarding

If the user continues with the organization on a new device:

8. Generate a new invite for the user.
9. User generates new device keys on new device.
10. Authorize new device via sigchain (signed by admin or another of the user's authorized devices).
11. User's old notes remain accessible to admin (admin envelope). The user can access historical notes if the CLKR chain is intact and their new device receives the current PUK seed.

---

## 4. Hub Key Rotation Ceremony

The hub key is a shared symmetric key used to encrypt WebSocket events broadcast to all members. Rotation ensures departed members cannot decrypt future events.

**Responsible party**: An administrator.

### 4.1 Preparation

1. **Identify all active members** who must receive the new hub key (admin UI: filter active).
2. **Document the reason** for rotation (departure, seizure, compromise, routine).
3. **Ensure secure connection** to the admin interface.

### 4.2 Rotation Steps

4. **Generate a new random 32-byte hub key**:
   - Admin UI provides "Rotate Hub Key" function
   - Or: `crypto.getRandomValues(new Uint8Array(32))`
   - The hub key is random bytes — NOT derived from any identity key

5. **HPKE-wrap the new hub key for each remaining member** using each member's X25519 pubkey (label: `LABEL_HUB_KEY_WRAP`). One HPKE envelope per member.

6. **Publish a key rotation event** via WebSocket:
   - Encrypted with the OLD hub key (so current members can read it)
   - Contains reference to new key version

7. **Each active member's client** receives the rotation event:
   - Decrypts using old hub key
   - Retrieves its individually-wrapped new key blob
   - HPKE-opens the new hub key using its device X25519 key
   - Stores the new hub key indexed by version

8. **Events after rotation** use the new key version.

9. **Old hub key retained** by clients for decrypting historical events.

10. **Departed/revoked members excluded** — no HPKE envelope generated for them.

### 4.3 Verification

- [ ] New hub key generated and HPKE-distributed to all active members
- [ ] At least one user confirms they can decrypt a test hub event
- [ ] Departed/revoked members excluded from distribution
- [ ] Old hub key retained for historical decryption
- [ ] Key rotation event visible in audit log
- [ ] Monitor 24 hours for rotation failures (offline members)

### 4.4 Rotation Failure Recovery

If rotation fails mid-ceremony:
- Do NOT re-use a partially distributed key
- Generate a fresh hub key
- Publish cancellation event encrypted with old hub key
- Restart ceremony

---

## 5. Hub Event Key Epoch Rotation

The server event key (used for XChaCha20-Poly1305 encryption of WebSocket events) rotates automatically every 24 hours. This is **automatic** — no operator action is required for routine epoch rotation.

### 5.1 How Epoch Rotation Works

The server event key is derived as:
```
event_key = HKDF-SHA256(SERVER_SECRET, salt=LABEL_SERVER_EVENT_ENCRYPTION_KEY[:hubId], info=LABEL_HUB_EVENT_EPOCH:[epoch])
```

Where `epoch = floor(unix_timestamp / 86400)` — a new key every 24 hours.

Clients receive the **current epoch key** and the **previous epoch key** from `GET /api/auth/me`. This ensures clients can decrypt events published just before an epoch boundary.

### 5.2 When Manual Action is Needed

| Scenario | Action |
|----------|--------|
| `SERVER_SECRET` compromised | Rotate `SERVER_SECRET` immediately (redeploy required). All past epoch keys are invalidated. Redistribute new epoch keys to clients via `/api/auth/me`. |
| Client stuck on old epoch | Client should receive previous epoch key from `/api/auth/me`. If persistent, check that client is syncing auth/me on reconnect. |
| Hub key rotation (member departure) | Hub key rotation is separate from epoch rotation. Both may be needed simultaneously — see [Section 4](#4-hub-key-rotation-ceremony). |

### 5.3 Emergency: Rotate SERVER_SECRET

If the server's secret is compromised, an attacker can decrypt all stored events (retroactively) and forge new events until the key is rotated.

1. Generate a new secret:
   ```bash
   openssl rand -hex 32   # Must be exactly 64 hex chars
   ```

2. Update `.env`:
   ```bash
   sed -i "s|^SERVER_SECRET=.*|SERVER_SECRET=<new_secret>|" .env
   ```

3. Redeploy:
   ```bash
   docker compose restart app
   ```

4. Verify the new server pubkey via `/api/config` after restart:
   ```bash
   # Derive new pubkey from new secret
   bun run bootstrap-admin  # or use the /api/config endpoint after restart
   ```

5. All connected WebSocket clients will receive the new epoch key automatically. No separate relay restart is needed.

All clients will receive the new epoch key on next `GET /api/auth/me`. Old epoch keys derived from the compromised secret are permanently invalidated.

---

## 6. PUK Rotation on Departure

When a user departs or a device is compromised, the PUK must be rotated so the departed user/device cannot derive future items keys or note epoch keys.

### 5.1 Rotation Steps

1. **Generate new PUK seed** (random 32 bytes) for generation N+1
2. **Encrypt old seed** (gen N) with new secretbox key (gen N+1) → CLKR chain link
3. **HPKE-wrap new seed** for each remaining authorized device (label: `LABEL_PUK_WRAP_TO_DEVICE`)
4. **Publish `rotate-puk` sigchain entry** recording the generation change
5. **Departed user's devices excluded** from new seed distribution

### 5.2 Impact

- Notes encrypted under old PUK generations remain decryptable by remaining users via CLKR chain walk
- Departed user retains their copy of the old PUK seed — they can decrypt notes from their tenure
- Departed user cannot derive new items keys or epoch keys (they don't have the new PUK seed)

---

## 7. Device Wipe (EP08)

A device wipe forcibly clears a device's local key material without requiring the user to be present. This is appropriate when a device is suspected compromised, has been surrendered, or is subject to organizational policy enforcement.

**Responsible party**: An administrator (or the user on their own device).

### 7.1 How Device Wipe Works

1. **Admin issues a wipe command** via the admin UI for a specific device (identified by device ID and user pubkey).
2. **The wipe authorization** is an Ed25519-signed payload (label: `LABEL_DEVICE_WIPE_SIG`) binding:
   - target device ID
   - target user pubkey
   - timestamp
   - admin pubkey (signer)
3. **The wipe command** is delivered to the target device via WebSocket push event.
4. **On receipt**, the client app calls `mobile_lock()` (mobile) or equivalent (desktop), zeroizing all in-memory key material, then deletes the local key store (Keychain / EncryptedSharedPreferences / Tauri Store).
5. **If the device is offline**: The wipe command is queued and delivered on next connection.

### 7.2 Post-Wipe Steps

6. **Deauthorize the device via sigchain** (`remove-device` entry) — this prevents re-authentication even if key material is somehow recovered.
7. **Rotate the hub key** (Section 4) — the wiped device held a copy of the hub key.
8. **If the device belonged to a recovery group holder**: Rotate the recovery group (Section 9).

### 7.3 Verification Checklist

- [ ] Wipe command delivered and acknowledged (check audit log)
- [ ] Device deauthorized via sigchain
- [ ] No active sessions remain for the wiped device
- [ ] Hub key rotated
- [ ] Recovery group rotation initiated if applicable

---

## 8. Account Erasure and Platform Ban Key Handling (EP08)

Account erasure is a permanent, irreversible operation that removes a user's data and destroys their key material. Platform bans additionally prevent re-registration.

**Responsible party**: Administrator (for admin erasure) or the user themselves (self-service, subject to configurable delay).

### 8.1 Erasure Types

| Type | Initiator | Delay | Override |
|------|-----------|-------|----------|
| Self-service | User | Configurable (default: 72h) | User can cancel before delay expires |
| Emergency self-service | User | Immediate | Requires signed override token |
| Admin erasure | Admin | Immediate | N/A |

### 8.2 Cryptographic Cascade

On erasure execution, the following crypto cascade occurs in order:

1. **Audit user key deletion** (`audit_user_keys` row deleted): All audit log `details` fields for this user are permanently undecryptable (crypto-shredding). The actual ciphertext rows remain for regulatory compliance; only the decryption key is destroyed.

2. **PUK envelope deletion**: All HPKE envelopes for this user's devices are deleted. The user cannot derive future items keys or note epoch keys.

3. **Device key deauthorization**: All sigchain entries for this user's devices are superseded by `remove-device` entries. All sessions invalidated.

4. **Hub key exclusion**: The departed user's X25519 pubkey is excluded from future hub key distribution. If immediate revocation is required, rotate the hub key now (Section 4).

5. **WebAuthn credentials revoked**: All WebAuthn credentials for the account are deleted.

6. **Provisioning rooms cleared**: Any open provisioning rooms associated with this account are closed.

### 8.3 Platform Ban Key Handling

When a platform ban is issued (cross-hub, admin-only), additional handling applies:

1. Phone number hash is added to the platform ban list (`platform_bans` table). Checked before call routing.
2. Existing hub bans are superseded — the platform ban applies across all hubs on the instance.
3. **No key material is created for banned accounts** — bans operate on HMAC-hashed identifiers, never plaintext.

### 8.4 Erasure Override Authentication

Emergency erasure overrides (to bypass the delay timer) require an Ed25519 signature over a nonce using the requesting user's device key (label: `LABEL_ERASURE_OVERRIDE_SIG`). The server verifies this signature before executing immediate erasure. The minimum delay floor (`EMERGENCY_MIN_HOURS = 4`) cannot be bypassed by any client-provided override — this is enforced server-side in `ErasureService`.

### 8.5 Verification Checklist

- [ ] `audit_user_keys` row deleted (audit details crypto-shredded)
- [ ] PUK envelopes deleted
- [ ] All devices deauthorized via sigchain
- [ ] Sessions invalidated
- [ ] WebAuthn credentials deleted
- [ ] Hub key rotated (if immediate exclusion needed)
- [ ] Recovery group rotation initiated (if user was a recovery group holder)
- [ ] Platform ban entry created (if applicable)
- [ ] GDPR deletion acknowledged in audit log

---

## 9. Recovery Group Key Rotation (EP09)

A recovery group holds K-of-N Shamir shares of a user's PUK seed, enabling account recovery when the user loses access to all their devices. The group must be rotated when a holder departs, is compromised, or when the PUK is rotated.

**Responsible party**: The hub admin or the user themselves (with `recovery:manage` permission).

### 9.1 When Rotation is Required

- A recovery group holder departs the organization or is removed
- A holder's device is seized or compromised
- The protected user's PUK is rotated (new PUK generation = new shares needed)
- Routine rotation per organizational policy (annually recommended)
- The recovery group's signing key is compromised

### 9.2 Rotation Steps

1. **Generate new PUK seed** (if the existing seed is also being rotated — usually done simultaneously with user PUK rotation per Section 6).

2. **Split the secret**: Using `shamir.rs`, split the PUK seed (or recovery key material) into N shares with threshold K (K∈[2,5], N∈[3,5], K≤N). Constraints enforced in the crate; choose K≥N/2+1 for majority quorum.

3. **HPKE-wrap each share** for the corresponding holder's X25519 pubkey (label: `LABEL_RECOVERY_GROUP_SHARE_WRAP`). One HPKE envelope per holder.

4. **Generate SHA-256 commitments** for each share (`shamir.rs` `generate_commitments()`). Published with the group enrollment so holders can verify they received a valid share.

5. **Submit duress commitments** (optional): Alternative share values that, if combined, produce a duress signal rather than the actual secret. Used for coercion scenarios.

6. **Publish enrollment via** `POST /recovery/enroll`:
   - `threshold` (K), `totalShares` (N)
   - `shareEnvelopes[]` — one HPKE-wrapped share per holder
   - `shareCommitments[]` — SHA-256 commitments
   - `sigchainLinkHash` — binds this enrollment to a specific PUK generation

7. **Notify holders**: Each holder receives their envelope and proves liveness (Recovery Requests → "Verify my share"): their device signs a fresh server challenge with a key derived from the share itself (`LABEL_RECOVERY_LIVENESS_PROOF`, #2782). Rotation replaces every holder's liveness key, so each holder must prove again before the admin view shows them as healthy.

8. **Decommission old group**: Old share envelopes should be explicitly invalidated in the database.

### 9.3 Recovery Session Key Handling

When a recovery session is initiated:

1. User initiates via Signal verification (out-of-band identity check)
2. Each holder submits their share contribution, signed with `LABEL_RECOVERY_SHARE_CONTRIBUTE`
3. Once K contributions are received, the server reconstructs the PUK seed via Lagrange interpolation over GF(2^8)
4. Reconstructed seed is HPKE-wrapped to the recovering user's new device (label: `LABEL_RECOVERY_PUK_SEED_WRAP`)
5. Plaintext seed is immediately discarded from server memory

### 9.4 Verification Checklist

- [ ] New shares generated and HPKE-distributed to all new holders
- [ ] SHA-256 commitments match published values
- [ ] All old share envelopes deleted
- [ ] Sigchain link hash matches current PUK generation
- [ ] At least one holder confirms they can decrypt their share envelope
- [ ] Old holders excluded from new group
- [ ] Enrollment recorded in audit log

---

## 10. Response Timeframe Summary

| Scenario | Action | Maximum Timeframe |
|----------|--------|-------------------|
| Admin key compromise | Immediate actions (new keypair, redeploy, sigchain deauthorize) | 1 hour |
| Admin key compromise | Hub key rotation BEGINS | 4 hours |
| Admin key compromise | Short-term actions (re-wrapping, PUK rotation, audit review) | 24 hours |
| Admin key compromise | GDPR breach notification (if applicable) | 72 hours |
| User departure (friendly) | Deactivation + sigchain deauthorize + hub key rotation | Same day |
| User departure (hostile) | Deactivation + sigchain deauthorize + hub key rotation | Immediately |
| Device seizure (no panic wipe) | Deactivation + sigchain deauthorize + hub key rotation | 1 hour |
| Device seizure (panic wipe confirmed) | Hub key rotation (precautionary) | 24 hours |
| Routine hub key rotation | Scheduled | Per organizational policy (quarterly recommended) |
| Hub event key epoch rotation | Automatic | Every 24 hours — no operator action required |
| SERVER_SECRET compromise | Emergency rotation | Immediately — rotate secret, redeploy |
| Device wipe issued | Wipe + sigchain deauthorize + hub key rotation | 1 hour |
| Account erasure (admin) | Crypto cascade + audit key deletion + sessions | Immediate |
| Account erasure (self-service) | Crypto cascade after delay | Per hub config (default: 72h, min: 4h override) |
| Recovery group holder departure | Recovery group rotation | Same day |
| Recovery group compromise | Rotate recovery group + PUK | Immediately |

---

## Revision History

| Date | Version | Changes |
|------|---------|---------|
| 2026-05-18 | 2.2 | EP08–EP09 update: added Section 7 (device wipe — LABEL_DEVICE_WIPE_SIG, admin-initiated remote wipe via signed authorization); added Section 8 (account erasure + platform ban — crypto-shredding cascade, audit key deletion, emergency override auth via LABEL_ERASURE_OVERRIDE_SIG, 4h minimum floor); added Section 9 (recovery group key rotation — Shamir threshold, HPKE share distribution, liveness proofs, session reconstruction); updated Table of Contents; extended timeframe summary |
| 2026-05-03 | 2.1 | Post-hardening: added Section 5 (hub event key epoch rotation + SERVER_SECRET emergency rotation); updated Section 3.3 to reflect Argon2id + min 8-digit/alphanumeric credential; updated response timeframes table |
| 2026-05-02 | 2.0 | Complete rewrite: HPKE replaces ECIES for all key wrapping, sigchain-based device deauthorization replaces nsec revocation, added PUK rotation section, added CLKR chain references, updated device storage (Tauri Store/Keychain/Keystore not localStorage), removed Cloudflare Workers references, updated panic wipe to platform-native lock |
| 2026-02-25 | 1.0 | Initial version |
