# Llámenos Cryptographic Protocol Specification

> **⚠️ DEPRECATED.** This document describes Llamenos v1 cryptography (nsec, ECIES, secp256k1).
> The canonical interoperability specification is `docs/protocol/PROTOCOL.md`.
> This file is retained as historical reference only.

**Version:** 2.0
**Date:** 2026-02-25
**Status:** DEPRECATED — historical reference only

**Related Documents**:

- [Security Overview](../security/README.md) — Entry point for security auditors
- [Data Classification](../security/DATA_CLASSIFICATION.md) — Complete data inventory
- [Threat Model](../security/THREAT_MODEL.md) — Adversaries and trust boundaries
- [Security Audit R6](../security/SECURITY_AUDIT_2026-02-R6.md) — Latest audit findings

## 1. Overview

Llámenos uses a layered cryptographic architecture designed to protect volunteer and caller identity against well-funded adversaries. The system is built on three principles:

1. **Key material never persists in plaintext** — the identity key (nsec) is always PIN-encrypted at rest and held in a closure variable during use, never in sessionStorage or global scope.
2. **Per-artifact encryption** — each note, message, and file uses a fresh random key, wrapped per-recipient via ECIES, providing forward secrecy at the data layer.
3. **Device-centric auth** — the nsec is a recovery-only secret. Day-to-day authentication uses PIN unlock of the local encrypted key store.

## 2. Key Hierarchy

```
Identity Key (nsec / secretKey)
  32-byte secp256k1 scalar
  Generated once during onboarding
  BIP-340 x-only public key (npub)
  └── PIN-Encrypted Local Store (Section 3)
  └── Recovery Key Encryption (Section 9)
  └── Auth Token Signing (Section 4)
  └── ECIES Key Agreement (Sections 5-7)
   └── WebSocket Authentication (Section 4.3)

Admin Decryption Key (Epic 76.2)
  Separate secp256k1 keypair from identity key
  └── Note admin envelope unwrapping (Section 5)
  └── Message admin envelope unwrapping (Section 6)
  └── Metadata decryption (Section 14)

Hub Key (Epic 76.2)
  32-byte random: crypto.getRandomValues(new Uint8Array(32))
  NOT derived from any identity key
  └── WebSocket event content encryption (XChaCha20-Poly1305 + HKDF per-event)
  └── Presence encryption (volunteer-tier: boolean only)
  └── Distribution: ECIES-wrapped individually per member ("llamenos:hub-key-wrap")

Server Event Key (Epic 76.1)
  Derived: HKDF-SHA256(SERVER_SECRET, "llamenos:server-event-key", "llamenos:server-event-key:v1")
  └── Signs server-authoritative WebSocket events (call:ring, call:answered)
  └── Clients verify server pubkey for authoritative events
  └── CANNOT decrypt any user content

Per-Note Key
  32-byte random
  Generated per note creation/edit
  └── ECIES-wrapped for author (Section 5)
  └── ECIES-wrapped for each admin (Section 5)

Per-Message Key (Epic 74)
  32-byte random
  Generated per message
  └── ECIES-wrapped for assigned volunteer ("llamenos:message")
  └── ECIES-wrapped for each admin ("llamenos:message")

Per-File Key
  32-byte random (XChaCha20-Poly1305)
  └── ECIES-wrapped per recipient (Section 7)

Draft Encryption Key
  Derived: HKDF-SHA256(secretKey, "llamenos:hkdf-salt:v1", "llamenos:drafts")
  └── Deterministic — acceptable since drafts are local-only
```

### 2.1 Domain Separation Labels

Every cryptographic operation uses a unique domain separation string to prevent cross-context key reuse attacks. The authoritative source is `src/shared/crypto-labels.ts`; this table must match that file exactly (25 constants).

#### ECIES Key Wrapping

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `LABEL_NOTE_KEY` | `"llamenos:note-key"` | Per-note symmetric key ECIES wrapping | 5.2 |
| `LABEL_FILE_KEY` | `"llamenos:file-key"` | Per-file symmetric key ECIES wrapping | 7 |
| `LABEL_FILE_METADATA` | `"llamenos:file-metadata"` | File metadata ECIES encryption | 7 |
| `LABEL_HUB_KEY_WRAP` | `"llamenos:hub-key-wrap"` | Hub key ECIES distribution to members | 14 |

#### Content Encryption

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `LABEL_TRANSCRIPTION` | `"llamenos:transcription"` | Transcription ECIES encryption | 6 |
| `LABEL_MESSAGE` | `"llamenos:message"` | E2EE message envelope encryption | 6 |
| `LABEL_CALL_META` | `"llamenos:call-meta"` | Encrypted call record metadata (assignments) | 14 |
| `LABEL_SHIFT_SCHEDULE` | `"llamenos:shift-schedule"` | Encrypted shift schedule details | 14 |

#### HKDF Derivation

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `HKDF_SALT` | `"llamenos:hkdf-salt:v1"` | HKDF salt for legacy symmetric key derivation | 5.4 |
| `HKDF_CONTEXT_NOTES` | `"llamenos:notes"` | HKDF context for legacy V1 note encryption | 5.4 |
| `HKDF_CONTEXT_DRAFTS` | `"llamenos:drafts"` | HKDF context for draft encryption | 8 |
| `HKDF_CONTEXT_EXPORT` | `"llamenos:export"` | HKDF context for export encryption | — |
| `LABEL_HUB_EVENT` | `"llamenos:hub-event"` | Hub event HKDF derivation from hub key | 14 |

#### ECDH Key Agreement

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `LABEL_DEVICE_PROVISION` | `"llamenos:device-provision"` | Device provisioning ECDH shared key derivation | 10 |

#### SAS Verification

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `SAS_SALT` | `"llamenos:sas"` | SAS HKDF salt for provisioning verification | 10 |
| `SAS_INFO` | `"llamenos:provisioning-sas"` | SAS HKDF info parameter | 10 |

#### Authentication

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `AUTH_PREFIX` | `"llamenos:auth:"` | Schnorr auth token message prefix | 4 |

#### HMAC Domain Separation

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `HMAC_PHONE_PREFIX` | `"llamenos:phone:"` | Phone number hashing prefix | — |
| `HMAC_IP_PREFIX` | `"llamenos:ip:"` | IP address hashing prefix | — |
| `HMAC_KEYID_PREFIX` | `"llamenos:keyid:"` | Key identification hash prefix | 3.1 |
| `HMAC_SUBSCRIBER` | `"llamenos:subscriber"` | Subscriber identifier HMAC key | — |
| `HMAC_PREFERENCE_TOKEN` | `"llamenos:preference-token"` | Preference token HMAC key | — |

#### Recovery / Backup

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `RECOVERY_SALT` | `"llamenos:recovery"` | Recovery key PBKDF2 fallback salt (legacy) | 9 |
| `LABEL_BACKUP` | `"llamenos:backup"` | Generic backup encryption | 9 |

#### Server WebSocket Identity

| Constant | Label | Purpose | Section |
|----------|-------|---------|---------|
| `LABEL_SERVER_EVENT_KEY` | `"llamenos:server-event-key"` | HKDF derivation for server event keypair from `SERVER_SECRET` | 14 |
| `LABEL_SERVER_EVENT_KEY_INFO` | `"llamenos:server-event-key:v1"` | HKDF info parameter for server event key (versioned for rotation) | 14 |

## 3. Local Key Protection

### 3.1 PIN-Encrypted Key Store

The identity key is stored in `localStorage` encrypted under a PIN-derived Key Encryption Key (KEK).

**Key Derivation:**
```
PIN (6-8 digits, UTF-8 encoded)
  → PBKDF2-SHA256(PIN, salt, 600,000 iterations)
  → 32-byte KEK
```

**Encryption:**
```
nsec (bech32 string, UTF-8 encoded)
  → XChaCha20-Poly1305(KEK, random_nonce_24)
  → ciphertext
```

**Storage format (localStorage `llamenos-encrypted-key`):**
```json
{
  "salt": "<hex, 16 bytes>",
  "iterations": 600000,
  "nonce": "<hex, 24 bytes>",
  "ciphertext": "<hex>",
  "pubkey": "<truncated SHA-256 hash of pubkey, 8 bytes hex>"
}
```

The `pubkey` field is a truncated hash (not the plaintext pubkey) to allow identification of which key is stored without leaking identity.

### 3.2 Key Manager (Runtime)

The Key Manager (`key-manager.ts`) is a singleton that holds the decrypted secret key in a module-scoped closure variable — never on `window`, `sessionStorage`, or any globally accessible object.

**States:**
- **Locked**: `secretKey === null`. Only session-token-based auth (WebAuthn) is available. Crypto operations that require the secret key are unavailable.
- **Unlocked**: `secretKey` is a `Uint8Array` in memory. Full crypto operations available.

**Operations:**
- `unlock(pin)` — Decrypts nsec from localStorage via PBKDF2+XChaCha20, derives secretKey, validates against server.
- `lock()` — Zeros out the secretKey bytes (`secretKey.fill(0)`), sets to null.
- `importKey(nsec, pin)` — For onboarding/recovery: encrypts nsec to localStorage, loads into memory.
- `getSecretKey()` — Returns secretKey or throws `KeyLockedError`.
- `getPublicKey()` — Returns hex pubkey (available even when locked, from stored key ID and server profile).
- `createAuthToken(timestamp)` — Creates Schnorr-signed auth token.

**Auto-lock triggers:**
- Configurable idle timeout (default: 5 minutes of no API activity)
- `document.visibilitychange` when `document.hidden === true` (tab backgrounded)
- Explicit `lock()` call

## 4. Authentication Tokens

### 4.1 Schnorr Signature Token

Used when the Key Manager is unlocked.

```
message = "llamenos:auth:{pubkey_hex}:{timestamp_ms}"
hash = SHA-256(message)
signature = BIP-340 Schnorr Sign(hash, secretKey)
token = JSON({ pubkey, timestamp, token: hex(signature) })
```

**Wire format:** `Authorization: Bearer <token_json>`

**Server validation:**
- Parse JSON, extract pubkey, timestamp, signature
- Reject if `|now - timestamp| > 5 minutes`
- Verify BIP-340 signature over `SHA-256("llamenos:auth:{pubkey}:{timestamp}")`
- Look up volunteer record by pubkey

### 4.2 Session Token

Used for WebAuthn-authenticated sessions and as fallback when Key Manager is locked.

```
token = 32 random bytes, hex-encoded
```

**Wire format:** `Authorization: Session <token_hex>`

**Server validation:**
- Look up `session:{token}` in IdentityDO storage
- Check expiry (8 hours from creation)
- Extract associated pubkey

### 4.3 WebSocket Authentication

Clients authenticate to the WebSocket endpoint using the same session token or Schnorr/Ed25519 signature token used for REST API requests:

1. Client connects to the WebSocket endpoint (`wss://domain/ws`)
2. Client sends an authentication message with their session token or signed challenge
3. Server verifies the token/signature and grants access to hub-scoped events
4. Server pushes real-time events (call notifications, presence updates, etc.) to connected clients

Only authenticated clients can receive events. The server handles all event publishing internally — clients do not publish to the WebSocket.

## 5. Note Encryption (Per-Note Forward Secrecy)

### 5.1 Encryption

Each note uses a fresh random key, ECIES-wrapped for each authorized reader:

```
noteKey = random(32 bytes)
nonce = random(24 bytes)
payload = JSON.stringify({ text, fields })
encryptedContent = nonce || XChaCha20-Poly1305(noteKey, nonce, payload)

authorEnvelope = wrapKeyForPubkey(noteKey, authorPubkey)
adminEnvelope = wrapKeyForPubkey(noteKey, adminPubkey)
```

### 5.2 Key Wrapping (ECIES)

```
wrapKeyForPubkey(plainKey, recipientPubkeyHex):
  ephemeralSecret = random(32 bytes)
  ephemeralPub = secp256k1.getPublicKey(ephemeralSecret, compressed=true)
  recipientCompressed = "02" || recipientPubkeyHex  // x-only → compressed
  shared = secp256k1.getSharedSecret(ephemeralSecret, recipientCompressed)
  sharedX = shared[1..33]  // strip prefix byte
  symmetricKey = SHA-256("llamenos:note-key" || sharedX)
  nonce = random(24 bytes)
  wrappedKey = nonce || XChaCha20-Poly1305(symmetricKey, nonce, plainKey)
  return { encryptedFileKey: hex(wrappedKey), ephemeralPubkey: hex(ephemeralPub) }
```

### 5.3 Decryption

```
decryptNote(encryptedContent, envelope, secretKey):
  noteKey = unwrapKey(envelope, secretKey)
  nonce = encryptedContent[0..24]
  ciphertext = encryptedContent[24..]
  payload = XChaCha20-Poly1305.decrypt(noteKey, nonce, ciphertext)
  return JSON.parse(payload)
```

### 5.4 Legacy Note Decryption

Notes created before per-note keys use a deterministic key:
```
legacyKey = HKDF-SHA256(secretKey, "llamenos:hkdf-salt:v1", "llamenos:notes", 32)
```

Legacy notes are identified by the absence of `authorEnvelope`/`adminEnvelope` fields.

## 6. Message Encryption (Envelope Pattern)

Messages (SMS, WhatsApp, Signal conversations) use per-message envelope encryption (Epic 74), matching the note encryption pattern from Section 5.

### 6.1 Encryption

Each message uses a fresh random key, ECIES-wrapped for each authorized reader:

```
messageKey = random(32 bytes)
nonce = random(24 bytes)
encryptedContent = nonce || XChaCha20-Poly1305(messageKey, nonce, messageText)

// Wrap the message key for each reader
authorEnvelope = wrapKeyForPubkey(messageKey, volunteerPubkey, "llamenos:message")
adminEnvelopes = [
  wrapKeyForPubkey(messageKey, admin1Pubkey, "llamenos:message"),
  wrapKeyForPubkey(messageKey, admin2Pubkey, "llamenos:message"),
  ...  // one envelope per admin
]
```

### 6.2 Key Wrapping (ECIES)

```
wrapKeyForPubkey(plainKey, recipientPubkeyHex, label):
  ephemeralSecret = random(32 bytes)
  ephemeralPub = secp256k1.getPublicKey(ephemeralSecret, compressed=true)
  recipientCompressed = "02" || recipientPubkeyHex  // x-only → compressed
  shared = secp256k1.getSharedSecret(ephemeralSecret, recipientCompressed)
  sharedX = shared[1..33]  // strip prefix byte
  symmetricKey = SHA-256(label || sharedX)
  nonce = random(24 bytes)
  wrappedKey = nonce || XChaCha20-Poly1305(symmetricKey, nonce, plainKey)
  return { encryptedFileKey: hex(wrappedKey), ephemeralPubkey: hex(ephemeralPub) }
```

### 6.3 Inbound Message Flow

For inbound messages (SMS/WhatsApp webhook → server):

1. Server receives plaintext from telephony provider (inherent limitation)
2. Server encrypts immediately using the assigned volunteer's pubkey and all admin pubkeys
3. Server stores ONLY the encrypted fields (`encryptedContent`, `authorEnvelope`, `adminEnvelopes[]`, `nonce`)
4. Server discards the plaintext from memory

### 6.4 Outbound Message Flow

For outbound messages (volunteer → SMS/WhatsApp):

1. Client encrypts the message and creates all envelopes
2. Client sends both `plaintextForSending` (for the provider) and encrypted fields to the server
3. Server forwards the plaintext to the telephony provider (inherent limitation)
4. Server stores ONLY the encrypted fields; discards `plaintextForSending` immediately

**Important**: The server momentarily sees outbound message plaintext — this is an inherent limitation of SMS/WhatsApp channels, not a bug. See [Threat Model: SMS/WhatsApp Outbound Message Limitation](../security/THREAT_MODEL.md#smswhatsapp-outbound-message-limitation).

## 7. File Encryption

Files use a two-layer scheme:

1. **File Key**: Random 32-byte key encrypts the file content
2. **Envelopes**: File key is ECIES-wrapped per recipient (same as Section 5.2)
3. **Metadata**: File metadata (name, type, size, checksum) encrypted separately per recipient

Chunked upload: file is encrypted client-side, split into chunks, uploaded, and reassembled server-side. The server never sees plaintext.

## 8. Draft Encryption

Local drafts use deterministic key derivation (acceptable since drafts are device-local):

```
draftKey = HKDF-SHA256(secretKey, "llamenos:hkdf-salt:v1", "llamenos:drafts", 32)
nonce = random(24 bytes)
encrypted = nonce || XChaCha20-Poly1305(draftKey, nonce, draft_json)
```

Stored in `localStorage` with prefix `llamenos-draft:{callId}`. Cleared on logout.

## 9. Recovery & Backup

### 9.1 Recovery Key

128-bit random value, Base32-encoded, formatted as `XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX`.

The recovery key encrypts the nsec in the backup file:
```
recoveryKEK = PBKDF2-SHA256(Base32(recoveryKey), random_salt_16, 100,000 iterations)
encrypted_nsec = XChaCha20-Poly1305(recoveryKEK, random_nonce_24, nsec_bytes)
```

100,000 iterations (vs 600,000 for PIN) because the recovery key has 128 bits of entropy.

### 9.2 Backup File Format

```json
{
  "version": 1,
  "format": "llamenos-key-backup",
  "pubkey": "<hex pubkey>",
  "createdAt": "<ISO 8601>",
  "encrypted": {
    "salt": "<hex, 16 bytes>",
    "iterations": 600000,
    "nonce": "<hex, 24 bytes>",
    "ciphertext": "<hex>"
  },
  "recoveryKey": {
    "salt": "<hex, 16 bytes>",
    "iterations": 100000,
    "nonce": "<hex, 24 bytes>",
    "ciphertext": "<hex>"
  }
}
```

The `encrypted` section is decryptable with the user's PIN. The `recoveryKey` section is decryptable with the recovery key. Both contain the same nsec.

## 10. Device Linking Protocol

New devices receive the nsec from an already-provisioned device via an ephemeral encrypted channel.

### 10.1 Protocol Flow

```
New Device (N)                         Primary Device (P)
  |                                      |
  |-- 1. Generate ephemeral keypair:     |
  |      eSK, ePK = secp256k1.gen()     |
  |                                      |
  |-- 2. POST /provisioning/room ------->|
  |      Response: { roomId }            |
  |                                      |
  |-- 3. Display QR / alphanumeric:      |
  |      { roomId, ePK_hex }            |
  |                                      |
  |-- 4. Connect WS: /provisioning/ws    |
  |      ?room={roomId}&role=new         |
  |                                      |
  |                                      |-- 5. Scan QR or enter code
  |                                      |
  |                                      |-- 6. Connect WS:
  |                                      |      /provisioning/ws?room={roomId}&role=primary
  |                                      |
  |                                      |-- 7. ECDH(primarySK, ePK) → shared
  |                                      |-- 8. WS send: {
  |                                      |        type: "provision",
  |                                      |        encrypted: XChaCha20(shared, nonce, nsec),
  |                                      |        nonce: hex,
  |                                      |        primaryPK: hex  // for verification
  |                                      |      }
  |                                      |
  |<- 9. Receive provision message -------|
  |                                      |
  |-- 10. ECDH(eSK, primaryPK) → shared  |
  |-- 11. Decrypt nsec                   |
  |-- 12. Verify: getPublicKey(nsec)     |
  |        matches primaryPK             |
  |                                      |
  |-- 13. Prompt for PIN                 |
  |-- 14. storeEncryptedKey(nsec, pin)   |
  |                                      |
  |-- 15. WS send: { type: "ack" }      |
  |                                      |
  |                                      |<- 16. Receive ack, show success
```

### 10.2 Security Properties

- **Ephemeral channel**: The ECDH shared secret is derived from a fresh keypair on the new device, so even if the QR code is photographed, the attacker cannot decrypt without the ephemeral private key.
- **Server-blind**: The provisioning server only sees encrypted bytes — never the nsec.
- **Room TTL**: Provisioning rooms expire after 5 minutes.
- **Verification**: The new device verifies that the decrypted nsec's public key matches the primary device's advertised pubkey.

### 10.3 Fallback

For devices without cameras, the new device displays a short alphanumeric code (derived from `roomId + ePK` truncated) that can be manually entered on the primary device.

## 11. Session Management

### 11.1 WebAuthn Sessions

- Created after successful WebAuthn assertion
- 32-byte random token stored in IdentityDO as `session:{token}`
- 8-hour expiry, enforced server-side
- Single-use challenge: deleted after verification
- Credential counter tracking for clone detection

### 11.2 Session Lifecycle

```
Login → Create session token → Store in sessionStorage
  └── On each API request: Authorization: Session {token}
  └── On logout: POST /auth/me/logout → server deletes session
  └── On expiry: server returns 401 → client shows re-auth prompt
```

### 11.3 Relationship to Key Manager

WebAuthn sessions authenticate the user but do not unlock crypto operations. The Key Manager must be separately unlocked with PIN to decrypt notes, messages, and files. This creates two tiers:

- **Authenticated but locked**: Can see call events, shift status, presence. Cannot read encrypted content.
- **Authenticated and unlocked**: Full access to all encrypted content.

## 12. Cryptographic Library Dependencies

| Library | Version | Usage |
|---------|---------|-------|
| `@noble/curves` | ^1.x | secp256k1 ECDH, BIP-340 Schnorr signatures |
| `@noble/ciphers` | ^1.x | XChaCha20-Poly1305 symmetric encryption |
| `@noble/hashes` | ^1.x | SHA-256, HKDF-SHA256, hex/utf8 encoding |
| `@noble/curves` | ^1.x | secp256k1 ECDH, BIP-340 Schnorr signatures |
| `@noble/ciphers` | ^1.x | XChaCha20-Poly1305 symmetric encryption |
| `@noble/hashes` | ^1.x | SHA-256, HKDF-SHA256, hex/utf8 encoding |
| Web Crypto API | — | PBKDF2 key derivation, random bytes |

All cryptographic operations use audited, constant-time implementations. No custom crypto primitives.

## 13. Threat Model

| Threat | Mitigation |
|--------|-----------|
| XSS stealing nsec | Key Manager holds secretKey in closure, not sessionStorage. Auto-lock on tab hide. |
| Browser extension reading storage | localStorage contains only PIN-encrypted ciphertext. PIN brute-force mitigated by 600k PBKDF2 iterations. |
| Server compromise | Server never sees plaintext notes/messages/files. ECIES ensures server can't decrypt. |
| Device seizure | PIN-encrypted key in localStorage. 6-8 digit PIN + 600k iterations ≈ 10-60 seconds per attempt. |
| Network MITM | HTTPS/WSS. Schnorr tokens expire in 5 minutes. |
| Compromised identity key | Per-note/per-message ephemeral keys provide forward secrecy — compromising the identity key doesn't reveal past content without also obtaining the per-artifact envelopes. |
| Lost device | Recovery key + backup file restores access on new device. Old device's encrypted store is useless without PIN. |

## 14. Hub Event Encryption

### 14.1 Hub Key Distribution

The hub key is a shared 32-byte symmetric key used to encrypt WebSocket events visible to all hub members.

```
hubKey = crypto.getRandomValues(new Uint8Array(32))

// Wrap for each member via ECIES
for each memberPubkey in activeMembers:
  wrappedHubKey = wrapKeyForPubkey(hubKey, memberPubkey, "llamenos:hub-key-wrap")
  // Store wrapped key server-side for distribution
```

The hub key is **random** (not derived from any identity key). This ensures:
- Compromising any identity key does not reveal the hub key
- Key rotation produces a genuinely new key with no mathematical link to the old one

### 14.2 Event Encryption

Each WebSocket event's content is encrypted with a per-event derived key:

```
// Derive per-event encryption key
eventKey = HKDF-SHA256(hubKey, "llamenos:hub-event", eventNonce)

// Encrypt event content
nonce = random(24 bytes)
encryptedContent = XChaCha20-Poly1305(eventKey, nonce, JSON.stringify({
  type: "call:ring",  // Actual event type is INSIDE encrypted content
  callId: "...",
  ...
}))

// Send via WebSocket
{
  hubId: "...",
  encryptedPayload: hex(nonce || encryptedContent),
  serverPubkey: serverPubkey
}
```

### 14.3 Server WebSocket Identity

The server derives its event signing keypair from the `SERVER_SECRET` environment variable:

```
ikm = hex_decode(SERVER_SECRET)
serverSecretKey = HKDF-SHA256(ikm, "llamenos:server-event-key", "llamenos:server-event-key:v1", 32)
serverPubkey = secp256k1.getPublicKey(serverSecretKey)
```

Clients learn the server pubkey during authentication and verify it on all server-signed events. This prevents event injection by unauthorized parties.

### 14.4 Encrypted Metadata (Epic 77)

Call record metadata and shift schedule details are encrypted using their respective domain labels:

```
// Call metadata encryption
callMetaKey = random(32 bytes)
encryptedCallMeta = XChaCha20-Poly1305(callMetaKey, nonce, JSON.stringify({
  answeredBy: volunteerPubkey,
  duration: 300,
  ...
}))
adminEnvelopes = [wrapKeyForPubkey(callMetaKey, adminPubkey, "llamenos:call-meta") for each admin]

// Shift schedule detail encryption
scheduleKey = random(32 bytes)
encryptedSchedule = XChaCha20-Poly1305(scheduleKey, nonce, JSON.stringify({
  label: "Evening Shift",
  description: "...",
  ...
}))
adminEnvelopes = [wrapKeyForPubkey(scheduleKey, adminPubkey, "llamenos:shift-schedule") for each admin]
```

## 15. Audit Log Integrity

Audit logs use a hash-chained integrity mechanism (Epic 77) for tamper detection.

### 15.1 Hash Chain Construction

Each audit entry includes a forward hash link:

```
entryHash = SHA-256(
  action + "|" +
  actorPubkey + "|" +
  timestamp + "|" +
  JSON.stringify(details) + "|" +
  previousEntryHash
)
```

The first entry uses an empty string as `previousEntryHash`.

### 15.2 Verification

An admin can verify chain integrity by iterating from the first entry:

```
computedHash = ""
for each entry in chronological order:
  expectedHash = SHA-256(entry.action + "|" + entry.actorPubkey + "|" + ...)
  if expectedHash !== entry.entryHash:
    TAMPER DETECTED at entry
  computedHash = entry.entryHash
```

### 15.3 Limitations

- Chain truncation from the end leaves a valid shorter chain
- An attacker with full DB access could recompute the entire chain
- For advanced protection, periodically export and sign checkpoints to an external append-only store
