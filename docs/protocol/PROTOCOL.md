# Llamenos Interoperability Protocol Specification

**Version:** 1.1.0
**Status:** Canonical reference for all client implementations
**Audience:** Desktop (Tauri), Mobile (Native Swift/Kotlin), and any third-party client implementors

This document is the definitive wire-format specification for interoperating with the Llamenos server. Every byte layout, algorithm, and endpoint is described with sufficient precision to build a conforming client from scratch. All cryptographic constants, key derivation functions, and wire formats are derived directly from the source-of-truth implementation.

---

## Table of Contents

1. [Authentication Protocol](#1-authentication-protocol)
2. [Cryptographic Operations](#2-cryptographic-operations)
3. [WebSocket Event Schema](#3-WebSocket-event-schema)
4. [REST API Endpoints](#4-rest-api-endpoints)
5. [Push Notification Protocol](#5-push-notification-protocol)
6. [Device Provisioning Protocol](#6-device-provisioning-protocol)
7. [Permission Model](#7-permission-model)
- [Appendix A: Library Dependencies](#appendix-a-library-dependencies-for-implementors)
- [Appendix B: Type Definitions Reference](#appendix-b-type-definitions-reference)
- [Appendix C: Legacy Encryption (pre-v2 ECIES)](#appendix-c-legacy-encryption-pre-v2-ecies)

---

## 1. Authentication Protocol

Llamenos supports two authentication mechanisms. Clients MUST implement signature auth (Schnorr or Ed25519). Session token auth is optional and requires WebAuthn support.

### 1.1 Schnorr Signature Authentication (Legacy)

Every authenticated API request carries a self-signed token proving possession of a private key. The token is bound to the specific HTTP method and path to prevent cross-endpoint replay attacks.

> **Phase 6 Note:** Clients with per-device Ed25519 keys (Section 2.11) use Ed25519 signatures instead of Schnorr. The token construction is identical (same message format and binding), but the signature algorithm differs. The server tries Schnorr verification first, then falls back to Ed25519. New client implementations SHOULD use Ed25519 with the `LABEL_DEVICE_AUTH` prefix (see Section 1.1.1).

#### Token Construction

```
Step 1: Build the message string
  message = "llamenos:auth:" + pubkey_hex + ":" + timestamp_ms + ":" + HTTP_METHOD + ":" + path

  Where:
    pubkey_hex  = 64 hex chars (x-only secp256k1 public key)
    timestamp_ms = Unix epoch in milliseconds (integer)
    HTTP_METHOD  = uppercase string ("GET", "POST", "PATCH", "PUT", "DELETE")
    path         = URL pathname starting with "/" (e.g., "/api/auth/me")

Step 2: Hash the message
  message_hash = SHA-256(UTF-8(message))
  // Result: 32 bytes

Step 3: Sign with BIP-340 Schnorr
  signature = schnorr.sign(message_hash, secret_key)
  // Result: 64 bytes

Step 4: Encode as JSON
  token_json = JSON.stringify({
    "pubkey": pubkey_hex,        // 64-char hex string
    "timestamp": timestamp_ms,   // integer (milliseconds)
    "token": hex(signature)      // 128-char hex string
  })
```

#### HTTP Header Format

```
Authorization: Bearer {"pubkey":"<64_hex>","timestamp":<ms>,"token":"<128_hex>"}
```

The JSON is inlined directly after `Bearer ` (single space). No base64 encoding.

#### Example

```
Authorization: Bearer {"pubkey":"a1b2c3d4e5f6...","timestamp":1709318400000,"token":"deadbeef..."}
```

#### Validation Rules (Server-Side)

1. Parse `Authorization` header, strip `Bearer ` prefix, `JSON.parse()` the remainder.
2. Verify `pubkey`, `timestamp`, and `token` fields are all present and non-empty.
3. Check token freshness: `|now() - timestamp| <= 300,000 ms` (5-minute window, both directions).
4. Reconstruct the message: `"llamenos:auth:" + pubkey + ":" + timestamp + ":" + method + ":" + path`.
5. Compute `SHA-256(UTF-8(message))`.
6. Verify the Schnorr signature: `schnorr.verify(hex_to_bytes(token), message_hash, hex_to_bytes(pubkey))`.
7. Look up the pubkey in the identity store to resolve the user record.

#### 1.1.1 Ed25519 Device Authentication (Phase 6)

For clients using per-device Ed25519 keys (Section 2.11), the auth token uses a different message prefix and Ed25519 signatures:

```
Step 1: Build the message string
  message = "llamenos:device-auth:v1:" + timestamp_ms + ":" + HTTP_METHOD + ":" + path

  Where:
    timestamp_ms = Unix epoch in milliseconds (integer)
    HTTP_METHOD  = uppercase string ("GET", "POST", "PATCH", "PUT", "DELETE")
    path         = URL pathname starting with "/" (e.g., "/api/auth/me")

Step 2: Hash the message
  message_hash = SHA-256(UTF-8(message))

Step 3: Sign with Ed25519
  signature = ed25519.sign(message_hash, device_signing_key)
  // Result: 64 bytes

Step 4: Encode as JSON (same format as Schnorr)
  token_json = JSON.stringify({
    "pubkey": ed25519_pubkey_hex,   // 64-char hex string (32-byte Ed25519 public key)
    "timestamp": timestamp_ms,
    "token": hex(signature)         // 128-char hex string
  })
```

The server validates Ed25519 tokens the same way as Schnorr tokens, resolving the Ed25519 pubkey to a user via the device registry or sigchain.

### 1.2 Session Token Authentication (WebAuthn)

After a successful WebAuthn authentication ceremony, the server issues a random 256-bit session token with an 8-hour expiry. Clients send it on subsequent requests:

```
Authorization: Session <token_hex>
```

Where `token_hex` is a 64-character hex string (32 random bytes).

#### Validation Rules

1. Parse `Authorization` header, strip `Session ` prefix, trim whitespace.
2. Look up the token in the sessions store.
3. Verify the session has not expired (`expiresAt > now()`).
4. Resolve the associated pubkey to the user record.

### 1.3 Authentication Priority

The server checks Session auth first. If the `Authorization` header starts with `Session `, Schnorr auth is not attempted. If the header starts with `Bearer `, Session auth is not attempted.

---

## 2. Cryptographic Operations

All cryptographic operations in Llamenos use domain separation constants to prevent cross-context key reuse attacks. These constants are the canonical source of truth.

### 2.1 Domain Separation Constants

Every HPKE/ECIES derivation, HKDF context, HMAC key, and signature binding uses a unique context string from this list. Clients MUST use these exact strings. Using raw string literals instead of these constants is a protocol violation.

> **Note:** The authoritative source of truth for all domain separation constants is `packages/protocol/crypto-labels.json`. The tables below list the most commonly used labels. Refer to the source file for the complete and current count.

#### Device Authentication

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_DEVICE_AUTH` | `llamenos:device-auth:v1` | Ed25519 device auth token message prefix (Phase 6) |
| `AUTH_PREFIX` | `llamenos:auth:` | Schnorr auth token message prefix (legacy) |

#### HPKE Key Wrapping Labels

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_NOTE_KEY` | `llamenos:note-key` | Per-note symmetric key wrapping (V2 forward secrecy) |
| `LABEL_FILE_KEY` | `llamenos:file-key` | Per-file symmetric key wrapping |
| `LABEL_FILE_METADATA` | `llamenos:file-metadata` | File metadata wrapping |
| `LABEL_HUB_KEY_WRAP` | `llamenos:hub-key-wrap` | Hub key distribution wrapping |

#### Content Encryption Labels

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_TRANSCRIPTION` | `llamenos:transcription` | Server-side transcription encryption |
| `LABEL_MESSAGE` | `llamenos:message` | E2EE message encryption |
| `LABEL_CALL_META` | `llamenos:call-meta` | Encrypted call record metadata |
| `LABEL_SHIFT_SCHEDULE` | `llamenos:shift-schedule` | Encrypted shift schedule details |

#### HKDF Derivation Labels

| Constant | Value | Purpose |
|----------|-------|---------|
| `HKDF_SALT` | `llamenos:hkdf-salt:v1` | Legacy symmetric key derivation salt |
| `HKDF_CONTEXT_NOTES` | `llamenos:notes` | Legacy V1 note encryption context |
| `HKDF_CONTEXT_DRAFTS` | `llamenos:drafts` | Draft encryption context |
| `HKDF_CONTEXT_EXPORT` | `llamenos:export` | Export encryption context |
| `LABEL_HUB_EVENT` | `llamenos:hub-event` | Hub event HKDF derivation from hub key |

#### ECDH Key Agreement

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_DEVICE_PROVISION` | `llamenos:device-provision` | Device provisioning ECDH shared key derivation |

#### SAS Verification

| Constant | Value | Purpose |
|----------|-------|---------|
| `SAS_SALT` | `llamenos:sas` | SAS HKDF salt for provisioning verification |
| `SAS_INFO` | `llamenos:provisioning-sas` | SAS HKDF info parameter |

#### PUK (Per-User Key) Labels

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_PUK_SIGN` | `llamenos:puk:sign:v1` | PUK signing key derivation |
| `LABEL_PUK_DH` | `llamenos:puk:dh:v1` | PUK Diffie-Hellman key derivation |
| `LABEL_PUK_SECRETBOX` | `llamenos:puk:secretbox:v1` | PUK symmetric encryption |
| `LABEL_PUK_WRAP_TO_DEVICE` | `llamenos:puk:wrap:device:v1` | PUK wrapping for device distribution |
| `LABEL_PUK_PREVIOUS_GEN` | `llamenos:puk:prev-gen:v1` | Previous PUK generation chain link |

#### Push Notification Labels

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_PUSH_WAKE` | `llamenos:push-wake` | Push notification wake key encryption |
| `LABEL_PUSH_FULL` | `llamenos:push-full` | Push notification full content encryption |

#### CMS (Case Management) Labels

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_CONTACT_ID` | `llamenos:contact-id` | Contact identifier encryption |
| `LABEL_CONTACT_PROFILE` | `llamenos:contact-profile` | Contact profile data encryption |
| `LABEL_CASE_SUMMARY` | `llamenos:case-summary` | Case summary encryption |
| `LABEL_CASE_FIELDS` | `llamenos:case-fields` | Case custom field encryption |

#### HMAC Domain Separation

| Constant | Value | Purpose |
|----------|-------|---------|
| `HMAC_PHONE_PREFIX` | `llamenos:phone:` | Phone number hashing prefix |
| `HMAC_IP_PREFIX` | `llamenos:ip:` | IP address hashing prefix |
| `HMAC_KEYID_PREFIX` | `llamenos:keyid:` | Key identification hashing prefix |
| `HMAC_SUBSCRIBER` | `llamenos:subscriber` | Subscriber identifier HMAC key |
| `HMAC_PREFERENCE_TOKEN` | `llamenos:preference-token` | Preference token HMAC key |

#### Recovery / Backup

| Constant | Value | Purpose |
|----------|-------|---------|
| `RECOVERY_SALT` | `llamenos:recovery` | Recovery key PBKDF2 fallback salt (legacy) |
| `LABEL_BACKUP` | `llamenos:backup` | Generic backup encryption |

#### Server WebSocket Identity

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_SERVER_NOSTR_KEY` | `llamenos:server-WebSocket-key` | HKDF salt for server WebSocket keypair derivation |
| `LABEL_SERVER_NOSTR_KEY_INFO` | `llamenos:server-WebSocket-key:v1` | HKDF info parameter (versioned for rotation) |

### 2.2 HPKE Envelope Encryption (Current)

HPKE (Hybrid Public Key Encryption, RFC 9180) is the current envelope encryption primitive for wrapping symmetric keys for specific recipients. It replaces the legacy ECIES scheme (Section 2.2.1) for all new encryption operations.

#### Algorithm

```
Suite:     DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM
KEM ID:    0x0020 (X25519)
KDF ID:    0x0001 (HKDF-SHA256)
AEAD ID:   0x0002 (AES-256-GCM)
```

#### Wire Format (v3 Envelope)

```json
{
  "v": 3,
  "labelId": 1,
  "enc": "<base64url — 32-byte HPKE encapsulated key>",
  "ct": "<base64url — AEAD ciphertext>"
}
```

Where:
- `v`: Envelope version (always 3 for HPKE)
- `labelId`: Integer ID mapping to a domain separation label (see `crypto-labels.json`)
- `enc`: The HPKE KEM encapsulated shared secret (32 bytes, base64url-encoded)
- `ct`: The AEAD ciphertext (base64url-encoded)

#### Albrecht Defense (Label Enforcement)

Before decryption, the `labelId` in the envelope MUST match the expected label for the operation context. This prevents ciphertext misuse attacks where an attacker substitutes an envelope from one context into another (e.g., using a note key envelope as a hub key envelope). Mismatched labels MUST cause decryption to fail.

#### Encryption

```
hpkeWrapKey(plaintext_key[32], recipient_x25519_pubkey[32], label_string):

  1. Look up label ID from crypto-labels.json
  2. HPKE.Seal(recipient_x25519_pubkey, plaintext_key, info=label_string)
  3. Return v3 envelope JSON
```

#### Decryption

```
hpkeUnwrapKey(envelope, device_x25519_secret_key[32], expected_label_string):

  1. Verify envelope.v === 3
  2. Verify envelope.labelId matches expected label
  3. HPKE.Open(device_x25519_secret_key, envelope.enc, envelope.ct, info=expected_label_string)
  4. Return plaintext key (32 bytes)
```

### 2.2.1 ECIES Key Wrapping (Legacy)

> **Deprecation Notice:** ECIES is retained for backwards compatibility with existing encrypted data. All new encryption operations SHOULD use HPKE (Section 2.2). ECIES uses secp256k1 ECDH + XChaCha20-Poly1305 while HPKE uses X25519 + AES-256-GCM.

ECIES (Elliptic Curve Integrated Encryption Scheme) is the legacy primitive for encrypting symmetric keys for specific recipients.

#### Algorithm

```
Curve:     secp256k1
AEAD:      XChaCha20-Poly1305

eciesWrapKey(plaintext_key[32], recipient_pubkey_hex[64], label_string):

  1. Generate ephemeral keypair:
     ephemeral_secret = random(32)
     ephemeral_pubkey = secp256k1.getPublicKey(ephemeral_secret, compressed=true)
     // ephemeral_pubkey: 33 bytes (compressed format, 0x02 or 0x03 prefix)

  2. Prepare recipient compressed pubkey:
     // WebSocket pubkeys are x-only (32 bytes / 64 hex chars). Prepend 0x02.
     recipient_compressed = 0x02 || hex_to_bytes(recipient_pubkey_hex)
     // Result: 33 bytes

  3. ECDH shared secret:
     shared = secp256k1.getSharedSecret(ephemeral_secret, recipient_compressed)
     // shared: 33 bytes (compressed point)
     shared_x = shared[1..33]
     // shared_x: 32 bytes (x-coordinate only, strip the 0x02/0x03 prefix byte)

  4. Derive symmetric key (domain-separated):
     label_bytes = UTF-8(label_string)
     key_input = label_bytes || shared_x
     symmetric_key = SHA-256(key_input)
     // symmetric_key: 32 bytes

  5. Encrypt the plaintext key:
     nonce = random(24)
     cipher = XChaCha20-Poly1305(symmetric_key, nonce)
     ciphertext = cipher.encrypt(plaintext_key)
     // ciphertext: 32 + 16 = 48 bytes (32 plaintext + 16 auth tag)

  6. Pack output:
     packed = nonce || ciphertext
     // packed: 24 + 48 = 72 bytes

  7. Return:
     KeyEnvelope {
       wrappedKey:      hex(packed)           // 144 hex chars
       ephemeralPubkey: hex(ephemeral_pubkey)  // 66 hex chars (compressed 33 bytes)
     }
```

#### Byte Layout of `wrappedKey`

```
Offset  Length  Content
------  ------  -------
0       24      XChaCha20-Poly1305 nonce (random)
24      32      Encrypted symmetric key
56      16      Poly1305 authentication tag
------  ------
Total:  72 bytes (144 hex chars)
```

#### Unwrapping

```
eciesUnwrapKey(envelope: KeyEnvelope, secret_key[32], label_string):

  1. Parse ephemeral pubkey:
     ephemeral_pub = hex_to_bytes(envelope.ephemeralPubkey)
     // 33 bytes, already compressed

  2. ECDH shared secret:
     shared = secp256k1.getSharedSecret(secret_key, ephemeral_pub)
     shared_x = shared[1..33]

  3. Derive symmetric key (same as wrapping):
     label_bytes = UTF-8(label_string)
     key_input = label_bytes || shared_x
     symmetric_key = SHA-256(key_input)

  4. Unpack and decrypt:
     data = hex_to_bytes(envelope.wrappedKey)
     nonce = data[0..24]
     ciphertext = data[24..]
     cipher = XChaCha20-Poly1305(symmetric_key, nonce)
     plaintext_key = cipher.decrypt(ciphertext)
     // plaintext_key: 32 bytes
```

#### RecipientKeyEnvelope

When wrapping a key for multiple recipients, each envelope is tagged with the recipient's pubkey:

```typescript
interface RecipientKeyEnvelope {
  pubkey: string           // recipient's x-only pubkey (64 hex chars)
  wrappedKey: string       // 144 hex chars (nonce + ciphertext + tag)
  ephemeralPubkey: string  // 66 hex chars (compressed 33-byte ephemeral pubkey)
}
```

A unique ephemeral keypair is generated per-recipient per-wrap operation. This ensures that compromising one recipient's envelope reveals nothing about other recipients' envelopes.

### 2.3 Per-Note Encryption (V2 Forward Secrecy)

Every note is encrypted with a unique random key, providing forward secrecy. Compromising an identity key does not reveal past notes.

#### Encryption

```
encryptNoteV2(payload: NotePayload, author_x25519_pubkey_hex, admin_x25519_pubkey_hexes[]):

  1. Serialize payload:
     json_string = JSON.stringify(payload)
     // NotePayload = { text: string, fields?: Record<string, string|number|boolean> }

  2. Generate per-note symmetric key:
     note_key = random(32)

  3. Encrypt content with AES-256-GCM:
     iv = random(12)
     ciphertext_with_tag = AES-256-GCM.encrypt(note_key, iv, UTF-8(json_string))
     // ciphertext_with_tag: variable length + 16-byte GCM tag appended
     encrypted_content = hex(iv || ciphertext_with_tag)

  4. Wrap note_key for the author via HPKE:
     author_sealed = HPKE.Seal(
       recipientPk = hex_to_bytes(author_x25519_pubkey_hex),
       plaintext   = note_key,
       info        = UTF-8("llamenos:note-key"),
       aad         = empty
     )
     author_envelope = {
       enc: hex(author_sealed[0..32]),   // 32-byte HPKE encapsulated key → 64 hex chars
       ct:  hex(author_sealed[32..])     // AEAD ciphertext
     }

  5. Wrap note_key for each admin via HPKE:
     admin_envelopes = []
     for each admin_x25519_pubkey_hex in admin_x25519_pubkey_hexes:
       sealed = HPKE.Seal(
         recipientPk = hex_to_bytes(admin_x25519_pubkey_hex),
         plaintext   = note_key,
         info        = UTF-8("llamenos:note-key"),
         aad         = empty
       )
       admin_envelopes.push({
         pubkey: admin_x25519_pubkey_hex,   // 64 hex chars
         enc:    hex(sealed[0..32]),
         ct:     hex(sealed[32..])
       })

  6. Return:
     EncryptedNoteV2 {
       encryptedContent: encrypted_content,   // hex string
       authorEnvelope:   author_envelope,      // KeyEnvelope { enc, ct }
       adminEnvelopes:   admin_envelopes        // RecipientEnvelope[] { pubkey, enc, ct }
     }
```

#### Decryption

```
decryptNoteV2(encrypted_content_hex, envelope: KeyEnvelope, device_x25519_secret_key[32]):

  1. Unwrap the note key via HPKE:
     enc_bytes = hex_to_bytes(envelope.enc)   // 32 bytes
     ct_bytes  = hex_to_bytes(envelope.ct)
     note_key = HPKE.Open(
       recipientSk = device_x25519_secret_key,
       enc         = enc_bytes,
       ciphertext  = ct_bytes,
       info        = UTF-8("llamenos:note-key"),
       aad         = empty
     )
     // note_key: 32 bytes

  2. Decrypt content with AES-256-GCM:
     data = hex_to_bytes(encrypted_content_hex)
     iv   = data[0..12]
     ciphertext_with_tag = data[12..]
     plaintext = AES-256-GCM.decrypt(note_key, iv, ciphertext_with_tag)

  3. Parse JSON:
     json_string = UTF-8_decode(plaintext)
     payload = JSON.parse(json_string) as NotePayload
     // If JSON parse fails or doesn't have .text field:
     // Return { text: json_string }
```

#### Wire Format: `encryptedContent`

```
Offset  Length    Content
------  ------    -------
0       12        AES-256-GCM IV (random, 12 bytes)
12      variable  Ciphertext + GCM tag (UTF-8 JSON payload + 16-byte GCM authentication tag)
```

The entire byte sequence is hex-encoded for transport.

#### Wire Format: Key Envelopes

Author envelope (`authorEnvelope`):
```json
{ "enc": "<hex64 — 32-byte HPKE encapsulated key>", "ct": "<hex — AEAD ciphertext>" }
```

Admin envelope (`adminEnvelopes[i]`):
```json
{ "pubkey": "<hex64>", "enc": "<hex64>", "ct": "<hex>" }
```

### 2.4 Per-Message Encryption

Messages (SMS, WhatsApp, Signal, web reports) use the same envelope pattern as notes but with `LABEL_MESSAGE` for domain separation. A random per-message symmetric key is generated and wrapped for each authorized reader.

#### Encryption

```
encryptMessage(plaintext_string, reader_x25519_pubkey_hexes[]):

  1. Generate per-message symmetric key:
     message_key = random(32)

  2. Encrypt content with AES-256-GCM:
     iv = random(12)
     ciphertext_with_tag = AES-256-GCM.encrypt(
       key     = message_key,
       iv      = iv,
       aad     = UTF-8("llamenos:message"),
       message = UTF-8(plaintext_string)
     )
     encrypted_content = hex(iv || ciphertext_with_tag)

  3. Wrap message_key for each reader via HPKE:
     reader_envelopes = []
     for each reader_x25519_pubkey_hex in reader_x25519_pubkey_hexes:
       sealed = HPKE.Seal(
         recipientPk = hex_to_bytes(reader_x25519_pubkey_hex),
         plaintext   = message_key,
         info        = UTF-8("llamenos:message"),
         aad         = UTF-8("llamenos:message:key-wrap")
       )
       reader_envelopes.push({
         pubkey: reader_x25519_pubkey_hex,   // 64 hex chars
         enc:    hex(sealed[0..32]),
         ct:     hex(sealed[32..])
       })

  4. Return:
     EncryptedMessagePayload {
       encryptedContent: encrypted_content,
       readerEnvelopes:  reader_envelopes     // RecipientEnvelope[] { pubkey, enc, ct }
     }
```

#### Decryption

```
decryptMessage(encrypted_content_hex, reader_envelopes[], device_x25519_secret_key[32], reader_pubkey_hex):

  1. Find matching envelope:
     envelope = reader_envelopes.find(e => e.pubkey === reader_pubkey_hex)
     // Return null if no matching envelope

  2. Unwrap message key via HPKE:
     enc_bytes = hex_to_bytes(envelope.enc)
     ct_bytes  = hex_to_bytes(envelope.ct)
     message_key = HPKE.Open(
       recipientSk = device_x25519_secret_key,
       enc         = enc_bytes,
       ciphertext  = ct_bytes,
       info        = UTF-8("llamenos:message"),
       aad         = UTF-8("llamenos:message:key-wrap")
     )

  3. Decrypt content with AES-256-GCM:
     data = hex_to_bytes(encrypted_content_hex)
     iv   = data[0..12]
     ciphertext_with_tag = data[12..]
     plaintext = AES-256-GCM.decrypt(
       key        = message_key,
       iv         = iv,
       aad        = UTF-8("llamenos:message"),
       ciphertext = ciphertext_with_tag
     )

  4. Return UTF-8 string
```

#### Server-Side Encryption (Inbound Webhooks)

When the server receives an inbound message via a messaging webhook (SMS/WhatsApp/Signal), it encrypts the plaintext immediately using the same envelope pattern:

1. Server generates a random `message_key`.
2. Server encrypts the plaintext with AES-256-GCM (AAD=`UTF-8(LABEL_MESSAGE)`).
3. Server wraps `message_key` for each authorized reader (assigned volunteer + all admins) via HPKE with `LABEL_MESSAGE`. See `apps/worker/lib/crypto.ts` `encryptMessageForStorage()`.
4. Plaintext is discarded from memory. The server cannot read stored messages after this point.

### 2.5 Call Record Metadata Encryption

Active calls remain as plaintext (routing necessity). When a call completes, sensitive metadata is encrypted into an envelope and stored permanently.

#### What Gets Encrypted

```typescript
interface CallRecordMetadata {
  answeredBy: string | null   // Volunteer pubkey
  callerNumber: string        // HMAC-hashed phone number
}
```

#### What Stays in Plaintext

```
callerLast4, startedAt, endedAt, duration, status, hasTranscription,
hasVoicemail, hasRecording, recordingSid
```

#### Algorithm

Same envelope pattern as per-message encryption but using `LABEL_CALL_META` and admin-only recipients:

```
encryptCallRecordForStorage(metadata_object, admin_x25519_pubkey_hexes[]):

  1. record_key = random(32)
  2. iv = random(12)
  3. ciphertext_with_tag = AES-256-GCM.encrypt(
       key     = record_key,
       iv      = iv,
       aad     = UTF-8("llamenos:call-meta"),
       message = UTF-8(JSON.stringify(metadata_object))
     )
  4. encrypted_content = hex(iv || ciphertext_with_tag)
  5. admin_envelopes = admin_x25519_pubkey_hexes.map(pk => {
       sealed = HPKE.Seal(
         recipientPk = hex_to_bytes(pk),
         plaintext   = record_key,
         info        = UTF-8("llamenos:call-meta"),
         aad         = UTF-8("llamenos:call-meta:key-wrap")
       )
       return {
         pubkey: pk,
         enc:    hex(sealed[0..32]),
         ct:     hex(sealed[32..])
       }
     })
  6. Return { encryptedContent, adminEnvelopes }
```

Decryption: `HPKE.Open(device_x25519_secret_key, enc_bytes, ct_bytes, info=UTF-8("llamenos:call-meta"), aad=UTF-8("llamenos:call-meta:key-wrap"))` returns `record_key`. Then AES-256-GCM decrypt using `iv = data[0..12]`, `aad = UTF-8("llamenos:call-meta")`.

### 2.6 Key Storage (PIN-Encrypted)

> **Legacy Model:** This section describes the original nsec-per-user key storage using XChaCha20-Poly1305.
> The current system uses per-device Ed25519/X25519 keypairs stored with AES-256-GCM (Section 2.11).
> Section 2.6 is retained for backward-compatibility reference only.
> New client implementations MUST use the Section 2.11 model.

The user's WebSocket secret key (nsec, bech32-encoded) is encrypted with a user-chosen PIN and stored in the client's local persistent storage (localStorage on web, secure storage on native).

#### Encryption Parameters

```
PIN:          6-8 decimal digits (validated by regex /^\d{6,8}$/)
Salt:         16 random bytes
KDF:          PBKDF2 with SHA-256
Iterations:   600,000
Key length:   256 bits (32 bytes)
AEAD:         XChaCha20-Poly1305
Nonce:        24 random bytes
```

#### Key Derivation

```
Step 1: Import PIN as PBKDF2 key material
  pin_bytes = UTF-8(pin_string)
  key_material = PBKDF2.importKey(pin_bytes)

Step 2: Derive KEK (Key Encryption Key)
  kek = PBKDF2.deriveBits(
    hash = SHA-256,
    salt = salt[16],
    iterations = 600000,
    length = 256 bits
  )
  // kek: 32 bytes
```

#### Encryption

```
storeEncryptedKey(nsec_bech32, pin, pubkey_hex):

  1. salt = random(16)
  2. kek = PBKDF2-SHA256(UTF-8(pin), salt, 600000, 32)
  3. nonce = random(24)
  4. cipher = XChaCha20-Poly1305(kek, nonce)
  5. ciphertext = cipher.encrypt(UTF-8(nsec_bech32))
  6. pubkey_hash = SHA-256(UTF-8("llamenos:keyid:" + pubkey_hex))[0..8]
     // First 8 bytes = 16 hex chars (truncated hash)

  Storage JSON:
  {
    "salt":       hex(salt),          // 32 hex chars
    "iterations": 600000,
    "nonce":      hex(nonce),         // 48 hex chars
    "ciphertext": hex(ciphertext),    // variable length
    "pubkey":     hex(pubkey_hash)    // 16 hex chars (truncated, NOT the actual pubkey)
  }
```

**Security note:** The `pubkey` field stores a truncated SHA-256 hash of the pubkey, NOT the plaintext pubkey. This allows identification of which key is stored without revealing the actual public key to an attacker who gains access to local storage.

#### Decryption

```
decryptStoredKey(pin):

  1. Read JSON from storage
  2. salt = hex_to_bytes(stored.salt)
  3. nonce = hex_to_bytes(stored.nonce)
  4. ciphertext = hex_to_bytes(stored.ciphertext)
  5. kek = PBKDF2-SHA256(UTF-8(pin), salt, 600000, 32)
  6. cipher = XChaCha20-Poly1305(kek, nonce)
  7. plaintext = cipher.decrypt(ciphertext)
     // Throws on wrong PIN (authentication failure)
  8. Return UTF-8_decode(plaintext)
     // Returns nsec bech32 string
```

### 2.7 Hub Key Management

Each hub has a random symmetric key used for hub-wide broadcast encryption. The hub key is NOT derived from any identity key -- it is pure random bytes.

#### Key Generation

```
hub_key = crypto.getRandomValues(new Uint8Array(32))
// 32 random bytes
```

#### Distribution

The hub key is wrapped individually for each hub member using HPKE. Clients compute envelopes and upload them via `PUT /api/hubs/:hubId/key`:

```
wrapHubKeyForMembers(hub_key[32], member_x25519_pubkey_hexes[]):

  envelopes = []
  for each member_x25519_pubkey_hex in member_x25519_pubkey_hexes:
    sealed = HPKE.Seal(
      recipientPk = hex_to_bytes(member_x25519_pubkey_hex),
      plaintext   = hub_key,
      info        = UTF-8("llamenos:hub-key-wrap"),
      aad         = UTF-8("llamenos:hub-key-wrap:key-wrap")
    )
    envelopes.push({
      pubkey: member_x25519_pubkey_hex,   // 64 hex chars
      enc:    hex(sealed[0..32]),
      ct:     hex(sealed[32..])
    })
  return envelopes
```

Members fetch their envelope from `GET /api/hubs/:hubId/key` and unwrap:

```
unwrapHubKey(envelope: RecipientEnvelope, device_x25519_secret_key[32]):
  enc_bytes = hex_to_bytes(envelope.enc)
  ct_bytes  = hex_to_bytes(envelope.ct)
  return HPKE.Open(
    recipientSk = device_x25519_secret_key,
    enc         = enc_bytes,
    ciphertext  = ct_bytes,
    info        = UTF-8("llamenos:hub-key-wrap"),
    aad         = UTF-8("llamenos:hub-key-wrap:key-wrap")
  )
  // Returns hub_key: 32 bytes
```

#### Hub-Wide Encryption / Decryption

```
encryptForHub(plaintext_string, hub_key[32]):
  nonce = random(12)
  cipher = AES-256-GCM(hub_key, nonce)
  ciphertext = cipher.encrypt(UTF-8(plaintext_string))
  return hex(nonce || ciphertext)

decryptFromHub(packed_hex, hub_key[32]):
  data = hex_to_bytes(packed_hex)
  nonce = data[0..12]
  ciphertext = data[12..]
  cipher = AES-256-GCM(hub_key, nonce)
  plaintext = cipher.decrypt(ciphertext)
  return UTF-8_decode(plaintext)
```

#### Key Rotation

On member departure:

1. Generate a new random hub key.
2. Wrap it for all **remaining** members (excluding the departed member).
3. Store new envelopes via `PUT /api/hubs/:hubId/key`.
4. Re-encrypt any hub-scoped data with the new key.
5. Distribute via `GET /api/hubs/:hubId/key`.

### 2.8 WebSocket Event Encryption

> **Note:** "Events" in this section refers to real-time WebSocket messages (call rings, presence updates, settings pushes). This is distinct from the deprecated `/api/events` REST endpoint group (Section 4.32), which was a calendar/scheduling data type now superseded by entity types with `category:"event"` in the Records API.

#### Hub-Wide Broadcasts

Hub-wide events (call rings, presence updates, settings changes) are encrypted with a key derived from the hub key:

```
Step 1: Derive event encryption key
  event_key = HKDF(
    hash = SHA-256,
    ikm  = hub_key,
    salt = empty (zero-length),
    info = UTF-8("llamenos:hub-event"),
    length = 32
  )

Step 2: Encrypt event content
  nonce = random(12)
  cipher = AES-256-GCM(event_key, nonce)
  ciphertext = cipher.encrypt(UTF-8(json_content))
  encrypted = hex(nonce || ciphertext)
```

All hub members who possess the hub key can derive the same event key and decrypt.

#### Targeted Messages (Single Recipient)

For events intended for a single recipient (e.g., direct provisioning messages), use HPKE encryption targeted to the recipient's X25519 pubkey.

### 2.9 Server WebSocket Keypair Derivation

The server derives its event signing keypair deterministically from a 64-hex-char secret (`SERVER_SECRET`):

```
deriveServerKeypair(server_secret_hex):

  secret_bytes = hex_to_bytes(server_secret_hex)  // 32 bytes

  // Use registered domain separation labels (LABEL_SERVER_SIGNING_KEY, LABEL_SERVER_SIGNING_INFO)
  signing_seed = HKDF(
    hash = SHA-256,
    ikm  = secret_bytes,
    salt = UTF-8(LABEL_SERVER_SIGNING_KEY),   // "llamenos:server:signing-key"
    info = UTF-8(LABEL_SERVER_SIGNING_INFO),  // "llamenos:server:signing-info"
    length = 32
  )

  pubkey = Ed25519.pubkeyFromSeed(signing_seed)  // 32-byte Ed25519 public key, hex-encoded

  Return { secretKey: signing_seed, pubkeyHex }
```

See `apps/worker/lib/server-identity.ts` `deriveServerKeypair()` for the implementation.

The server's pubkey is distributed to clients via `GET /api/config` in the `serverWebSocketPubkey` field. Clients verify server-published WebSocket events against this pubkey.

### 2.10 HMAC Operations

#### Phone Number Hashing

```
hashPhone(phone_e164, hmac_secret_hex):
  key = hex_to_bytes(hmac_secret_hex)
  input = UTF-8("llamenos:phone:" + phone_e164)
  return hex(HMAC-SHA256(key, input))
```

#### IP Address Hashing

```
hashIP(ip_string, hmac_secret_hex):
  key = hex_to_bytes(hmac_secret_hex)
  input = UTF-8("llamenos:ip:" + ip_string)
  return hex(HMAC-SHA256(key, input))[0..24]
  // Truncated to 96 bits (24 hex chars)
```

### 2.11 Per-Device Key Storage (Current)

The current key model uses per-device keypairs — replacing the legacy single nsec-per-user scheme (Section 2.6). Each device generates two independent keypairs on first launch:

```
Device Key Generation:
  1. signing_seed = random(32)
     ed25519_signing_key = Ed25519.from_seed(signing_seed)
     ed25519_pubkey = ed25519_signing_key.public_key()
     // Used for: auth tokens, sigchain entries, MLS leaf credentials

  2. encryption_seed = random(32)
     x25519_encryption_key = X25519.from(encryption_seed)
     x25519_pubkey = x25519_encryption_key.public_key()
     // Used for: HPKE decapsulation, PUK envelope decryption
```

Device private keys are stored encrypted with the user's PIN using AES-256-GCM:

```
PIN Encryption (Phase 6):
  KDF:    Argon2id
    Memory:      65,536 KiB (64 MB)
    Iterations:  3
    Parallelism: 4 lanes
    Version:     V0x13 (0x13)
    Output:      32 bytes
  AEAD:   AES-256-GCM (12-byte nonce, 16-byte tag)
```

> **Note on KDF choice:** Argon2id replaces the legacy PBKDF2-SHA256 (600,000 iterations) used in the pre-v2 single-nsec model. Argon2id is a memory-hard KDF that provides strictly superior resistance to PIN brute-force attacks on GPUs and ASICs compared to PBKDF2. The 64 MB memory cost forces attackers to use memory-bounded hardware, while the 3 iterations keep unlock latency low on client devices.

#### Platform Storage

| Platform | Storage | Access Control |
|----------|---------|----------------|
| Desktop (Tauri) | Tauri Stronghold (encrypted vault) | Rust `CryptoState`; keys never enter webview |
| iOS | Keychain Services | `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` |
| Android | EncryptedSharedPreferences | AndroidKeyStore-backed |

#### Device Authorization (Sigchain)

New devices are authorized via an append-only hash-chained sigchain. Each sigchain entry is Ed25519-signed by an existing authorized device and contains the new device's Ed25519 + X25519 public keys. The PUK (Per-User Key) is wrapped for each authorized device via `LABEL_PUK_WRAP_TO_DEVICE`.

Link hashing, signing and verification are implemented once in `packages/crypto` (`sigchain::create_sigchain_link`, `sigchain::verify_sigchain`):

```
entryHash = hex(SHA-256(compact JSON of
  { payload, prevHash, seq, signerDeviceId, signerPubkey, timestamp }
  with object keys sorted by UTF-8 bytes at every level;
  prevHash = null for the first link)))
signature = hex(Ed25519.sign(signing_key, bytes(entryHash)))
```

`verify_sigchain` requires the first link to be `seq = 1`, `prevHash = null`, `payload.type = "user_init"` and self-signed; its signer is the first authorized device. Each later link must be `seq = prev + 1`, chain to the previous `entryHash` and be signed by a device in the authorized set; `device_add` / `device_remove` payloads add / remove `payload.devicePubkey`. Pinned test vectors: `packages/crypto/tests/identity_init.rs`.

Wire payloads (Zod: `packages/protocol/schemas/sigchain.ts`):

| `linkType` | `payload.type` | Payload fields |
|------------|----------------|----------------|
| `genesis` | `user_init` | `deviceId`, `devicePubkey` (Ed25519 hex), `deviceEncryptionPubkey` (X25519 hex) |
| `device_add` | `device_add` | `deviceId`, `devicePubkey`, `deviceEncryptionPubkey` |
| `device_remove` | `device_remove` | `deviceId`, `devicePubkey` |
| `puk_epoch` | `puk_epoch` | `generation` (≥ 1), `signPubkey` (Ed25519 hex, `LABEL_PUK_SIGN`), `dhPubkey` (X25519 hex, `LABEL_PUK_DH`) |
| `key_rotate` | `key_rotate` | — |

#### Identity Initialisation

Every user is created with the same sigchain and PUK state, produced by the device that creates the user (invite onboarding, or admin bootstrap) once the user exists server-side and before the client commits its logged-in session (requests are signed with the device key):

```
1. POST /api/users/:self/sigchain   seq 1, linkType "genesis"
     payload { type: "user_init", deviceId, devicePubkey, deviceEncryptionPubkey }
     signed by the new device (devicePubkey = signerPubkey = the user's pubkey)

2. (pukState, seed, envelope) = puk::create_initial_puk(deviceEncryptionPubkey, deviceId)
     seed: random 32 bytes, kept in CryptoState — never exposed to the UI layer
     envelope: HPKE v3 seal of seed, label LABEL_PUK_WRAP_TO_DEVICE,
               AAD = UTF-8("<LABEL_PUK_WRAP_TO_DEVICE>:<deviceId>")
   POST /api/puk/envelopes { envelopes: [{ deviceId, generation: 1, envelope }] }

3. POST /api/users/:self/sigchain   seq 2, linkType "puk_epoch"
     payload { type: "puk_epoch", generation: 1, signPubkey, dhPubkey }

4. GET /api/users/:self/sigchain → verify_sigchain → must authorise the device
```

The envelope is stored before the chain names the PUK, so a chain never binds a PUK whose seed was lost. Each step is keyed off the server's current chain, so a retry after a partial failure resumes where it stopped. Until step 4 succeeds the client does not proceed. The server accepts the identity-initialisation routes from a session that has not yet registered a passkey (they are self-only).

PUK envelopes are addressed by the **sigchain** `deviceId` (the ID the envelope's AAD binds), not by the push-registry device ID, and the server rejects any address the user's sigchain does not currently authorise.

#### Relationship to WebSocket Identity

WebSocket events are signed by the server's derived event keypair. Clients verify the server signature on all WebSocket events. Device Ed25519 keys handle application-level auth and sigchain. Device X25519 keys handle HPKE encryption. These are NOT derived from the server event key.

### 2.12 Audit Log Hash Chain

Each audit log entry contains a SHA-256 hash linking it to the previous entry, forming a tamper-evident chain:

```
hashAuditEntry(entry):
  content = entry.id + ":" +
            entry.event + ":" +
            entry.actorPubkey + ":" +
            entry.createdAt + ":" +
            JSON.stringify(entry.details) + ":" +
            (entry.previousEntryHash || "")

  return hex(SHA-256(UTF-8(content)))
```

Each entry stores:
- `previousEntryHash`: SHA-256 of the prior entry (empty string for the first entry)
- `entryHash`: SHA-256 of this entry's content

### 2.13 Legacy V1 Note Decryption

V1 notes (pre-forward-secrecy) are encrypted with a key derived from the user's secret key via HKDF. No new V1 notes are created; this exists only for backward compatibility.

```
decryptNote(packed_hex, secret_key[32]):

  1. Derive key:
     salt = UTF-8("llamenos:hkdf-salt:v1")
     key = HKDF(SHA-256, secret_key, salt, UTF-8("llamenos:notes"), 32)

  2. Decrypt:
     data = hex_to_bytes(packed_hex)
     nonce = data[0..24]
     ciphertext = data[24..]
     cipher = XChaCha20-Poly1305(key, nonce)
     plaintext = cipher.decrypt(ciphertext)
     return parse_as_NotePayload(UTF-8_decode(plaintext))
```

### 2.14 Transcription Decryption

> **Legacy Model:** This section describes the original ECIES-based transcription encryption (secp256k1 ECDH + XChaCha20-Poly1305). Retained for decrypting existing transcriptions. New implementations should use HPKE (Section 2.2).

Server-encrypted transcriptions use ECIES with a per-transcription ephemeral key. The server wraps the ciphertext for the answering volunteer's pubkey.

```
decryptTranscription(packed_hex, ephemeral_pubkey_hex, secret_key[32]):

  1. ephemeral_pub = hex_to_bytes(ephemeral_pubkey_hex)
     // Already compressed (33 bytes / 66 hex chars)

  2. shared = secp256k1.getSharedSecret(secret_key, ephemeral_pub)
     shared_x = shared[1..33]

  3. label = UTF-8("llamenos:transcription")
     key_input = label || shared_x
     symmetric_key = SHA-256(key_input)

  4. data = hex_to_bytes(packed_hex)
     nonce = data[0..24]
     ciphertext = data[24..]
     cipher = XChaCha20-Poly1305(symmetric_key, nonce)
     plaintext = cipher.decrypt(ciphertext)

  5. Return UTF-8_decode(plaintext)
```

### 2.15 Draft Encryption

Local draft auto-save uses HKDF-derived keys with `HKDF_CONTEXT_DRAFTS` domain separation:

```
encryptDraft(plaintext_string, secret_key[32]):
  salt = UTF-8("llamenos:hkdf-salt:v1")
  key = HKDF(SHA-256, secret_key, salt, UTF-8("llamenos:drafts"), 32)
  nonce = random(12)
  cipher = AES-256-GCM(key, nonce)
  ciphertext = cipher.encrypt(UTF-8(plaintext_string))
  return hex(nonce || ciphertext)
```

### 2.16 Export Encryption

JSON export blobs are encrypted with an HKDF-derived key:

```
encryptExport(json_string, secret_key[32]):
  salt = UTF-8("llamenos:hkdf-salt:v1")
  key = HKDF(SHA-256, secret_key, salt, UTF-8("llamenos:export"), 32)
  nonce = random(12)
  cipher = AES-256-GCM(key, nonce)
  ciphertext = cipher.encrypt(UTF-8(json_string))
  return nonce || ciphertext   // raw bytes, not hex
```

### 2.17 Encrypted File Uploads

Files are encrypted client-side before upload. The encryption follows the envelope pattern:

1. Generate random 32-byte file key.
2. Encrypt file content with AES-256-GCM (chunked).
3. Encrypt file metadata (original name, MIME type, size, dimensions, duration, plaintext SHA-256 checksum) using `LABEL_FILE_METADATA`.
4. Wrap file key for each recipient using `LABEL_FILE_KEY`.
5. Upload encrypted chunks, envelopes, and metadata to server.

```typescript
interface EncryptedFileMetadata {
  originalName: string
  mimeType: string
  size: number
  dimensions?: { width: number; height: number }
  duration?: number
  checksum: string   // SHA-256 of plaintext for integrity verification
}

interface RecipientEnvelope {
  pubkey: string   // recipient X25519 pubkey (hex)
  enc: string      // HPKE encapsulated key (hex, 64 chars)
  ct: string       // HPKE AEAD ciphertext — wraps the file key (LABEL_FILE_KEY)
}
```

---

## 3. WebSocket Event Schema

Llamenos uses a built-in WebSocket endpoint on the API server for real-time event distribution. All events are server-signed and encrypted with the hub key.

### 3.1 Event Kind Definitions

#### Regular Events (Persisted)

| Kind | Constant | Purpose |
|------|----------|---------|
| 1000 | `KIND_CALL_RING` | Incoming call notification -- triggers volunteer ringing |
| 1001 | `KIND_CALL_UPDATE` | Call state update (answered, completed, etc.) |
| 1002 | `KIND_CALL_VOICEMAIL` | Voicemail received for a call |
| 1010 | `KIND_MESSAGE_NEW` | New conversation message (inbound from external channel) |
| 1011 | `KIND_CONVERSATION_ASSIGNED` | Conversation assignment changed |
| 1020 | `KIND_SHIFT_UPDATE` | Shift schedule changed |
| 1030 | `KIND_SETTINGS_CHANGED` | Settings changed (global or hub-scoped) |

#### Ephemeral Events (Not Persisted, Broadcast Only)

| Kind | Constant | Purpose |
|------|----------|---------|
| 20000 | `KIND_PRESENCE_UPDATE` | Volunteer presence update -- online counts, availability |
| 20001 | `KIND_CALL_SIGNAL` | Call answer/hangup signals -- real-time coordination |

#### Authentication Events

| Type | Constant | Purpose |
|------|----------|---------|
| `auth` | `EVENT_AUTH` | WebSocket authentication |

### 3.2 Event Format

All server-published events follow this structure:

```json
{
  "kind": 1000,
  "created_at": 1709318400,
  "tags": [
    ["d", "global"],
    ["t", "llamenos:event"]
  ],
  "content": "<encrypted_json_string>",
  "id": "<computed_event_id>",
  "pubkey": "<server_WebSocket_pubkey>",
  "sig": "<schnorr_signature>"
}
```

#### Tag Convention

All events include a generic `type` field inside the encrypted payload. This prevents the WebSocket infrastructure from distinguishing between event types (call events, message events, settings events all look the same to the server).

The `["d", "global"]` tag is used for hub-wide broadcasts. Hub-scoped events would use `["d", hub_id]`.

#### Content Encryption

The `content` field is always encrypted:
- **Hub-wide broadcasts**: Encrypted with the hub key (Section 2.8).
- **Targeted messages**: Encrypted via HPKE (Section 2.2) targeted to the recipient's X25519 pubkey.

The plaintext content is a JSON string with a `type` field identifying the event type:

```json
{"type": "call:ring", "callId": "abc123", "callerLast4": "5678"}
{"type": "call:answered", "callId": "abc123", "answeredBy": "pubkey_hex"}
{"type": "call:end", "callId": "abc123"}
{"type": "presence:update", "onlineCount": 5}
{"type": "message:new", "conversationId": "conv123", "channelType": "sms"}
{"type": "message:status", "conversationId": "conv123", "messageId": "msg456", "status": "delivered"}
{"type": "conversation:assigned", "conversationId": "conv123", "assignedTo": "pubkey_hex"}
{"type": "shift:update", "shiftId": "shift123"}
{"type": "settings:changed", "section": "spam"}
{"type": "report:new", "conversationId": "conv123", "category": "harassment"}
```

### 3.3 Server Signing

Events are signed using the server's derived keypair (Section 2.9). Clients verify against the `serverWebSocketPubkey` from `GET /api/config`.

```
signServerEvent(payload, secret_key):
  // Serialize payload deterministically
  message = SHA-256(JSON.stringify(payload))
  // Sign with BIP-340 Schnorr
  signature = schnorr.sign(message, secret_key)
  return { payload, signature: hex(signature), pubkey: serverPubkey }
```

### 3.4 Client Connection

Clients connect to the WebSocket endpoint provided by `GET /api/config`:
- `wsUrl`: WebSocket URL (e.g., `wss://api.example.com/ws` or relative `/ws`)
- If `wsUrl` is null, WebSocket real-time is not configured.

Clients authenticate and then receive events for their subscribed hubs:

```json
{
  "action": "subscribe",
  "hubIds": ["hub-id-1", "hub-id-2"]
}
```

---

## 4. REST API Endpoints

All API endpoints are prefixed with `/api`. Requests and responses use JSON unless otherwise noted. All timestamps are ISO 8601 strings.

### 4.1 Public Endpoints (No Auth)

#### Health Check

```
GET /api/health
Response: { "status": "ok" }
```

#### Configuration

```
GET /api/config
Response: {
  "hotlineName": "Hotline",
  "hotlineNumber": "+1234567890",
  "channels": {
    "voice": true, "sms": false, "whatsapp": false,
    "signal": false, "rcs": false, "reports": true
  },
  "setupCompleted": true,
  "demoMode": false,
  "demoResetSchedule": null,
  "needsBootstrap": false,
  "hubs": [{ "id": "...", "name": "...", "slug": "...", ... }],
  "defaultHubId": "...",
  "serverWebSocketPubkey": "hex_64",
  "WebSocketRelayUrl": "wss://...",
  "apiVersion": "1.0.0",
  "minApiVersion": "0.9.0",
  "sentryDsn"?: "https://..."   // Optional, only if GlitchTip/Sentry is configured
}
```

#### Build Verification

```
GET /api/config/verify
Response: {
  "version": "1.0.0",
  "commit": "abc1234",
  "buildTime": "2024-01-01T00:00:00Z",
  "verificationUrl": "https://github.com/...",
  "trustAnchor": "GitHub Release checksums + SLSA provenance"
}
```

#### IVR Audio (Public -- Twilio Fetches During Calls)

```
GET /api/ivr-audio/:promptType/:language
Response: audio/wav binary
// promptType: [a-z_-]+, language: [a-z]{2,5}(-[A-Z]{2})?
```

#### Messaging Preferences (Token-Validated, No Auth)

```
GET /api/messaging/preferences?token=<hmac_token>
Response: subscriber preference data

PATCH /api/messaging/preferences?token=<hmac_token>
Body: { status?: string, language?: string, ... }
```

### 4.2 Authentication

#### Login

```
POST /api/auth/login
Body: { "pubkey": "hex64", "timestamp": ms, "token": "hex128" }
Response: { "ok": true, "roles": ["role-super-admin"] }
Error: 401 { "error": "Invalid credentials" }
Rate limited: 10 attempts per IP
```

#### Bootstrap (First Admin Registration)

```
POST /api/auth/bootstrap
Body: { "pubkey": "hex64", "timestamp": ms, "token": "hex128" }
Response: { "ok": true, "roles": ["role-super-admin"] }
Error: 403 { "error": "Admin already exists" }
Rate limited: 5 attempts per IP
```

#### Get Current User (Auth Required)

```
GET /api/auth/me
Auth: Bearer or Session
Response: {
  "pubkey": "hex64",
  "roles": ["role-super-admin"],
  "permissions": ["*"],
  "primaryRole": { "id": "role-super-admin", "name": "Super Admin", "slug": "super-admin" } | null,
  "name": "Admin",
  "transcriptionEnabled": true,
  "spokenLanguages": ["en", "es"],
  "uiLanguage": "en",
  "profileCompleted": true,
  "onBreak": false,
  "callPreference": "phone",
  "webauthnRequired": false,
  "webauthnRegistered": true,
  "adminDecryptionPubkey"?: "hex64",    // Optional, present for admins
  "serverEventKeyHex"?: "hex64"         // Optional, server event signing key
}
```

#### Logout

```
POST /api/auth/me/logout
Auth: Bearer or Session
Response: { "ok": true }
// If using Session auth, the token is revoked server-side
```

#### Update Profile

```
PATCH /api/auth/me/profile
Auth: Required
Body: {
  "name"?: string,
  "phone"?: string (E.164),
  "spokenLanguages"?: string[],
  "uiLanguage"?: string,
  "profileCompleted"?: boolean,
  "callPreference"?: "phone" | "browser" | "both"
}
Response: { "ok": true }
```

#### Update Availability

```
PATCH /api/auth/me/availability
Auth: Required
Body: { "onBreak": boolean }
Response: { "ok": true }
```

#### Update Transcription Preference

```
PATCH /api/auth/me/transcription
Auth: Required
Body: { "enabled": boolean }
Response: { "ok": true }
Error: 403 if opt-out is not allowed by admin
```

### 4.3 WebAuthn

#### Login Flow

```
POST /api/webauthn/login/options
Auth: None
Response: { ...publicKeyCredentialRequestOptions, "challengeId": "uuid" }

POST /api/webauthn/login/verify
Auth: None
Body: { "assertion": WebAuthnAssertion, "challengeId": "uuid" }
Response: { "token": "hex64", "pubkey": "hex64" }
// Returns a session token for subsequent requests
```

#### Registration Flow (Auth Required)

```
POST /api/webauthn/register/options
Auth: Required
Body: { "label": "My Phone" }
Response: { ...publicKeyCredentialCreationOptions, "challengeId": "uuid" }

POST /api/webauthn/register/verify
Auth: Required
Body: { "attestation": WebAuthnAttestation, "label": "My Phone", "challengeId": "uuid" }
Response: { "ok": true }
```

#### Credential Management (Auth Required)

```
GET /api/webauthn/credentials
Auth: Required
Response: { "credentials": [{ "id", "label", "backedUp", "createdAt", "lastUsedAt" }] }

DELETE /api/webauthn/credentials/:credId
Auth: Required
Response: { "ok": true }
```

### 4.4 Invites

#### Public (No Auth)

```
GET /api/invites/validate/:code
Response: { "valid": true, "name": "...", "expiresAt": "..." }
Rate limited: 5 attempts per IP

POST /api/invites/redeem
Body: { "code": "...", "pubkey": "hex64", "timestamp": ms, "token": "hex128" }
Response: { "ok": true, "pubkey": "hex64", "roles": [...] }
Rate limited: 5 attempts per IP
```

#### Authenticated (Requires `invites:read`)

```
GET /api/invites
Permission: invites:read
Response: { "invites": InviteCode[] }

POST /api/invites
Permission: invites:create
Body: { "name": string, "phone": string (E.164), "roleIds": string[] }
Response: { "code": "...", ... }

DELETE /api/invites/:code
Permission: invites:revoke
Response: { "ok": true }
```

### 4.5 Users

All user endpoints require `users:read` baseline permission.

> **Canonical Path:** `/api/users/` is the canonical path for user management. `/api/volunteers/` is maintained as an alias for backward compatibility and resolves to the same handlers.

```
GET /api/users
Permission: users:read
Response: { "users": User[] }

POST /api/users
Permission: users:create
Body: { "name": string, "phone": string, "roleIds": string[], "pubkey": string }
Response: User

PATCH /api/users/:targetPubkey
Permission: users:update
Body: { "name"?, "phone"?, "roles"?, "active"?, ... }
Response: User

DELETE /api/users/:targetPubkey
Permission: users:delete
Response: { "ok": true }

GET /api/users/:targetPubkey/cases
Permission: users:read-cases
Response: { "cases": Record[] }

GET /api/users/:targetPubkey/metrics
Permission: users:read-metrics
Response: WorkloadMetrics

GET /api/users/:targetPubkey/sigchain
Permission: users:manage-devices (read) or own sigchain
Response: { "entries": SigchainEntry[] }

POST /api/users/:targetPubkey/sigchain
Permission: users:manage-devices
Body: { "signature": hex, "payload": SigchainPayload }
Response: SigchainEntry
```

Hub-scoped variants:
```
GET /api/hubs/:hubId/users
PATCH /api/hubs/:hubId/users/:targetPubkey
```

### 4.6 Shifts

```
GET /api/shifts/my-status
Auth: Required (any role)
Response: { "onShift": boolean, ... }

GET /api/shifts
Permission: shifts:read
Response: { "shifts": Shift[] }

POST /api/shifts
Permission: shifts:create
Body: { "name", "startTime", "endTime", "days": number[], "volunteerPubkeys": string[] }
Response: Shift

PATCH /api/shifts/:id
Permission: shifts:update
Body: partial Shift
Response: Shift

DELETE /api/shifts/:id
Permission: shifts:delete
Response: { "ok": true }

GET /api/shifts/fallback
Permission: shifts:manage-fallback
Response: { "fallbackPubkeys": string[] }

PUT /api/shifts/fallback
Permission: shifts:manage-fallback
Body: { "fallbackPubkeys": string[] }
Response: { "ok": true }
```

Hub-scoped: All shift endpoints are also available at `/api/hubs/:hubId/shifts/*`.

### 4.7 Notes

All note endpoints require `notes:read-own` baseline. Clients must encrypt notes before sending (Section 2.3).

```
GET /api/notes?callId=...&page=1&limit=50
Permission: notes:read-own (own only) or notes:read-all (all notes)
Response: { "notes": EncryptedNote[], "total": number }

POST /api/notes
Permission: notes:create
Body: {
  "callId": string,
  "encryptedContent": hex,
  "authorEnvelope"?: { "enc": hex64, "ct": hex },         // KeyEnvelope (HPKE; no pubkey field)
  "adminEnvelopes"?: { "pubkey": hex64, "enc": hex64, "ct": hex }[]  // RecipientEnvelope[]
}
Response: EncryptedNote

PATCH /api/notes/:id
Permission: notes:update-own
Body: {
  "encryptedContent": hex,
  "authorEnvelope"?: { "enc": hex64, "ct": hex },         // KeyEnvelope (HPKE; no pubkey field)
  "adminEnvelopes"?: { "pubkey": hex64, "enc": hex64, "ct": hex }[]  // RecipientEnvelope[]
}
Response: EncryptedNote
```

Hub-scoped: `/api/hubs/:hubId/notes/*`

### 4.8 Calls

```
GET /api/calls/active
Permission: calls:read-active (redacted caller info) or calls:read-active-full
Response: { "calls": CallRecord[] }

GET /api/calls/today-count
Permission: calls:read-active
Response: { "count": number }

GET /api/calls/presence
Permission: calls:read-presence
Response: { "volunteers": [...] }

GET /api/calls/history?page=1&limit=50&search=&dateFrom=&dateTo=
Permission: calls:read-history
Response: { "calls": EncryptedCallRecord[], "total": number }

POST /api/calls/:callId/answer
Permission: calls:answer
Response: { "call": CallRecord }
Error: 409 "Call already answered"

POST /api/calls/:callId/hangup
Permission: calls:hangup
Response: { "call": CallRecord }
Error: 403 "Not your call", 404 "Call not found"

POST /api/calls/:callId/spam
Permission: calls:report-spam
Response: { ...spamResult }
Error: 403 "Not your call", 404 "Call not found"

GET /api/calls/:callId/recording
Permission: calls:read-recording or answering volunteer
Response: audio/wav binary
Headers: Content-Type: audio/wav, Cache-Control: private, no-store

GET /api/calls/debug
Permission: calls:debug
Response: internal call state
```

Hub-scoped: `/api/hubs/:hubId/calls/*`

### 4.9 Conversations

```
GET /api/conversations?status=&channel=&page=1&limit=50
Permission: conversations:read-all (all) or conversations:read-assigned (own + waiting)
Response: {
  "conversations": Conversation[],
  "total"?: number,
  "assignedCount"?: number,
  "waitingCount"?: number,
  "claimableChannels"?: string[]
}

GET /api/conversations/stats
Auth: Required
Response: { "total": number, "active": number, "waiting": number, "closed": number }

GET /api/conversations/load
Permission: conversations:read-all
Response: { "loads": { [pubkey: string]: number } }

GET /api/conversations/:id
Auth: Required (access-checked per conversation)
Response: Conversation

GET /api/conversations/:id/messages?page=1&limit=50
Auth: Required (access-checked per conversation)
Response: { "messages": EncryptedMessage[], "total": number }

POST /api/conversations/:id/messages
Permission: conversations:send or conversations:send-any
Body: {
  "encryptedContent": hex,
  "readerEnvelopes": MessageKeyEnvelope[],
  "plaintextForSending"?: string  // For external channels; server sends via adapter then discards
}
Response: EncryptedMessage

PATCH /api/conversations/:id
Permission: conversations:update or assigned volunteer
Body: { "status"?: string, "assignedTo"?: string }
Response: Conversation

POST /api/conversations/:id/claim
Permission: conversations:claim + channel-specific (e.g., conversations:claim-sms)
Response: Conversation
Error: 403 "No permission to claim this channel type"
```

Hub-scoped: `/api/hubs/:hubId/conversations/*`

### 4.10 Reports

Reports are a specialized type of conversation with `metadata.type = "report"`.

```
GET /api/reports?status=&category=&page=1&limit=50
Permission: reports:read-all, reports:read-assigned, or reports:read-own
Response: { "conversations": Conversation[], "total": number }

POST /api/reports
Permission: reports:create
Body: {
  "title": string,
  "category"?: string,
  "encryptedContent": hex,
  "readerEnvelopes": MessageKeyEnvelope[]
}
Response: { "id": string, ... }

GET /api/reports/:id
Permission: reports:read-all, reports:read-assigned (if assigned), or own report
Response: Conversation (with metadata.type = "report")

GET /api/reports/:id/messages?page=1&limit=100
Auth: Required (access-checked)
Response: { "messages": EncryptedMessage[], "total": number }

POST /api/reports/:id/messages
Permission: reports:send-message, reports:send-message-own (own report), or assigned
Body: {
  "encryptedContent": hex,
  "readerEnvelopes": MessageKeyEnvelope[],
  "attachmentIds"?: string[]
}
Response: EncryptedMessage

POST /api/reports/:id/assign
Permission: reports:assign
Body: { "assignedTo": "pubkey_hex" }
Response: Conversation

PATCH /api/reports/:id
Permission: reports:update
Body: { "status"?: string }
Response: Conversation

GET /api/reports/categories
Auth: Required
Response: { "categories": string[] }

GET /api/reports/:id/files
Auth: Required (access-checked)
Response: { "files": FileRecord[] }
```

Hub-scoped: `/api/hubs/:hubId/reports/*`

### 4.11 Bans

```
POST /api/bans
Permission: bans:report
Body: { "phone": string (E.164), "reason": string }
Response: BanEntry

GET /api/bans
Permission: bans:read
Response: { "bans": BanEntry[] }

POST /api/bans/bulk
Permission: bans:bulk-create
Body: { "phones": string[] (E.164), "reason": string }
Response: { "ok": true, "count": number }

DELETE /api/bans/:phone
Permission: bans:delete
Response: { "ok": true }
// :phone is URL-encoded E.164 (e.g., %2B12125551234)
```

Hub-scoped: `/api/hubs/:hubId/bans/*`

### 4.12 Settings

#### Telephony Provider

```
GET /api/settings/telephony-provider
Permission: settings:manage-telephony
Response: TelephonyProviderConfig | null

PATCH /api/settings/telephony-provider
Permission: settings:manage-telephony
Body: TelephonyProviderConfig
Response: { "ok": true }

POST /api/settings/telephony-provider/test
Permission: settings:manage-telephony
Body: { "type": "twilio"|"signalwire"|..., ...provider_credentials }
Response: { "ok": true } or { "ok": false, "error": "..." }
```

#### Messaging

```
GET /api/settings/messaging
Permission: settings:manage-messaging
Response: MessagingConfig

PATCH /api/settings/messaging
Permission: settings:manage-messaging
Body: partial MessagingConfig
Response: { "ok": true }
```

#### Spam Mitigation

```
GET /api/settings/spam
Permission: settings:manage-spam
Response: SpamSettings

PATCH /api/settings/spam
Permission: settings:manage-spam
Body: partial SpamSettings
Response: { "ok": true }
```

#### Call Settings

```
GET /api/settings/call
Permission: settings:manage
Response: CallSettings

PATCH /api/settings/call
Permission: settings:manage
Body: partial CallSettings
Response: { "ok": true }
```

#### IVR Languages

```
GET /api/settings/ivr-languages
Permission: settings:manage-ivr
Response: { "enabledLanguages": string[] }

PATCH /api/settings/ivr-languages
Permission: settings:manage-ivr
Body: { "enabledLanguages": string[] }
Response: { "ok": true }
```

#### IVR Audio

```
GET /api/settings/ivr-audio
Permission: settings:manage-ivr
Response: { "audios": [...] }

PUT /api/settings/ivr-audio/:promptType/:language
Permission: settings:manage-ivr
Content-Type: application/octet-stream (raw audio bytes)
Response: { "ok": true }

DELETE /api/settings/ivr-audio/:promptType/:language
Permission: settings:manage-ivr
Response: { "ok": true }
```

#### Transcription

```
GET /api/settings/transcription
Auth: Required (any role)
Response: { "globalEnabled": boolean, "allowVolunteerOptOut": boolean, ... }

PATCH /api/settings/transcription
Permission: settings:manage-transcription
Body: partial transcription settings
Response: { "ok": true }
```

#### Custom Fields

```
GET /api/settings/custom-fields
Auth: Required (returns filtered by role)
Response: { "fields": CustomFieldDefinition[] }

PUT /api/settings/custom-fields
Permission: settings:manage-fields
Body: { "fields": CustomFieldDefinition[] }
Response: { "ok": true }
```

#### WebAuthn Settings

```
GET /api/settings/webauthn
Permission: settings:manage
Response: { "requireForAdmins": boolean, "requireForVolunteers": boolean }

PATCH /api/settings/webauthn
Permission: settings:manage
Body: { "requireForAdmins"?: boolean, "requireForVolunteers"?: boolean }
Response: { "ok": true }
```

#### Roles (PBAC)

```
GET /api/settings/roles
Auth: Required
Response: { "roles": Role[] }

POST /api/settings/roles
Permission: system:manage-roles
Body: { "name": string, "slug": string, "permissions": string[], "description": string }
Response: Role

PATCH /api/settings/roles/:id
Permission: system:manage-roles
Body: partial Role
Response: Role

DELETE /api/settings/roles/:id
Permission: system:manage-roles
Response: { "ok": true }
```

#### Permissions Catalog

```
GET /api/settings/permissions
Permission: system:manage-roles
Response: {
  "permissions": { [key: string]: string },
  "byDomain": { [domain: string]: [{ "key": string, "label": string }] }
}
```

#### Setup State

```
GET /api/settings/setup
Permission: settings:manage
Response: SetupState

PATCH /api/settings/setup
Permission: settings:manage
Body: partial SetupState
Response: SetupState
```

### 4.13 Files

#### Upload Flow

```
POST /api/uploads/init
Permission: files:upload
Body: {
  "totalSize": number,
  "totalChunks": number,
  "conversationId": string,
  "recipientEnvelopes": RecipientEnvelope[],
  "encryptedMetadata": [{ "pubkey": hex64, "encryptedContent": hex, "enc": hex64, "ct": hex }]
  // encryptedMetadata entries use encryptedMetadataEntrySchema — HPKE envelope fields
}
Response: { "uploadId": "uuid", "totalChunks": number }

PUT /api/uploads/:id/chunks/:chunkIndex
Permission: files:upload
Content-Type: application/octet-stream (raw encrypted chunk bytes)
Response: { "chunkIndex": number, "completedChunks": number, "totalChunks": number }

POST /api/uploads/:id/complete
Permission: files:upload
Response: { "fileId": "uuid", "status": "complete" }
Error: 400 "Not all chunks uploaded"

GET /api/uploads/:id/status
Permission: files:upload
Response: {
  "uploadId": string, "status": "uploading"|"complete"|"failed",
  "completedChunks": number, "totalChunks": number, "totalSize": number
}
```

#### File Download

```
GET /api/files/:id/content
Permission: files:download-own (if recipient) or files:download-all
Response: application/octet-stream (encrypted file bytes)
Headers: Cache-Control: private, no-cache

GET /api/files/:id/envelopes
Permission: files:download-own or files:download-all
Response: { "envelopes": RecipientEnvelope[] }
// Non-admin users receive only their own envelope

GET /api/files/:id/metadata
Permission: files:download-own or files:download-all
Response: { "metadata": [{ "pubkey", "encryptedContent", "enc", "ct" }] }
// encryptedMetadataEntrySchema — HPKE envelope fields

POST /api/files/:id/share
Permission: files:share
Body: {
  "envelope": RecipientEnvelope,
  "encryptedMetadata": { "pubkey", "encryptedContent", "enc", "ct" }
  // encryptedMetadataEntrySchema — HPKE envelope fields
}
Response: { "ok": true }
```

### 4.14 Blasts (Message Broadcasting)

#### Subscribers

```
GET /api/blasts/subscribers?page=&limit=&tag=&status=
Auth: Required
Response: { "subscribers": Subscriber[], "total": number }

DELETE /api/blasts/subscribers/:id
Auth: Required
Response: { "ok": true }

GET /api/blasts/subscribers/stats
Auth: Required
Response: { "total": number, "active": number, ... }

POST /api/blasts/subscribers/import
Auth: Required
Body: { "subscribers": [...] }
Response: { "imported": number, ... }
```

#### Blasts

```
GET /api/blasts
Auth: Required
Response: { "blasts": Blast[] }

POST /api/blasts
Auth: Required
Body: { "name", "content": BlastContent, "targetChannels", "targetTags", "targetLanguages" }
Response: Blast

GET /api/blasts/:id
Auth: Required
Response: Blast

PATCH /api/blasts/:id
Auth: Required
Body: partial Blast
Response: Blast

DELETE /api/blasts/:id
Auth: Required
Response: { "ok": true }

POST /api/blasts/:id/send
Auth: Required
Response: { "ok": true, "stats": BlastStats }

POST /api/blasts/:id/schedule
Auth: Required
Body: { "scheduledAt": ISO8601 }
Response: { "ok": true }

POST /api/blasts/:id/cancel
Auth: Required
Response: { "ok": true }
```

#### Blast Settings

```
GET /api/blasts/settings
Auth: Required
Response: BlastSettings

PATCH /api/blasts/settings
Auth: Required
Body: partial BlastSettings
Response: { "ok": true }
```

Hub-scoped: `/api/hubs/:hubId/blasts/*`

### 4.15 Hubs

```
GET /api/hubs
Auth: Required (filtered by membership; super admin sees all)
Response: { "hubs": Hub[] }

POST /api/hubs
Permission: system:manage-hubs
Body: { "name": string, "slug"?: string, "description"?: string, "phoneNumber"?: string }
Response: { "hub": Hub }

GET /api/hubs/:hubId
Auth: Required (membership checked)
Response: { "hub": Hub }

PATCH /api/hubs/:hubId
Permission: system:manage-hubs
Body: partial Hub
Response: Hub

POST /api/hubs/:hubId/members
Permission: users:manage-roles
Body: { "pubkey": hex64, "roleIds": string[] }
Response: { "ok": true }

DELETE /api/hubs/:hubId/members/:pubkey
Permission: users:manage-roles
Response: { "ok": true }

GET /api/hubs/:hubId/key
Auth: Required (hub member)
Response: { "envelope": RecipientKeyEnvelope }
// Returns only the requesting user's envelope

PUT /api/hubs/:hubId/key
Permission: system:manage-hubs
Body: { "envelopes": RecipientKeyEnvelope[] }
Response: { "ok": true }
```

### 4.16 Setup Wizard

```
GET /api/setup/state
Auth: Required
Response: SetupState

PATCH /api/setup/state
Permission: settings:manage
Body: partial SetupState
Response: SetupState

POST /api/setup/complete
Permission: settings:manage
Body: { "demoMode"?: boolean }
Response: SetupState
// Also creates a default hub if none exists

POST /api/setup/test/signal
Permission: settings:manage-messaging
Body: { "bridgeUrl": string, "bridgeApiKey": string }
Response: { "ok": true } or { "ok": false, "error": "..." }

POST /api/setup/test/whatsapp
Permission: settings:manage-messaging
Body: { "phoneNumberId": string, "accessToken": string }
Response: { "ok": true } or { "ok": false, "error": "..." }
```

### 4.17 Audit Log

```
GET /api/audit?page=1&limit=50&actorPubkey=&eventType=&dateFrom=&dateTo=&search=
Permission: audit:read
Response: {
  "entries": AuditLogEntry[],
  "total": number
}
```

Hub-scoped: `/api/hubs/:hubId/audit/*`

### 4.18 WebRTC

```
GET /api/telephony/webrtc-token
Auth: Required
Response: { "token": string, "provider": string, "identity": string }
Error: 400 "Call preference is set to phone only"

GET /api/telephony/webrtc-status
Auth: Required
Response: { "available": boolean, "provider": "twilio"|"signalwire"|null }
```

### 4.19 Device Provisioning

```
POST /api/provision/rooms
Auth: None (new device has no auth)
Body: { "ephemeralPubkey": hex66 }
Response: { "roomId": "uuid", "token": "random_string" }

GET /api/provision/rooms/:id?token=<token>
Auth: None
Response: {
  "status": "waiting" | "ready" | "expired",
  "encryptedNsec"?: hex,
  "primaryPubkey"?: hex64,
  "ephemeralPubkey"?: hex66
}

POST /api/provision/rooms/:id/payload
Auth: Required (primary device must be authenticated)
Body: {
  "token": string,
  "encryptedNsec": hex,
  "primaryPubkey": hex64
}
Response: { "ok": true }
```

### 4.20 Telephony Webhooks

These endpoints are called by telephony providers (Twilio, SignalWire, etc.), not by clients. Each request is validated by the provider's webhook signature, not Llamenos auth. Hub routing is via `?hub=<hubId>` query parameter.

```
POST /api/telephony/incoming
POST /api/telephony/language-selected
POST /api/telephony/captcha
POST /api/telephony/volunteer-answer
POST /api/telephony/call-status
POST /api/telephony/wait-music  (also GET)
POST /api/telephony/queue-exit
POST /api/telephony/voicemail-complete
POST /api/telephony/call-recording
POST /api/telephony/voicemail-recording
```

### 4.21 Messaging Webhooks

These endpoints are called by messaging providers. Each adapter validates its own webhook signature.

```
GET  /api/messaging/whatsapp/webhook    (Meta webhook verification)
GET  /api/messaging/rcs/webhook         (Google RBM webhook verification)
POST /api/messaging/:channel/webhook?hub=<hubId>
// channel: sms | whatsapp | signal | rcs
```

### 4.22 Development / Test (Development Environment Only)

```
POST /api/test-reset            (full reset, requires X-Test-Secret header)
POST /api/test-reset-no-admin   (reset without admin)
POST /api/test-reset-records    (light reset, preserves identity/settings)
```

### 4.23 Health Probes

Kubernetes health probes. No auth required.

```
GET /api/health
Response: { "status": "ok" | "degraded", "checks": { postgres, storage, relay, sipBridge }, "version": string }

GET /api/health/live
Response: { "status": "ok", "eventLoopLagMs": number, "heapUsedMb": number }

GET /api/health/ready
Response: { "status": "ok" | "degraded", "checks": { postgres, storage, relay, sipBridge }, "version": string }
```

### 4.24 Devices

Device registration and push token management. All routes require auth.

```
GET    /api/devices
Auth: Required
Response: { "devices": DeviceDetail[] }

POST   /api/devices/register
Auth: Required
Body: { "platform": "ios"|"android", "pushToken": string, "wakeKeyPublic": hex66, "ed25519Pubkey"?: hex64, "x25519Pubkey"?: hex64, "deviceName"?: string, "deviceModel"?: string, "osVersion"?: string, "appVersion"?: string }
Response: 204 No Content
Rate limit: strict (5/hour)

POST   /api/devices/voip-token
Auth: Required
Body: { "platform": "ios"|"android", "voipToken": string }
Response: 204 No Content

DELETE /api/devices/voip-token
Auth: Required
Response: 204 No Content

PATCH  /api/devices/:id
Auth: Required
Body: { "deviceName": string }
Response: { "id": string, "deviceName": string }

POST   /api/devices/:id/revoke
Auth: Required
Body: { "confirm": true, "signature"?: hex128, "sigchainHash"?: hex64, "sigchainSeqNo"?: number, "sigchainPrevHash"?: hex64 }
Response: { "revoked": true, "deviceId": string, "hubIdsRequiringKeyRotation": string[], "pukRotationNeeded": boolean }
Rate limit: strict (3/hour)

POST   /api/devices/:id/verify
Permission: users:manage-devices
Body: { "signedAuditEntry": hex }
Response: { "verified": true, "verificationId": string }

DELETE /api/devices/:id
Auth: Required
Response: 204 No Content

DELETE /api/devices
Auth: Required
Response: 204 No Content
```

### 4.25 Sessions

Session management. All routes require auth.

```
GET    /api/sessions
Auth: Required
Response: { "sessions": SessionInfo[] }

POST   /api/sessions/terminate-others
Auth: Required
Response: { "terminated": number }
Rate limit: write (10/hour)

DELETE /api/sessions/:id
Auth: Required
Response: 204 No Content
Rate limit: write (10/hour)
```

### 4.26 Security Events

Security event logging for device and session lifecycle.

```
GET /api/security-events
Auth: Required (own events only)
Query: ?limit=&offset=
Response: { "events": SecurityEvent[], "total": number }

GET /api/admin/security-events
Permission: audit:read
Query: ?limit=&offset=
Response: { "events": SecurityEvent[], "total": number }
```

### 4.27 Account

Emergency account lockdown and recovery reporting.

```
POST /api/account/lockdown
Auth: Required (fresh auth — session token not accepted)
Response: { "sessionsTerminated": number, "hubIds": string[] }

POST /api/account/lockdown/complete
Auth: Required
Body: { "pukRotated": boolean, "hubKeysRotated": string[], "hubKeysFailed": string[] }
Response: { "ok": true }
```

### 4.28 Admin Devices

Admin device oversight.

```
GET /api/admin/devices/overview
Permission: users:manage-devices
Query: ?hubId=&limit=&offset=
Response: AdminDeviceOverview
```

### 4.29 Contacts (Legacy)

Legacy contact timeline aggregation. Hub-scoped.

```
GET /api/contacts
Permission: contacts:view
Query: ?page=&limit=
Response: { "contacts": ContactTimeline[], "total": number }

GET /api/contacts/:hash
Permission: contacts:view
Response: { "notes": EncryptedNote[], "conversations": Conversation[] }
```

Hub-scoped: `/api/hubs/:hubId/contacts/*`

### 4.30 Contact Directory (v2)

E2EE contact directory with affinity groups and relationships. Mounted at `/api/directory`. Hub-scoped only.

```
GET    /api/hubs/:hubId/directory
Permission: contacts:view
Query: ?page=&limit=&contactTypeHash=
Response: { "contacts": Contact[], "total": number }

GET    /api/hubs/:hubId/directory/lookup/:identifierHash
Permission: contacts:view
Response: { "contact": Contact | null }

GET    /api/hubs/:hubId/directory/search?tokens=<comma-separated>
Permission: contacts:view
Response: { "contacts": Contact[] }

POST   /api/hubs/:hubId/directory
Permission: contacts:create
Body: CreateContactBody
Response: Contact (201)

GET    /api/hubs/:hubId/directory/:id
Permission: contacts:view
Response: Contact

PATCH  /api/hubs/:hubId/directory/:id
Permission: contacts:edit
Body: UpdateContactBody
Response: Contact

DELETE /api/hubs/:hubId/directory/:id
Permission: contacts:delete
Response: { "ok": true }

POST   /api/hubs/:hubId/directory/:id/relationships
Permission: contacts:manage-relationships
Body: { "contactIdB": string, "relationshipType": string, "encryptedMetadata"?: hex }
Response: ContactRelationship (201)

DELETE /api/hubs/:hubId/directory/:id/relationships/:relId
Permission: contacts:manage-relationships
Response: { "ok": true }

GET    /api/hubs/:hubId/directory/:id/relationships
Permission: contacts:view
Response: { "relationships": ContactRelationship[] }

GET    /api/hubs/:hubId/directory/:id/groups
Permission: contacts:view
Response: { "groups": AffinityGroup[] }

POST   /api/hubs/:hubId/directory/merge
Permission: contacts:edit
Body: { "primaryId": string, "secondaryId": string, "reEncryptedProfiles": {...} }
Response: { "primaryId": string, "secondaryId": string }

POST   /api/hubs/:hubId/directory/bulk
Permission: contacts:edit
Body: BulkContactActionBody
Response: { "affected": number }

POST   /api/hubs/:hubId/directory/bulk-create
Permission: contacts:create
Body: { "contacts": CreateContactBody[] }
Response: { "created": number } (201)

// Affinity Groups
GET    /api/hubs/:hubId/directory/groups
Permission: contacts:manage-groups
Response: { "groups": AffinityGroup[] }

POST   /api/hubs/:hubId/directory/groups
Permission: contacts:manage-groups
Body: { "encryptedName": hex, "members": [{ "contactId": string, "role"?: string }] }
Response: AffinityGroup (201)

GET    /api/hubs/:hubId/directory/groups/:groupId
Permission: contacts:view
Response: { ...AffinityGroup, "members": GroupMember[] }

PATCH  /api/hubs/:hubId/directory/groups/:groupId
Permission: contacts:manage-groups
Body: { "encryptedName"?: hex }
Response: AffinityGroup

DELETE /api/hubs/:hubId/directory/groups/:groupId
Permission: contacts:manage-groups
Response: { "ok": true }

POST   /api/hubs/:hubId/directory/groups/:groupId/members
Permission: contacts:manage-groups
Body: { "contactId": string, "role"?: string }
Response: GroupMember (201)

DELETE /api/hubs/:hubId/directory/groups/:groupId/members/:contactId
Permission: contacts:manage-groups
Response: { "ok": true }

GET    /api/hubs/:hubId/directory/groups/:groupId/members
Permission: contacts:view
Response: { "members": GroupMember[] }
```

### 4.31 Records

Case/entity record management (replaces legacy event system). Hub-scoped and global.

```
GET    /api/records
Permission: cases:read-own | cases:read-assigned | cases:read-all
Query: ?page=&limit=&entityTypeId=&parentRecordId=&assignedTo=&crossHub=&blindIndexToken=&blindIndexField=
Response: { "records": Record[], "total": number }

GET    /api/records/by-number/:number
Permission: cases:read-* (access-checked)
Response: Record

GET    /api/records/envelope-recipients
Permission: cases:read-*
Query: ?entityTypeId=&assignedTo=
Response: EnvelopeRecipientsResponse

GET    /api/records/by-contact/:contactId
Permission: cases:read-*
Response: { "records": Record[] }

GET    /api/records/interactions/by-source/:sourceId
Permission: cases:read-*
Response: { "linkedRecordId": string | null, "linkedRecordNumber": string | null }

POST   /api/records/convert-from-report
Permission: reports:triage
Body: { "reportId": string, "entityTypeId": string }
Response: { "recordId": string, "caseNumber"?: string, "autoAssigned": boolean, "assignedTo": string[] } (201)

GET    /api/records/:id
Permission: cases:read-* (access-checked)
Response: Record

GET    /api/records/:id/envelope-recipients
Permission: cases:read-*
Response: EnvelopeRecipientsResponse

POST   /api/records
Permission: cases:create
Body: CreateRecordBody
Response: Record (201)

PATCH  /api/records/:id
Permission: cases:update | cases:update-own
Body: UpdateRecordBody
Response: Record

DELETE /api/records/:id
Permission: cases:delete
Response: { "ok": true }

POST   /api/records/:id/contacts
Permission: cases:link
Body: { "contactId": string, "role": string }
Response: RecordContact (201)

DELETE /api/records/:id/contacts/:contactId
Permission: cases:link
Response: { "ok": true }

GET    /api/records/:id/contacts
Permission: cases:read-*
Response: { "contacts": RecordContact[] }

GET    /api/records/:id/suggest-assignees
Permission: cases:assign
Response: { "suggestions": AssigneeSuggestion[] }

POST   /api/records/:id/assign
Permission: cases:assign
Body: { "pubkeys": string[] }
Response: Record

POST   /api/records/:id/unassign
Permission: cases:assign
Body: { "pubkey": string }
Response: Record

GET    /api/records/:id/interactions
Permission: cases:read-*
Query: ?page=&limit=&interactionTypeHash=&after=&before=
Response: { "interactions": CaseInteraction[], "total": number }

POST   /api/records/:id/interactions
Permission: cases:update | cases:update-own
Body: CreateInteractionBody
Response: CaseInteraction (201)

DELETE /api/records/:id/interactions/:interactionId
Permission: cases:update
Response: { "ok": true }

POST   /api/records/:id/reports
Permission: cases:link
Body: { "reportId": string }
Response: ReportCaseLink (201)

DELETE /api/records/:id/reports/:reportId
Permission: cases:link
Response: { "ok": true }

GET    /api/records/:id/reports
Permission: cases:read-*
Response: { "links": ReportCaseLink[] }

POST   /api/records/:id/notify-contacts
Permission: cases:update
Body: { "recipients": [{ "identifier": string, "channel": string, "message": string }] }
Response: { "recordId": string, "notified": number, "skipped": number, "results": NotificationResultItem[] }

POST   /api/records/merge
Permission: cases:update
Body: { "primaryId": string, "secondaryId": string }
Response: { "primaryId": string, "secondaryId": string, "mergedContacts": number }
```

Hub-scoped: `/api/hubs/:hubId/records/*`

### 4.32 Events (Deprecated)

> **Deprecation Notice:** The `/events` group is deprecated (Sunset: 2026-07-01). Successor: `/records` with `category:"event"` entity types. All responses include `Deprecation: true`, `Sunset: 2026-07-01`, and `Link: </api/records?category=event>; rel="successor-version"` headers.

Events are now configurable entity types with `category:"event"`. Use the Records API (Section 4.31) with an `entityTypeId` corresponding to an event entity type — dates, locations, and all other event fields are stored as encrypted record content.

The deprecated `/api/events` and `/api/hubs/:hubId/events` endpoints remain available through the sunset date and return the sunset response headers listed above, but no new features will be added. Implementors encountering references to `/api/events` should migrate to Section 4.31 Records.

### 4.33 Evidence

Evidence metadata and chain of custody. Mounted under `/records/:id/evidence` and `/evidence/:id`.

```
POST   /api/records/:id/evidence
Permission: evidence:upload
Body: { "fileId": string, "filename": string, "mimeType": string, "sizeBytes": number, "classification": string, "integrityHash": hex, "source": string, "sourceDescription"?: string, "encryptedDescription"?: hex, "descriptionEnvelopes"?: Envelope[], "interactionTypeHash"?: string }
Response: EvidenceMetadata (201)

GET    /api/records/:id/evidence
Permission: evidence:download | evidence:upload | evidence:manage-custody
Query: ?page=&limit=&classification=
Response: { "evidence": EvidenceMetadata[], "total": number }

GET    /api/evidence/:evidenceId
Permission: evidence:download | evidence:manage-custody
Response: EvidenceMetadata

GET    /api/evidence/:evidenceId/custody
Permission: evidence:manage-custody
Response: { "entries": CustodyEntry[] }

POST   /api/evidence/:evidenceId/access
Permission: evidence:download
Body: { "action": "view"|"download"|"share", "integrityHash"?: hex, "notes"?: string }
Response: CustodyEntry (201)

POST   /api/evidence/:evidenceId/verify
Permission: evidence:download
Body: { "currentHash": hex }
Response: { "valid": boolean, "storedHash": hex, "currentHash": hex }
```

Hub-scoped: `/api/hubs/:hubId/records/:id/evidence/*`

### 4.34 System Health

Aggregated system health dashboard for admins.

```
GET /api/system/health
Permission: system:manage-instance
Response: SystemHealth { server, services, calls, storage, backup, users, timestamp }
```

### 4.35 Geocoding

Address autocomplete and geocoding (rate-limited per user).

```
POST /api/geocoding/autocomplete
Permission: notes:read-own
Body: { "query": string, "limit"?: number }
Response: LocationResult[]
Rate limit: 60/min per user

POST /api/geocoding/geocode
Permission: notes:read-own
Body: { "address": string }
Response: LocationResult | null
Rate limit: 20/min per user

POST /api/geocoding/reverse
Permission: notes:read-own
Body: { "lat": number, "lon": number }
Response: LocationResult | null
Rate limit: 20/min per user
```

### 4.36 Analytics

Admin dashboard metrics. Available at both global (`/api/analytics/*`) and hub-scoped (`/api/hubs/:hubId/analytics/*`). Platform-scoped access requires super-admin.

```
GET /api/analytics/calls
Permission: audit:read
Query: ?from=ISO8601&to=ISO8601
Response: CallMetrics

GET /api/analytics/conversations
Permission: audit:read
Query: ?from=ISO8601&to=ISO8601
Response: ConversationMetrics

GET /api/analytics/shifts
Permission: audit:read
Response: ShiftMetrics

GET /api/analytics/health
Permission: audit:read
Response: AnalyticsSystemHealth

GET /api/analytics/hours
Permission: audit:read
Query: ?from=ISO8601&to=ISO8601
Response: HourlyDistribution

GET /api/analytics/users
Permission: audit:read
Query: ?from=ISO8601&to=ISO8601
Response: UserStats

GET /api/analytics/me
Auth: Required (any role)
Query: ?from=ISO8601&to=ISO8601
Response: PersonalStats
```

### 4.37 Sigchain

Per-device key authorization sigchain (Phase 6).

```
GET  /api/users/:targetPubkey/sigchain
Auth: Required (self or admin)
Response: { "links": SigchainLink[] }

POST /api/users/:targetPubkey/sigchain
Auth: Required (self only)
Body: { "seqNo": number (≥ 1), "linkType": "genesis"|"device_add"|"device_remove"|"key_rotate"|"puk_epoch", "payload": object, "signature": hex128, "prevHash": hex64|"", "hash": hex64, "signerDeviceId": string, "signerPubkey": hex64, "timestamp": ISO8601 }
Response: SigchainLink (201) — includes "timestamp" (part of the hashed form)
Error: 400 on invalid link semantics (genesis only at seq 1, payload.type must match linkType,
       payload shape per §2.11, signerPubkey must be the user's identity key, genesis must name
       its signing device) or entry-hash mismatch
Error: 409 on hash-chain continuity violation (seqNo / prevHash, incl. a concurrent append)
```

### 4.38 PUK (Per-User Key)

PUK envelope distribution and retrieval (Phase 6).

```
POST /api/puk/envelopes
Auth: Required
Body: { "envelopes": [{ "deviceId": string, "generation": number (≥ 1), "envelope": HpkeEnvelope }] }
  deviceId: sigchain device ID (§2.11); must be authorised by the caller's sigchain
  envelope: { "v": 3, "labelId": number, "enc": base64url, "ct": base64url }
Response: { "distributed": number, "envelopes": PukEnvelope[] } (201)
Error: 400 if any envelope is addressed to a device the sigchain does not authorise (nothing stored)

GET  /api/puk/envelopes/:deviceId
Auth: Required (own device only)
Response: PukEnvelope
Error: 404 if no envelope found
```

### 4.39 MLS (Message Layer Security)

Hub-scoped MLS handshake message routing (Phase 6). Only available under `/api/hubs/:hubId/mls/*`.

```
POST /api/hubs/:hubId/mls/commit
Auth: Required (hub member)
Body: { "recipientDeviceIds": string[], "payload": base64url }
Response: 204 No Content

POST /api/hubs/:hubId/mls/welcome
Auth: Required (hub member)
Body: { "recipientDeviceId": string, "payload": base64url }
Response: 204 No Content

GET  /api/hubs/:hubId/mls/messages
Auth: Required (hub member)
Query: ?deviceId=<deviceId>
Response: { "messages": MlsMessage[] }
Note: Fetch-and-clear semantics

POST /api/hubs/:hubId/mls/key-packages
Auth: Required (hub member)
Query: ?deviceId=<deviceId>
Body: { "keyPackages": base64url[] }
Response: 204 No Content
```

### 4.40 Signal Admin

Signal-specific admin routes for identity trust and queue monitoring.

```
GET /api/messaging/signal/identities
Permission: settings:manage-messaging
Query: ?hub=<hubId>
Response: { "identities": SignalIdentityRecord[] }

GET /api/messaging/signal/identities/untrusted
Permission: settings:manage-messaging
Query: ?hub=<hubId>
Response: { "identities": SignalIdentityRecord[] }

POST /api/messaging/signal/identities/trust
Permission: settings:manage-messaging
Body: { "uuid": string, "trustLevel": "trusted"|"untrusted"|"verified", "hubId"?: string }
Response: { "success": boolean }

GET /api/messaging/signal/queue/stats
Permission: settings:manage-messaging
Query: ?hub=<hubId>
Response: SignalQueueStats

GET /api/messaging/signal/queue/dead-letters
Permission: settings:manage-messaging
Query: ?hub=<hubId>
Response: { "deadLetters": unknown[] }

POST /api/messaging/signal/queue/retry/:id
Permission: settings:manage-messaging
Response: { "success": boolean }
```

### 4.41 Firehose

Firehose connection management for inference agents. Hub-scoped and global.

```
GET    /api/firehose
Permission: firehose:read
Response: { "connections": FirehoseConnection[] }

POST   /api/firehose
Permission: firehose:manage
Body: CreateFirehoseConnectionBody
Response: { "connection": FirehoseConnection } (201)

GET    /api/firehose/status
Permission: firehose:read
Response: { "statuses": FirehoseConnectionStatus[] }

GET    /api/firehose/:id
Permission: firehose:read
Response: { "connection": FirehoseConnection }

PATCH  /api/firehose/:id
Permission: firehose:manage
Body: UpdateFirehoseConnectionBody
Response: { "connection": FirehoseConnection }

DELETE /api/firehose/:id
Permission: firehose:manage
Response: { "ok": true }

POST   /api/firehose/:id/activate
Permission: firehose:manage
Response: { "connection": FirehoseConnection }

POST   /api/firehose/:id/pause
Permission: firehose:manage
Response: { "connection": FirehoseConnection }

GET    /api/firehose/:id/buffer
Permission: firehose:read
Response: { "connectionId": string, "bufferSize": number, "agentRunning": boolean, "extractionIntervalSec": number, "bufferTtlDays": number }

DELETE /api/firehose/:id/buffer
Permission: firehose:manage
Response: { "purged": number }

POST   /api/firehose/:id/optout
Permission: firehose:read
Response: { "id": string, "connectionId": string, "userId": string, "optedOutAt": ISO8601 }

DELETE /api/firehose/:id/optout
Permission: firehose:read
Response: { "ok": true }
```

Hub-scoped: `/api/hubs/:hubId/firehose/*`

### 4.42 Signal Notifications

Zero-knowledge Signal notification sidecar integration.

```
GET    /api/signal-notification/contact
Auth: Required
Response: { "identifierHash": hex, "identifierCiphertext": hex, "identifierEnvelope": hex, "identifierType": string, "verifiedAt"?: ISO8601, "updatedAt": ISO8601 }
Error: 404 if not registered

PUT    /api/signal-notification/contact
Auth: Required
Body: { "identifierHash": hex, "identifierCiphertext": hex, "identifierEnvelope": hex, "identifierType": string }
Response: { "ok": true }

POST   /api/signal-notification/contact/sidecar-token
Auth: Required
Response: { "token": string, "sidecarUrl": string }

DELETE /api/signal-notification/contact
Auth: Required
Response: 204 No Content

GET    /api/signal-notification/hmac-key
Auth: Required
Response: { "hmacKey": hex }

GET    /api/signal-notification/security-prefs
Auth: Required
Response: SecurityPrefs

PATCH  /api/signal-notification/security-prefs
Auth: Required
Body: SecurityPrefsPatch
Response: SecurityPrefs

POST   /api/signal-notification/digest/run
Permission: system:admin
Body: { "cadence"?: "daily"|"weekly" }
Response: DigestResult
```

### 4.43 Provider Setup

Telephony provider OAuth, configuration, and number management.

```
POST /api/provider-setup/oauth/start
Permission: telephony:manage-providers
Body: { "provider": string, "redirectUrl": string }
Response: { "authUrl": string, "stateId": string, "expiresAt": ISO8601 }

POST /api/provider-setup/oauth/callback
Auth: None (state token is proof)
Body: { "code"?: string, "state"?: string, "error"?: string }
Response: 302 Redirect or JSON { "redirectUrl": string }

GET  /api/provider-setup/oauth/callback
Auth: None
Query: ?code=&state=&error=
Response: 302 Redirect or JSON { "redirectUrl": string }

GET  /api/provider-setup/oauth/status/:state
Permission: telephony:manage-providers
Response: OAuthFlowState

POST /api/provider-setup/configure
Permission: telephony:manage-providers
Body: { "provider": string, "credentials"?: object, "phoneNumber"?: string, "hubId"?: string }
Response: { "ok": true }

POST /api/provider-setup/test
Permission: telephony:manage-providers
Body: { "provider": string, "hubId"?: string }
Response: { "connected": boolean, "latencyMs": number, "accountName"?: string, "error"?: string }

GET  /api/provider-setup/status/:provider
Permission: telephony:view-providers
Response: ProviderStatus

GET  /api/provider-setup/phone-numbers
Permission: telephony:view-numbers
Query: ?provider=&hubId=
Response: { "numbers": OwnedNumber[] }

POST /api/provider-setup/phone-numbers/search
Permission: telephony:manage-numbers
Body: NumberSearchQuery
Response: { "numbers": AvailableNumber[] }
Rate limit: 5/min

POST /api/provider-setup/phone-numbers/provision
Permission: telephony:manage-numbers
Body: NumberProvisionRequest
Response: { ...OwnedNumber, "webhookWarning"?: string }
Rate limit: 1/min

POST /api/provider-setup/configure-webhooks
Permission: telephony:manage-providers
Body: { "provider": string, "numberId": string, "enableSms"?: boolean, "hubId"?: string }
Response: { "ok": true }

POST /api/provider-setup/create-sip-trunk
Permission: telephony:manage-providers
Body: { "provider": string, "domain": string, "hubId"?: string }
Response: { "sipProvider": string, "sipUsername": string, "credentialsStored": boolean, "trunkSid"?: string, "connectionId"?: string }

// Signal Bridge Registration
POST /api/provider-setup/signal/register
Permission: messaging:manage-signal
Body: { "bridgeUrl": string, "phoneNumber": string, "method"?: "sms"|"voice", "hubId"?: string }
Response: SignalRegistration

GET  /api/provider-setup/signal/status
Permission: messaging:manage-signal
Query: ?hubId=&registrationId=
Response: SignalRegistrationStatus

POST /api/provider-setup/signal/verify
Permission: messaging:manage-signal
Body: { "registrationId": string, "code": string }
Response: SignalRegistrationStatus
Rate limit: 5/min

DELETE /api/provider-setup/signal/unregister
Permission: messaging:manage-signal
Query: ?registrationId=
Response: { "ok": true }

GET  /api/provider-setup/signal/account
Permission: messaging:manage-signal
Query: ?registrationId=
Response: SignalAccountInfo

// A2P Registration
POST /api/provider-setup/a2p/brand
Permission: telephony:manage-a2p
Body: { "providerType"?: string, "brandInfo": object, "hubId"?: string }
Response: A2pRegistration

POST /api/provider-setup/a2p/campaign
Permission: telephony:manage-a2p
Body: { "registrationId": string, "campaignInfo": object }
Response: A2pRegistration

GET  /api/provider-setup/a2p/status
Permission: telephony:manage-a2p
Query: ?hubId=&registrationId=
Response: A2pRegistrationStatus

POST /api/provider-setup/a2p/skip
Permission: telephony:manage-a2p
Body: { "providerType"?: string, "hubId"?: string }
Response: A2pRegistrationStatus
```

Hub-scoped: `/api/hubs/:hubId/provider-setup/*`

### 4.44 Provider Templates

Reusable provider configuration templates. Super-admin only for writes.

```
GET    /api/provider-templates
Permission: telephony:view-providers
Response: { "templates": ProviderTemplate[] }

GET    /api/provider-templates/:id
Permission: telephony:view-providers
Response: { "template": ProviderTemplate }

POST   /api/provider-templates
Permission: system:manage-instance
Body: CreateProviderTemplateBody
Response: { "template": ProviderTemplate } (201)
Rate limit: 5/min

PUT    /api/provider-templates/:id
Permission: system:manage-instance
Body: UpdateProviderTemplateBody
Response: { "template": ProviderTemplate }

DELETE /api/provider-templates/:id
Permission: system:manage-instance
Response: { "ok": true }
```

### 4.45 Erasure

GDPR/right-to-be-forgotten account erasure.

```
GET    /api/erasure/me
Permission: erasure:request-self
Response: { "request": ErasureRequest | null }

POST   /api/erasure/me
Permission: erasure:request-self
Body: { "justification": string }
Response: { "request": ErasureRequest }

POST   /api/erasure/me/emergency
Permission: erasure:request-self
Body: { "justification": string, "coApproverPubkey": hex64, "coApproverSignature": hex128, "timestamp": number }
Response: { "request": ErasureRequest }

DELETE /api/erasure/me
Permission: erasure:request-self
Response: { "ok": true }

GET    /api/erasure/requests
Permission: erasure:admin
Query: ?status=&limit=&offset=
Response: { "requests": ErasureRequest[], "total": number }

POST   /api/erasure/:userId
Permission: erasure:admin
Body: { "justification": string }
Response: { "ok": true, "reEncryptionJobIds": string[] }

POST   /api/erasure/:userId/wipe-device/:devicePubkey
Permission: erasure:admin
Body: { "reason"?: string }
Response: { "ok": true }

GET    /api/erasure/re-encryption-jobs
Permission: erasure:admin
Query: ?userId=
Response: { "jobs": ReEncryptionJob[] }
```

### 4.46 Retention

Data retention settings per hub and platform-wide floors.

```
GET    /api/retention
Permission: retention:manage
Response: { "settings": RetentionSetting[] }

PATCH  /api/retention
Permission: retention:manage
Body: { "settings": [{ "category": string, "retentionDays": number }] }
Response: { "settings": RetentionSetting[] }

GET    /api/retention/platform-floors
Permission: system:manage-instance
Response: { "floors": RetentionFloor[] }

PATCH  /api/retention/platform-floors
Permission: system:manage-instance
Body: { "floors": [{ "category": string, "minRetentionDays": number }] }
Response: { "floors": RetentionFloor[] }
```

Hub-scoped: `/api/hubs/:hubId/retention/*`

### 4.47 Platform Bans

Platform-scoped bans (cross-hub). Requires `bans:*-platform` permissions.

```
GET    /api/bans/platform
Permission: bans:read-platform
Query: ?limit=&offset=
Response: { "bans": PlatformBan[], "total": number }

POST   /api/bans/platform
Permission: bans:create-platform
Body: { "phone": string (E.164), "reason": string }
Response: { "ok": true }

POST   /api/bans/platform/bulk
Permission: bans:create-platform
Body: { "phones": string[], "reason": string }
Response: { "ok": true, "count": number }

DELETE /api/bans/platform/:id
Permission: bans:delete-platform
Response: { "ok": true }

GET    /api/bans/platform/search
Permission: bans:read-platform
Query: ?phone=<E.164>
Response: { "bans": PlatformBan[] }

POST   /api/bans/platform/promote
Permission: bans:create-platform
Body: { "banId": string }
Response: { "ok": true }
```

### 4.48 Platform Settings

Instance-level platform settings. Super-admin only.

```
GET   /api/settings/platform
Permission: system:manage-instance
Response: { "settings": PlatformSettings }

PATCH /api/settings/platform
Permission: system:manage-instance
Body: UpdatePlatformSettingsBody
Response: { "settings": PlatformSettings }
```

### 4.49 Ring Groups

Encrypted ring groups for parallel call routing. Hub-scoped only.

```
GET    /api/hubs/:hubId/ring-groups
Permission: shifts:manage-ring-groups
Response: { "ringGroups": RingGroupSummary[] }

POST   /api/hubs/:hubId/ring-groups
Permission: shifts:manage-ring-groups
Body: { "encryptedName": hex }
Response: RingGroup

GET    /api/hubs/:hubId/ring-groups/:id
Permission: shifts:manage-ring-groups
Response: RingGroup

PUT    /api/hubs/:hubId/ring-groups/:id
Permission: shifts:manage-ring-groups
Body: { "encryptedName"?: hex }
Response: RingGroup

DELETE /api/hubs/:hubId/ring-groups/:id
Permission: shifts:manage-ring-groups
Response: { "ok": true }

POST   /api/hubs/:hubId/ring-groups/:id/members
Permission: shifts:manage-ring-groups
Body: { "pubkeys": string[] }
Response: RingGroup

DELETE /api/hubs/:hubId/ring-groups/:id/members
Permission: shifts:manage-ring-groups
Body: { "pubkeys": string[] }
Response: RingGroup
```

### 4.50 Recovery Group

Social recovery with Shamir secret sharing. Mix of public and authenticated routes.

**Unauthenticated (rate-limited):**
```
POST /api/recovery-group/initiate
Body: { "hubId": string, "userIdentifier": string, "newDevicePubkey": hex64 }
Response: RecoveryInitiateResponse
Rate limit: 10/5min per IP

POST /api/recovery-group/initiate/verify
Body: { "sessionId": string, "verificationCode": string }
Response: RecoveryInitiateVerifyResponse
```

**Authenticated:**
```
POST /api/recovery-group/enroll
Permission: recovery:manage
Body: RecoveryGroupEnrollBody
Response: { "ok": true }

GET  /api/recovery-group/:hubId
Permission: recovery:view
Response: RecoveryGroupInfo

POST /api/recovery-group/session/:id/contribute
Permission: recovery:hold-share
Body: { "encryptedShare": hex, "contributorSignature": hex128 }
Response: RecoveryContributeResponse

GET  /api/recovery-group/session/:id
Permission: recovery:view
Response: RecoverySessionStatus

POST /api/recovery-group/session/:id/emergency
Permission: recovery:approve
Body: { "approverPubkey": hex64, "justification": string, "signature": hex128 }
Response: { "ok": true }

POST /api/recovery-group/session/:id/cancel
Auth: Required
Response: { "ok": true }

POST /api/recovery-group/user-envelope
Auth: Required
Body: { "hubId": string, "envelope": string }
Response: { "ok": true }

POST /api/recovery-group/shares/liveness
Permission: recovery:hold-share
Body: { "hubId": string, "proof": string }
Response: { "ok": true }
```

### 4.51 Teams

Hub-scoped team management for contact assignment.

```
GET    /api/hubs/:hubId/teams
Permission: teams:read
Response: { "teams": Team[] }

POST   /api/hubs/:hubId/teams
Permission: teams:manage
Body: { "id"?: string, "encryptedName": hex, "encryptedDescription"?: hex }
Response: Team

GET    /api/hubs/:hubId/teams/:teamId
Permission: teams:read
Response: Team

PATCH  /api/hubs/:hubId/teams/:teamId
Permission: teams:manage
Body: { "encryptedName"?: hex, "encryptedDescription"?: hex }
Response: Team

DELETE /api/hubs/:hubId/teams/:teamId
Permission: teams:manage
Response: { "ok": true }

GET    /api/hubs/:hubId/teams/:teamId/members
Permission: teams:read
Response: { "members": TeamMember[] }

POST   /api/hubs/:hubId/teams/:teamId/members
Permission: teams:manage
Body: { "pubkeys": string[] }
Response: { "ok": true }

DELETE /api/hubs/:hubId/teams/:teamId/members/:userPubkey
Permission: teams:manage
Response: { "ok": true }

GET    /api/hubs/:hubId/teams/:teamId/contacts
Permission: teams:read
Response: { "assignments": ContactTeamAssignment[] }

POST   /api/hubs/:hubId/teams/:teamId/contacts
Permission: teams:manage
Body: { "contactIds": string[] }
Response: { "ok": true }

DELETE /api/hubs/:hubId/teams/:teamId/contacts/:contactId
Permission: teams:manage
Response: { "ok": true }
```

### 4.52 Tags

Hub-scoped tags for contact categorization.

```
GET    /api/hubs/:hubId/tags
Permission: tags:view
Response: { "tags": Tag[] }

POST   /api/hubs/:hubId/tags
Permission: tags:create
Body: { "id"?: string, "name": string, "encryptedLabel": hex, "color"?: string, "encryptedCategory"?: hex }
Response: Tag

PATCH  /api/hubs/:hubId/tags/:tagId
Permission: tags:manage
Body: { "name"?: string, "encryptedLabel"?: hex, "color"?: string, "encryptedCategory"?: hex }
Response: Tag

DELETE /api/hubs/:hubId/tags/:tagId
Permission: tags:manage
Response: { "removedFromContacts": number }
```

### 4.53 Entity Schema (Case Management)

Entity types, relationship types, report types, templates, and case numbering. Mounted at `/api/settings/cms`.

```
GET  /api/settings/cms/case-management
Permission: settings:read
Response: { "enabled": boolean }

PUT  /api/settings/cms/case-management
Permission: settings:manage-cms
Body: { "enabled": boolean }
Response: { "enabled": boolean }

GET  /api/settings/cms/auto-assignment
Permission: settings:read
Response: { "enabled": boolean }

PUT  /api/settings/cms/auto-assignment
Permission: cases:manage
Body: { "enabled": boolean }
Response: { "enabled": boolean }

GET  /api/settings/cms/cross-hub
Permission: settings:read
Response: { "enabled": boolean }

PUT  /api/settings/cms/cross-hub
Permission: settings:manage-cms
Body: { "enabled": boolean }
Response: { "enabled": boolean }

// Entity Types
GET    /api/settings/cms/entity-types
Permission: settings:read | cases:read-own | cases:read-assigned | cases:create
Query: ?hubId=
Response: { "entityTypes": EntityTypeDefinition[] }

POST   /api/settings/cms/entity-types
Permission: cases:manage-types
Body: CreateEntityTypeBody
Response: EntityTypeDefinition

GET    /api/settings/cms/entity-types/:id
Permission: settings:read
Response: EntityTypeDefinition

PATCH  /api/settings/cms/entity-types/:id
Permission: cases:manage-types
Body: UpdateEntityTypeBody
Response: EntityTypeDefinition

DELETE /api/settings/cms/entity-types/:id
Permission: cases:manage-types
Response: { "ok": true }

PATCH  /api/settings/cms/entity-types/:id/customize
Permission: cases:manage-types
Body: { "encryptedLabel"?: hex, "icon"?: string, "color"?: string }
Response: EntityTypeDefinition

// Relationship Types
GET    /api/settings/cms/relationship-types
Permission: settings:read
Response: { "relationshipTypes": RelationshipTypeDefinition[] }

POST   /api/settings/cms/relationship-types
Permission: cases:manage-types
Body: CreateRelationshipTypeBody
Response: RelationshipTypeDefinition

GET    /api/settings/cms/relationship-types/:id
Permission: settings:read
Response: RelationshipTypeDefinition

PATCH  /api/settings/cms/relationship-types/:id
Permission: cases:manage-types
Body: UpdateRelationshipTypeBody
Response: RelationshipTypeDefinition

DELETE /api/settings/cms/relationship-types/:id
Permission: cases:manage-types
Response: { "ok": true }

// Report Types
GET    /api/settings/cms/report-types
Permission: settings:read
Query: ?hubId=
Response: { "reportTypes": ReportTypeDefinition[] }

POST   /api/settings/cms/report-types
Permission: cases:manage-types
Body: CreateCmsReportTypeBody
Response: ReportTypeDefinition

GET    /api/settings/cms/report-types/:id
Permission: settings:read
Response: ReportTypeDefinition

PATCH  /api/settings/cms/report-types/:id
Permission: cases:manage-types
Body: UpdateCmsReportTypeBody
Response: ReportTypeDefinition

DELETE /api/settings/cms/report-types/:id
Permission: cases:manage-types
Response: { "ok": true }

// Case Number Generation
POST   /api/settings/cms/case-number
Permission: cases:create
Body: { "prefix": string, "year"?: number, "hubId"?: string }
Response: { "number": string }

// Templates
GET    /api/settings/cms/templates
Permission: settings:read
Response: { "templates": TemplateSummary[], "appliedTemplateIds": string[] }

GET    /api/settings/cms/templates/updates
Permission: settings:read
Response: { "updates": TemplateUpdate[] }

GET    /api/settings/cms/templates/:id
Permission: settings:read
Response: TemplateDetail

POST   /api/settings/cms/templates/apply
Permission: cases:manage-types
Body: { "templateId": string }
Response: { "applied": true, "entityTypes": number, "relationshipTypes": number, "reportTypes": number, "suggestedRoles": SuggestedRole[] } (201)

POST   /api/settings/cms/roles/from-template
Permission: system:manage-roles
Body: { "roles": SuggestedRole[] }
Response: { "created": { "id": string, "name": string }[], "count": number } (201)
```

Hub-scoped: `/api/hubs/:hubId/settings/cms/*`

### 4.54 Hub Onboarding

Hub-specific onboarding and provider configuration. Hub-scoped only.

```
POST /api/hubs/:hubId/onboard
Permission: hubs:configure
Body: { "templateId"?: string }
Response: { "onboarding": HubOnboardingState }
Rate limit: 10/min

GET  /api/hubs/:hubId/onboard/status
Permission: telephony:view-providers
Response: { "onboarding": HubOnboardingState | null }

PUT  /api/hubs/:hubId/onboard/step
Permission: hubs:configure
Body: { "step": string, "data"?: { "channelConfig"?: ChannelConfig } }
Response: { "onboarding": HubOnboardingState }

GET  /api/hubs/:hubId/onboard/provider-status
Permission: telephony:view-providers
Response: { "status": HubSetupStatus }

GET  /api/hubs/:hubId/onboard/usage
Permission: telephony:view-providers
Response: { "usage": HubUsage }

PUT  /api/hubs/:hubId/onboard/quotas
Permission: system:manage-instance
Body: HubQuota
Response: { "quotas": HubQuota }

PUT  /api/hubs/:hubId/onboard/channels
Permission: hubs:configure
Body: { "channel": string, "enabled": boolean }
Response: { "channels": ChannelConfig }

POST /api/hubs/:hubId/onboard/sub-account
Permission: hubs:configure
Body: { "masterConfigId": string }
Response: { "subAccountId": string }
```

### 4.55 Hub-Scoped Routes

All of the following routes are also available with a `/api/hubs/:hubId/` prefix, which scopes them to a specific hub:

```
/api/hubs/:hubId/shifts/*
/api/hubs/:hubId/bans/*
/api/hubs/:hubId/notes/*
/api/hubs/:hubId/calls/*
/api/hubs/:hubId/audit/*
/api/hubs/:hubId/conversations/*
/api/hubs/:hubId/reports/*
/api/hubs/:hubId/blasts/*
/api/hubs/:hubId/contacts/*
/api/hubs/:hubId/directory/*
/api/hubs/:hubId/records/*
/api/hubs/:hubId/settings/cms/*
/api/hubs/:hubId/analytics/*
/api/hubs/:hubId/messaging/signal/*
/api/hubs/:hubId/provider-setup/*
/api/hubs/:hubId/retention/*
/api/hubs/:hubId/mls/*
/api/hubs/:hubId/firehose/*
/api/hubs/:hubId/onboard/*
/api/hubs/:hubId/ring-groups/*
/api/hubs/:hubId/teams/*
/api/hubs/:hubId/tags/*
```

When using hub-scoped routes, the `hubContext` middleware resolves hub-specific permissions for the user and scopes all queries to the specified hub.
/api/hubs/:hubId/messaging/signal/*
/api/hubs/:hubId/provider-setup/*
/api/hubs/:hubId/retention/*
/api/hubs/:hubId/firehose/*
/api/hubs/:hubId/mls/*
/api/hubs/:hubId/onboard/*
/api/hubs/:hubId/ring-groups/*
/api/hubs/:hubId/teams/*
/api/hubs/:hubId/tags/*
```

When using hub-scoped routes, the `hubContext` middleware resolves hub-specific permissions for the user and scopes all queries to the specified hub.

### 4.24 Additional Endpoints

The following endpoints are implemented but documented here at a high level. For detailed request/response schemas, see `apps/worker/routes/` and the OpenAPI snapshot (`/api/openapi.json`).

#### Contacts & Directory
```
GET    /api/contacts
GET    /api/contacts/:id
POST   /api/contacts
PATCH  /api/contacts/:id
DELETE /api/contacts/:id
GET    /api/directory
```

#### Records & Entity Schema (CMS)
```
GET    /api/records
POST   /api/records
GET    /api/records/:id
PATCH  /api/records/:id
DELETE /api/records/:id
POST   /api/records/:id/assign
GET    /api/settings/cms         # entity schema definitions
POST   /api/settings/cms
```

#### Recovery Groups
```
POST /api/recovery-group/initiate
POST /api/recovery-group/verify
POST /api/recovery-group/complete
```

#### PUK (Per-User Key) Management
```
GET  /api/puk
POST /api/puk/rotate
```

#### Sessions
```
GET    /api/sessions
DELETE /api/sessions/:id
```

#### Security Events
```
GET /api/security-events
GET /api/admin/security-events
```

#### Tags
```
GET    /api/hubs/:hubId/tags
POST   /api/hubs/:hubId/tags
PATCH  /api/hubs/:hubId/tags/:id
DELETE /api/hubs/:hubId/tags/:id
```

#### Teams
```
GET    /api/hubs/:hubId/teams
POST   /api/hubs/:hubId/teams
PATCH  /api/hubs/:hubId/teams/:id
DELETE /api/hubs/:hubId/teams/:id
```

#### Ring Groups
```
GET    /api/ring-groups
POST   /api/ring-groups
PATCH  /api/ring-groups/:id
DELETE /api/ring-groups/:id
GET    /api/hubs/:hubId/ring-groups
```

#### Retention & Erasure
```
GET    /api/retention
POST   /api/retention
POST   /api/erasure/request
GET    /api/erasure/status
```

#### MLS (Messaging Layer Security)
```
GET    /api/hubs/:hubId/mls/welcome
POST   /api/hubs/:hubId/mls/commit
GET    /api/hubs/:hubId/mls/group-info
```

#### Firehose (LLM Inference)
```
POST /api/firehose/extract
GET  /api/firehose/status
```

#### Geocoding
```
GET /api/geocoding/forward?q=<address>
GET /api/geocoding/reverse?lat=<>&lon=<>
```

#### Account Management
```
GET    /api/account
PATCH  /api/account
DELETE /api/account
```

#### Admin Devices
```
GET /api/admin/devices
```

#### Signal Messaging
```
POST /api/messaging/signal/send
GET  /api/messaging/signal/status
```

#### Provider Setup & Templates
```
GET  /api/provider-setup
POST /api/provider-setup
GET  /api/provider-templates
```

#### Platform Settings & Bans
```
GET  /api/settings/platform
PATCH /api/settings/platform
GET  /api/bans/platform
POST /api/bans/platform
```

#### System & Analytics
```
GET /api/system/status
GET /api/analytics/overview
GET /api/analytics/calls
GET /api/analytics/messages
```

### 4.24 Contacts v2 (Contact Directory)

```
GET    /api/directory
       Permission: contacts:view
       Response: { "contacts": Contact[], "total": number }

GET    /api/directory/:id
       Permission: contacts:view
       Response: Contact

POST   /api/directory
       Permission: contacts:create
       Body: { "encryptedProfile": hex, "identifierHash": string, ... }
       Response: Contact

PATCH  /api/directory/:id
       Permission: contacts:edit
       Body: partial Contact
       Response: Contact

DELETE /api/directory/:id
       Permission: contacts:delete
       Response: { "ok": true }

GET    /api/directory/lookup/:identifierHash
       Permission: contacts:view
       Response: { "contact": Contact | null }

GET    /api/directory/search?tokens=
       Permission: contacts:view
       Response: { "contacts": Contact[] }

POST   /api/directory/:id/relationships
       Permission: contacts:manage-relationships
       Body: { "contactIdB": string, "relationshipType": string }
       Response: ContactRelationship

GET    /api/directory/:id/relationships
       Permission: contacts:view
       Response: { "relationships": ContactRelationship[] }

DELETE /api/directory/:id/relationships/:relId
       Permission: contacts:manage-relationships
       Response: { "ok": true }

GET    /api/directory/groups
       Permission: contacts:manage-groups
       Response: { "groups": AffinityGroup[] }

POST   /api/directory/groups
       Permission: contacts:manage-groups
       Body: { "name": string, "members": [...] }
       Response: AffinityGroup

GET    /api/directory/groups/:groupId
       Permission: contacts:view
       Response: AffinityGroup

PATCH  /api/directory/groups/:groupId
       Permission: contacts:manage-groups
       Body: partial AffinityGroup
       Response: AffinityGroup

DELETE /api/directory/groups/:groupId
       Permission: contacts:manage-groups
       Response: { "ok": true }

POST   /api/directory/groups/:groupId/members
       Permission: contacts:manage-groups
       Body: { "contactId": string }
       Response: GroupMember

DELETE /api/directory/groups/:groupId/members/:contactId
       Permission: contacts:manage-groups
       Response: { "ok": true }

POST   /api/directory/merge
       Permission: contacts:edit
       Body: { "primaryId": string, "secondaryId": string }
       Response: { "primaryId": string, "secondaryId": string }

POST   /api/directory/bulk
       Permission: contacts:edit
       Body: { "action": string, "contactIds": string[] }
       Response: { "affected": number }

POST   /api/directory/bulk-create
       Permission: contacts:create
       Body: { "contacts": ContactInput[] }
       Response: { "created": number }
```

Hub-scoped: `/api/hubs/:hubId/directory/*`

### 4.25 Records (Case Management)

> See **Section 4.31 Records** for the full endpoint reference. Section 4.31 is the canonical and complete documentation for all `/api/records` endpoints.

### 4.26 Entity Schema (Case Management Configuration)

Mounted at `/api/settings/cms`.

```
GET    /api/settings/cms/case-management
       Permission: settings:read
       Response: { "enabled": boolean }

PUT    /api/settings/cms/case-management
       Permission: settings:manage-cms
       Body: { "enabled": boolean }
       Response: { "enabled": boolean }

GET    /api/settings/cms/auto-assignment
       Permission: settings:read
       Response: { "enabled": boolean }

PUT    /api/settings/cms/auto-assignment
       Permission: cases:manage
       Body: { "enabled": boolean }
       Response: { "enabled": boolean }

GET    /api/settings/cms/cross-hub
       Permission: settings:read
       Response: { "enabled": boolean }

PUT    /api/settings/cms/cross-hub
       Permission: settings:manage-cms
       Body: { "enabled": boolean }
       Response: { "enabled": boolean }

GET    /api/settings/cms/entity-types?hubId=
       Permission: settings:read | cases:read-own | cases:read-assigned | cases:create
       Response: { "entityTypes": EntityTypeDefinition[] }

POST   /api/settings/cms/entity-types
       Permission: cases:manage-types
       Body: EntityTypeDefinition
       Response: EntityTypeDefinition

GET    /api/settings/cms/entity-types/:id
       Permission: settings:read
       Response: EntityTypeDefinition

PATCH  /api/settings/cms/entity-types/:id
       Permission: cases:manage-types
       Body: partial EntityTypeDefinition
       Response: EntityTypeDefinition

DELETE /api/settings/cms/entity-types/:id
       Permission: cases:manage-types
       Response: { "ok": true }

PATCH  /api/settings/cms/entity-types/:id/customize
       Permission: cases:manage-types
       Body: { "labelOverrides": Record<string, string>, ... }
       Response: EntityTypeDefinition

GET    /api/settings/cms/relationship-types
       Permission: settings:read
       Response: { "relationshipTypes": RelationshipTypeDefinition[] }

POST   /api/settings/cms/relationship-types
       Permission: cases:manage-types
       Body: RelationshipTypeDefinition
       Response: RelationshipTypeDefinition

PATCH  /api/settings/cms/relationship-types/:id
       Permission: cases:manage-types
       Body: partial RelationshipTypeDefinition
       Response: RelationshipTypeDefinition

DELETE /api/settings/cms/relationship-types/:id
       Permission: cases:manage-types
       Response: { "ok": true }

POST   /api/settings/cms/case-number
       Permission: cases:create
       Body: { "prefix": string, "year"?: number }
       Response: { "number": string }

GET    /api/settings/cms/templates
       Permission: settings:read
       Response: { "templates": Template[], "appliedTemplateIds": string[] }

GET    /api/settings/cms/templates/updates
       Permission: settings:read
       Response: { "updates": TemplateUpdate[] }

GET    /api/settings/cms/templates/:id
       Permission: settings:read
       Response: Template

POST   /api/settings/cms/templates/apply
       Permission: cases:manage-types
       Body: { "templateId": string }
       Response: { "applied": true, "entityTypes": number, ... }

POST   /api/settings/cms/roles/from-template
       Permission: system:manage-roles
       Body: { "roles": SuggestedRole[] }
       Response: { "created": Array<{ id, name }>, "count": number }

GET    /api/settings/cms/report-types?hubId=
       Permission: settings:read
       Response: { "reportTypes": CmsReportTypeDefinition[] }

POST   /api/settings/cms/report-types
       Permission: cases:manage-types
       Body: CmsReportTypeDefinition
       Response: CmsReportTypeDefinition

GET    /api/settings/cms/report-types/:id
       Permission: settings:read
       Response: CmsReportTypeDefinition

PATCH  /api/settings/cms/report-types/:id
       Permission: cases:manage-types
       Body: partial CmsReportTypeDefinition
       Response: CmsReportTypeDefinition

DELETE /api/settings/cms/report-types/:id
       Permission: cases:manage-types
       Response: { "ok": true }
```

### 4.27 Recovery Group

**Authenticated routes** (`/api/recovery-group/*`):

```
POST   /api/recovery-group/enroll
       Permission: recovery:manage
       Body: { "hubId": string, "threshold": number, "totalShares": number, "groupPublicKey": hex, "shareEnvelopes": [...], ... }
       Response: { "ok": true }

GET    /api/recovery-group/:hubId
       Permission: recovery:view
       Response: RecoveryGroupInfo

POST   /api/recovery-group/session/:id/contribute
       Permission: recovery:hold-share
       Body: { "encryptedShare": hex, "contributorSignature": hex }
       Response: { "contributions": number, "thresholdMet": boolean }

GET    /api/recovery-group/session/:id
       Permission: recovery:view
       Response: RecoverySessionStatus

POST   /api/recovery-group/session/:id/emergency
       Permission: recovery:approve
       Body: { "approverPubkey": hex, "justification": string, "signature": hex }
       Response: { "ok": true }

POST   /api/recovery-group/session/:id/cancel
       Auth: Required
       Response: { "ok": true }

POST   /api/recovery-group/user-envelope
       Auth: Required
       Body: { "hubId": string, "envelope": hex }
       Response: { "ok": true }

POST   /api/recovery-group/shares/liveness
       Permission: recovery:hold-share
       Body: { "hubId": string, "proof": hex }
       Response: { "ok": true }
```

**Unauthenticated routes** (rate-limited):

```
POST   /api/recovery-group/initiate
       Body: { "hubId": string, "userIdentifier": string, "newDevicePubkey": hex }
       Response: { "sessionId": string, "status": string }

POST   /api/recovery-group/initiate/verify
       Body: { "sessionId": string, "verificationCode": string }
       Response: { "verified": boolean, "status": string }
```

### 4.28 Security Events

```
GET    /api/security-events?limit=&offset=
       Auth: Required (own events only)
       Response: { "events": SecurityEvent[], "total": number }

GET    /api/admin/security-events?limit=&offset=
       Permission: audit:read
       Response: { "events": SecurityEvent[], "total": number }
```

### 4.29 Tags

Hub-scoped: `/api/hubs/:hubId/tags/*`

```
GET    /api/hubs/:hubId/tags
       Permission: tags:view
       Response: { "tags": Tag[] }

POST   /api/hubs/:hubId/tags
       Permission: tags:create
       Body: { "id": string, "name": string, "encryptedLabel": hex, "color": string, "encryptedCategory"?: hex }
       Response: Tag

PATCH  /api/hubs/:hubId/tags/:tagId
       Permission: tags:manage
       Body: partial Tag
       Response: Tag

DELETE /api/hubs/:hubId/tags/:tagId
       Permission: tags:manage
       Response: { "removedFromContacts": number }
```

### 4.30 Teams

Hub-scoped: `/api/hubs/:hubId/teams/*`

```
GET    /api/hubs/:hubId/teams
       Permission: teams:read
       Response: { "teams": Team[] }

POST   /api/hubs/:hubId/teams
       Permission: teams:manage
       Body: { "id": string, "encryptedName": hex, "encryptedDescription"?: hex }
       Response: Team

GET    /api/hubs/:hubId/teams/:teamId
       Permission: teams:read
       Response: Team

PATCH  /api/hubs/:hubId/teams/:teamId
       Permission: teams:manage
       Body: partial Team
       Response: Team

DELETE /api/hubs/:hubId/teams/:teamId
       Permission: teams:manage
       Response: { "ok": true }

GET    /api/hubs/:hubId/teams/:teamId/members
       Permission: teams:read
       Response: { "members": TeamMember[] }

POST   /api/hubs/:hubId/teams/:teamId/members
       Permission: teams:manage
       Body: { "pubkeys": string[] }
       Response: { "ok": true }

DELETE /api/hubs/:hubId/teams/:teamId/members/:userPubkey
       Permission: teams:manage
       Response: { "ok": true }

GET    /api/hubs/:hubId/teams/:teamId/contacts
       Permission: teams:read
       Response: { "assignments": ContactTeamAssignment[] }

POST   /api/hubs/:hubId/teams/:teamId/contacts
       Permission: teams:manage
       Body: { "contactIds": string[] }
       Response: { "ok": true }

DELETE /api/hubs/:hubId/teams/:teamId/contacts/:contactId
       Permission: teams:manage
       Response: { "ok": true }
```

### 4.31 PUK (Per-User Key)

```
POST   /api/puk/envelopes
       Auth: Required
       Body: { "envelopes": [{ "deviceId": string, "generation": number, "envelope": hex }] }
       Response: { "distributed": number, "envelopes": PukEnvelope[] }

GET    /api/puk/envelopes/:deviceId
       Auth: Required (own envelopes only)
       Response: PukEnvelope
```

### 4.32 Sessions

```
GET    /api/sessions
       Auth: Required
       Response: { "sessions": Session[] }

POST   /api/sessions/terminate-others
       Auth: Required
       Response: { "terminated": number }

DELETE /api/sessions/:id
       Auth: Required
       Response: 204 No Content
```

### 4.33 Erasure (GDPR Right to be Forgotten)

```
GET    /api/erasure/me
       Permission: erasure:request-self
       Response: { "request": ErasureRequest | null }

POST   /api/erasure/me
       Permission: erasure:request-self
       Body: { "justification": string }
       Response: { "request": ErasureRequest }

POST   /api/erasure/me/emergency
       Permission: erasure:request-self
       Body: { "justification": string, "coApproverPubkey": hex, "coApproverSignature": hex, "timestamp": number }
       Response: { "request": ErasureRequest }

DELETE /api/erasure/me
       Permission: erasure:request-self
       Response: { "ok": true }

GET    /api/erasure/requests?status=&limit=&offset=
       Permission: erasure:admin
       Response: { "requests": ErasureRequest[], "total": number }

POST   /api/erasure/:userId
       Permission: erasure:admin
       Body: { "justification": string }
       Response: { "ok": true, "reEncryptionJobIds": string[] }

POST   /api/erasure/:userId/wipe-device/:devicePubkey
       Permission: erasure:admin
       Body: { "reason": string }
       Response: { "ok": true }

GET    /api/erasure/re-encryption-jobs?userId=
       Permission: erasure:admin
       Response: { "jobs": ReEncryptionJob[] }
```

### 4.34 Retention

```
GET    /api/retention
       Permission: retention:manage
       Response: { "settings": RetentionSetting[] }

PATCH  /api/retention
       Permission: retention:manage
       Body: { "settings": [{ "category": string, "retentionDays": number }] }
       Response: { "settings": RetentionSetting[] }

GET    /api/retention/platform-floors
       Permission: system:manage-instance
       Response: { "floors": RetentionFloor[] }

PATCH  /api/retention/platform-floors
       Permission: system:manage-instance
       Body: { "floors": [{ "category": string, "minRetentionDays": number }] }
       Response: { "floors": RetentionFloor[] }
```

Hub-scoped: `/api/hubs/:hubId/retention/*`

### 4.35 Firehose (Inference Agent)

```
GET    /api/firehose
       Permission: firehose:read
       Response: { "connections": FirehoseConnection[] }

POST   /api/firehose
       Permission: firehose:manage
       Body: FirehoseConnectionInput
       Response: { "connection": FirehoseConnection }

GET    /api/firehose/:id
       Permission: firehose:read
       Response: { "connection": FirehoseConnection }

PATCH  /api/firehose/:id
       Permission: firehose:manage
       Body: partial FirehoseConnectionInput
       Response: { "connection": FirehoseConnection }

DELETE /api/firehose/:id
       Permission: firehose:manage
       Response: { "ok": true }

POST   /api/firehose/:id/activate
       Permission: firehose:manage
       Response: { "connection": FirehoseConnection }

POST   /api/firehose/:id/pause
       Permission: firehose:manage
       Response: { "connection": FirehoseConnection }

GET    /api/firehose/:id/buffer
       Permission: firehose:read
       Response: { "connectionId": string, "bufferSize": number, "agentRunning": boolean }

DELETE /api/firehose/:id/buffer
       Permission: firehose:manage
       Response: { "purged": number }

POST   /api/firehose/:id/optout
       Permission: firehose:read
       Response: OptoutRecord

DELETE /api/firehose/:id/optout
       Permission: firehose:read
       Response: { "ok": true }

GET    /api/firehose/status
       Permission: firehose:read
       Response: { "statuses": FirehoseStatus[] }
```

Hub-scoped: `/api/hubs/:hubId/firehose/*`

### 4.36 Geocoding

```
POST   /api/geocoding/autocomplete
       Permission: notes:read-own (baseline volunteer access)
       Body: { "query": string, "limit"?: number }
       Response: LocationResult[]

POST   /api/geocoding/geocode
       Permission: notes:read-own
       Body: { "address": string }
       Response: LocationResult | null

POST   /api/geocoding/reverse
       Permission: notes:read-own
       Body: { "lat": number, "lon": number }
       Response: LocationResult | null
```

### 4.37 MLS (Message Layer Security)

Hub-scoped: `/api/hubs/:hubId/mls/*`. Phase 6 feature for hub-state group messaging.

```
POST   /api/hubs/:hubId/mls/commit
       Auth: Required (hub member)
       Body: { "recipientDeviceIds": string[], "payload": base64url }
       Response: 204 No Content

POST   /api/hubs/:hubId/mls/welcome
       Auth: Required (hub member)
       Body: { "recipientDeviceId": string, "payload": base64url }
       Response: 204 No Content

GET    /api/hubs/:hubId/mls/messages?deviceId=
       Auth: Required (hub member)
       Response: { "messages": MlsMessage[] }

POST   /api/hubs/:hubId/mls/key-packages?deviceId=
       Auth: Required (hub member)
       Body: { "keyPackages": base64url[] }
       Response: 204 No Content
```

### 4.38 Additional Endpoints

The following endpoints are also implemented. See `apps/worker/routes/` for full details:

- **`/api/admin/security-events`** — Admin security event log (see Section 4.26)
- **`/api/events/*`** — Deprecated calendar/scheduling events (Sunset: 2026-07-01); migrate to Records API (Section 4.31)
- **`/api/system/*`** — System status and health diagnostics
- **`/api/analytics/*`** — Usage analytics and metrics
- **`/api/account/*`** — Account-level operations
- **`/api/provider-setup/*`** — Telephony/messaging provider configuration
- **`/api/provider-templates/*`** — Provider template management
- **`/api/ring-groups/*`** — Call ring group management
- **`/api/bans/platform/*`** — Platform-level ban management
- **`/api/settings/platform/*`** — Platform-level settings
- **`/api/signal-notification/*`** — Signal notifier integration
- **`/api/hubs/:hubId/onboard/*`** — Hub onboarding flows

---

## 5. Push Notification Protocol

For mobile clients (iOS/Android), push notifications deliver time-sensitive events (incoming calls, new messages) when the app is backgrounded.

### 5.1 Device Registration

```
POST /api/devices/register
Auth: Required
Body: {
  "platform": "ios" | "android",
  "pushToken": string,              // APNs device token or FCM registration token
  "wakeKeyPublic": hex,             // 33-byte compressed secp256k1 pubkey (66 hex chars)
  "ed25519Pubkey"?: hex,            // Phase 6: 32-byte Ed25519 signing pubkey (64 hex chars)
  "x25519Pubkey"?: hex              // Phase 6: 32-byte X25519 encryption pubkey (64 hex chars)
}
Response: 204 No Content (empty body)
```

### 5.2 Two-Tier Encryption

Push notifications use a two-tier encryption scheme to balance security with usability:

**Tier 1 -- Wake Key (No PIN Required)** (`LABEL_PUSH_WAKE`)
- A symmetric "wake key" is generated per-device at registration time.
- It is HPKE-wrapped for the device's X25519 pubkey and stored server-side.
- Push payloads are encrypted with this wake key.
- The app can decrypt the push payload without requiring PIN entry.
- Contains only: notification type, conversation/call ID, and display-safe metadata.

**Tier 2 -- Full Decryption (PIN Required)** (`LABEL_PUSH_FULL`)
- Message content, caller details, and other sensitive data remain encrypted with the device's identity key.
- The app must prompt for PIN unlock to decrypt the full content.
- This mirrors the behavior of the desktop app's locked/unlocked states.

### 5.3 Push Payload Format

```json
{
  "encrypted": "<hex_nonce24_ciphertext>",
  "deviceId": "<uuid>"
}
```

Decrypted content (Tier 1):

```json
{
  "type": "call:ring" | "message:new" | "conversation:assigned" | "report:new",
  "id": "resource_id",
  "preview": "Safe display text (no PII)",
  "timestamp": 1709318400
}
```

### 5.4 VoIP Push (iOS)

For incoming call notifications on iOS, a VoIP push is sent via APNs with a 30-second deadline. The app MUST:

1. Report a new incoming call to CallKit within 30 seconds.
2. Decrypt the wake-key-encrypted payload to get the call ID.
3. Display the CallKit incoming call UI.
4. If the user answers, prompt for PIN to unlock the identity key.
5. Use the identity key to authenticate and answer the call via REST API.

### 5.5 Hub Routing for Push Notifications

The `hubId` field in a decrypted wake payload identifies which hub the notification belongs to. Clients must dispatch the notification to the correct hub handler regardless of which hub is currently active in the UI.

**Routing rules:**
- `incoming_call`: iOS: call `linphoneService.handleVoipPush(callId:hubId:)`. Android: call `linphoneService.storePendingCallHub(callId, hubId)`. Do NOT switch the active hub context.
- All other types (`shift_reminder`, `announcement`, `call_ended`): Store `hubId` in notification extras for navigation on tap. Do NOT switch the active hub context.

**Active hub switching is permitted only when:**
1. The user explicitly taps a delivered notification (notification tap callback).
2. The app is unlocked and the user initiates answering a call (the `handleIncomingCall` app-unlocked path).

This constraint preserves the multi-hub axiom: a user browsing Hub A must not have their context silently switched to Hub B by a background notification.

---

## 6. Device Provisioning Protocol

New devices can be linked to an existing account using a Signal-style provisioning protocol with ephemeral X25519 ECDH key exchange and Short Authentication String (SAS) verification.

> **Migration Note (v2.0):** The server currently accepts the `encryptedNsec` field for backward compatibility with pre-Phase-6 clients. The protocol described below reflects the Phase 6 target using per-device keypairs. New implementations MUST implement the Phase 6 protocol. The server field is named `encryptedNsec` but carries the Phase 6 device key bundle payload described here.

### 6.1 Protocol Flow

```
New Device                          Server                     Primary Device
-----------                         ------                     ---------------
1. Generate ephemeral keypair (X25519):
   eSK, ePK = X25519.generateKey()
   // eSK: 32 bytes (private), ePK: 32 bytes (public)

2. POST /api/provision/rooms
   { ephemeralPubkey: hex(ePK) }
                                    Creates room with
                                    roomId + token
   <-- { roomId, token }

3. Display QR code:
   JSON.stringify({ r: roomId, t: token })
   (or short code: roomId[0..8])

4. Poll: GET /api/provision/rooms/:id
   ?token=<token>
                                                               Scans QR / enters code

                                                        5. GET /api/provision/rooms/:id
                                                           ?token=<token>
                                                           <-- { ephemeralPubkey: hex(ePK) }

                                                        6. Compute shared secret (X25519):
                                                           shared = X25519(primarySK, ePK)
                                                           // shared: 32 bytes (raw X25519 output)
                                                           // X25519 is symmetric: X25519(eSK, primaryPK)
                                                           //   = X25519(primarySK, ePK)

                                                        7. Compute SAS:
                                                           sasBytes = HKDF(SHA-256, shared,
                                                             salt=UTF-8("llamenos:sas"),
                                                             info=UTF-8("llamenos:provisioning-sas"),
                                                             length=4)
                                                           num = (sasBytes[0]<<24 | sasBytes[1]<<16 |
                                                                  sasBytes[2]<<8  | sasBytes[3]) >>> 0
                                                           code = (num % 1000000).padStart(6, '0')
                                                           Display: "XXX XXX"

8. Also compute SAS (new device side):
   shared = X25519(eSK, primaryPK)
   // Same X25519 shared secret → same HKDF → same SAS
   Same HKDF derivation → same code
   Display: "XXX XXX"

9. User visually compares                                    User visually compares
   both codes match? -->                                     <-- both codes match?

                                                        10. Derive provisioning key via HKDF:
                                                            prov_key = HKDF(SHA-256, shared,
                                                              salt=UTF-8("llamenos:provisioning:v1"),
                                                              info=UTF-8("llamenos:provisioning:v1"),
                                                              length=32)
                                                            // Uses LABEL_PROVISIONING_SALT

                                                        11. Build device key bundle:
                                                            bundle = JSON.stringify({
                                                              signingPubkey: hex(primary_ed25519_pubkey),
                                                              encPubkey: hex(primary_x25519_pubkey),
                                                              pukEncrypted: <HPKE-wrapped PUK seed for
                                                                             new device's X25519 key>
                                                            })

                                                        12. Encrypt device key bundle:
                                                            iv = random(12)
                                                            ct_with_tag = AES-256-GCM.encrypt(
                                                              key = prov_key,
                                                              iv  = iv,
                                                              message = UTF-8(bundle)
                                                            )
                                                            encryptedPayload = hex(iv || ct_with_tag)

                                                        13. POST /api/provision/rooms/:id/payload
                                                            Auth: Required (primary device)
                                                            {
                                                              token,
                                                              encryptedNsec: encryptedPayload,
                                                              // Note: field named "encryptedNsec" for
                                                              // backward compat; payload is device bundle
                                                              primaryPubkey: hex(primary_ed25519_pubkey)
                                                            }

14. Poll returns status: "ready"
    { encryptedNsec: encryptedPayload, primaryPubkey }

15. Derive provisioning key (same as step 10):
    shared = X25519(eSK, primaryPK)
    prov_key = HKDF(SHA-256, shared,
      salt=UTF-8("llamenos:provisioning:v1"),
      info=UTF-8("llamenos:provisioning:v1"),
      length=32)

16. Decrypt device key bundle:
    data = hex_to_bytes(encryptedPayload)
    iv   = data[0..12]
    ct   = data[12..]
    bundle_json = UTF-8_decode(AES-256-GCM.decrypt(prov_key, iv, ct))
    bundle = JSON.parse(bundle_json)

17. New device now has:
    - Primary device's signing + encryption pubkeys (for sigchain verification)
    - PUK (Per-User Key) encrypted for new device's X25519 key
    New device decrypts PUK using its own X25519 secret key via HPKE.Open
    with label LABEL_PUK_WRAP_TO_DEVICE.

18. New device generates its own Ed25519 + X25519 keypairs (Section 2.11)
    and registers via sigchain with primary device's authorization.
```

#### Server Implementation

Cross-reference: `apps/worker/routes/provisioning.ts`, `apps/worker/services/identity.ts`.

The server stores only the ephemeral pubkey and encrypted payload — it cannot decrypt the payload. The `encryptedNsec` field in the server API carries the Phase 6 device key bundle described above.

### 6.2 QR Code Format

```json
{"r":"<roomId>","t":"<token>"}
```

Compact JSON. The `r` and `t` keys are shortened for QR code density.

### 6.3 Short Code (Manual Entry)

For users who cannot scan a QR code:

```
short_code = roomId[0..8].toUpperCase()
// e.g., "A1B2C3D4"
```

### 6.4 SAS Display Format

```
"XXX XXX"
// e.g., "847 293"
// Two groups of three digits separated by a space
```

The SAS code is derived deterministically from the ECDH shared secret. Both devices compute it independently. If the codes match, no man-in-the-middle attack is present.

### 6.5 Room Lifecycle

- Rooms expire after a configurable timeout (typically 5 minutes).
- Status transitions: `waiting` -> `ready` -> (consumed)
- Polling returns `expired` (status 404 or 410) when the room has timed out.

---

## 7. Permission Model

Llamenos uses Permission-Based Access Control (PBAC). Users are assigned roles, and each role is a named bundle of permissions. Effective permissions are the union of all assigned roles.

### 7.1 Permission Format

Permissions are colon-separated strings: `domain:action`.

```
calls:answer
notes:read-own
settings:manage-telephony
system:manage-roles
```

### 7.2 Wildcard Support

| Pattern | Meaning |
|---------|---------|
| `*` | Global wildcard -- grants ALL permissions |
| `domain:*` | Domain wildcard -- grants all actions in domain (e.g., `calls:*` grants `calls:answer`, `calls:read-active`, etc.) |

### 7.3 Permission Resolution

```
permissionGranted(granted_permissions[], required_permission):
  1. If granted includes "*" -> true
  2. If granted includes exact match -> true
  3. domain = required_permission.split(":")[0]
     If granted includes "domain:*" -> true
  4. Return false
```

For multiple roles:

```
resolvePermissions(role_ids[], all_role_definitions[]):
  permissions = Set()
  for each role_id in role_ids:
    role = find role by id
    for each permission in role.permissions:
      permissions.add(permission)
  return Array.from(permissions)
```

### 7.4 Permission Catalog

#### Calls

| Permission | Description |
|------------|-------------|
| `calls:answer` | Answer incoming calls |
| `calls:read-active` | See active calls (caller info redacted) |
| `calls:read-active-full` | See active calls with full caller info |
| `calls:read-history` | View call history |
| `calls:read-presence` | View volunteer presence |
| `calls:read-recording` | Listen to call recordings |
| `calls:debug` | Debug call state |

#### Notes

| Permission | Description |
|------------|-------------|
| `notes:create` | Create call notes |
| `notes:read-own` | Read own notes |
| `notes:read-all` | Read all notes |
| `notes:read-assigned` | Read notes from assigned volunteers |
| `notes:update-own` | Update own notes |

#### Reports

| Permission | Description |
|------------|-------------|
| `reports:create` | Submit reports |
| `reports:read-own` | Read own reports |
| `reports:read-all` | Read all reports |
| `reports:read-assigned` | Read assigned reports |
| `reports:assign` | Assign reports to reviewers/volunteers |
| `reports:update` | Update report status |
| `reports:send-message-own` | Send messages in own reports |
| `reports:send-message` | Send messages in any report |

#### Conversations

| Permission | Description |
|------------|-------------|
| `conversations:read-assigned` | Read assigned + waiting conversations |
| `conversations:read-all` | Read all conversations |
| `conversations:claim` | Claim a waiting conversation |
| `conversations:claim-sms` | Claim SMS conversations |
| `conversations:claim-whatsapp` | Claim WhatsApp conversations |
| `conversations:claim-signal` | Claim Signal conversations |
| `conversations:claim-rcs` | Claim RCS conversations |
| `conversations:claim-web` | Claim web conversations |
| `conversations:claim-any` | Claim any channel (bypass restrictions) |
| `conversations:send` | Send messages in assigned conversations |
| `conversations:send-any` | Send messages in any conversation |
| `conversations:update` | Reassign/close/reopen conversations |

#### Users

| Permission | Description |
|------------|-------------|
| `users:read` | List/view user profiles |
| `users:create` | Create new users |
| `users:update` | Update user profiles |
| `users:delete` | Deactivate/delete users |
| `users:manage-roles` | Assign/change user roles |
| `users:read-cases` | View cases assigned to a user |
| `users:read-metrics` | View user workload metrics |
| `users:manage-devices` | Manage user devices and sigchain |

#### Shifts

| Permission | Description |
|------------|-------------|
| `shifts:read-own` | Check own shift status |
| `shifts:read` | View all shifts |
| `shifts:create` | Create shifts |
| `shifts:update` | Modify shifts |
| `shifts:delete` | Delete shifts |
| `shifts:manage-fallback` | Manage fallback ring group |

#### Bans

| Permission | Description |
|------------|-------------|
| `bans:report` | Report/flag a number |
| `bans:read` | View ban list |
| `bans:create` | Ban numbers |
| `bans:bulk-create` | Bulk ban import |
| `bans:delete` | Remove bans |

#### Invites

| Permission | Description |
|------------|-------------|
| `invites:read` | View pending invites |
| `invites:create` | Create invite codes |
| `invites:revoke` | Revoke invite codes |

#### Settings

| Permission | Description |
|------------|-------------|
| `settings:read` | View settings |
| `settings:manage` | Modify all settings |
| `settings:manage-telephony` | Modify telephony provider |
| `settings:manage-messaging` | Modify messaging channels |
| `settings:manage-spam` | Modify spam settings |
| `settings:manage-ivr` | Modify IVR/language settings |
| `settings:manage-fields` | Modify custom fields |
| `settings:manage-transcription` | Modify transcription settings |

#### Audit

| Permission | Description |
|------------|-------------|
| `audit:read` | View audit log |

#### Blasts

| Permission | Description |
|------------|-------------|
| `blasts:read` | View blast history |
| `blasts:send` | Send blasts |
| `blasts:manage` | Manage subscriber lists and templates |
| `blasts:schedule` | Schedule future blasts |

#### Files

| Permission | Description |
|------------|-------------|
| `files:upload` | Upload files |
| `files:download-own` | Download own/authorized files |
| `files:download-all` | Download any file |
| `files:share` | Re-encrypt/share files with others |

#### System (Super-Admin Only)

| Permission | Description |
|------------|-------------|
| `system:manage-roles` | Create/edit/delete custom roles |
| `system:manage-hubs` | Create/manage hubs |
| `system:manage-instance` | Instance-level settings |

### 7.5 Default Roles

#### Super Admin (`role-super-admin`)

```
Permissions: ["*"]
System role: true (cannot be modified or deleted)
```

Full system access. Creates hubs, manages all settings and users.

#### Hub Admin (`role-hub-admin`)

```
Permissions: [
  "users:*", "shifts:*", "settings:*", "audit:read",
  "bans:*", "invites:*", "notes:read-all", "notes:create", "notes:update-own",
  "reports:*", "conversations:*", "calls:*", "blasts:*", "files:*"
]
```

Full control within assigned hub(s). Manages users, shifts, settings.

#### Reviewer (`role-reviewer`)

```
Permissions: [
  "notes:read-assigned", "reports:read-assigned", "reports:assign",
  "reports:update", "reports:send-message",
  "conversations:read-assigned", "conversations:send",
  "shifts:read-own", "files:download-own", "files:upload"
]
```

Reviews notes and reports from assigned volunteers or shifts.

#### Volunteer (`role-volunteer`)

```
Permissions: [
  "calls:answer", "calls:read-active",
  "notes:create", "notes:read-own", "notes:update-own",
  "conversations:claim", "conversations:send", "conversations:read-assigned",
  "conversations:claim-sms", "conversations:claim-whatsapp",
  "conversations:claim-signal", "conversations:claim-rcs", "conversations:claim-web",
  "shifts:read-own", "bans:report",
  "reports:read-assigned", "reports:send-message",
  "files:upload", "files:download-own"
]
```

Answers calls, writes notes, handles assigned conversations.

#### Reporter (`role-reporter`)

```
Permissions: [
  "reports:create", "reports:read-own", "reports:send-message-own",
  "files:upload", "files:download-own"
]
```

Submits reports and tracks their own submissions.

### 7.6 Hub-Scoped Permissions

Users can have different roles in different hubs. Permission resolution checks both global roles and hub-specific roles:

```
hasHubPermission(global_roles, hub_roles, all_role_defs, hub_id, permission):
  1. global_perms = resolvePermissions(global_roles, all_role_defs)
     If permissionGranted(global_perms, permission) -> true  (super-admin bypasses)
  2. assignment = hub_roles.find(hr => hr.hubId === hub_id)
     If no assignment -> false
  3. hub_perms = resolvePermissions(assignment.roleIds, all_role_defs)
     Return permissionGranted(hub_perms, permission)
```

### 7.7 Channel Claim Permissions

Claiming a conversation requires both the general `conversations:claim` permission and a channel-specific permission:

| Channel | Required Permission |
|---------|-------------------|
| SMS | `conversations:claim-sms` |
| WhatsApp | `conversations:claim-whatsapp` |
| Signal | `conversations:claim-signal` |
| RCS | `conversations:claim-rcs` |
| Web | `conversations:claim-web` |
| Any (bypass) | `conversations:claim-any` |

---

## Appendix A: Library Dependencies for Implementors

Clients implementing this protocol need the following cryptographic capabilities:

| Operation | Library (JS reference) | Algorithm |
|-----------|----------------------|-----------|
| Key generation | `@noble/curves` | secp256k1, Ed25519, X25519 |
| Schnorr signatures | `@noble/curves/secp256k1` | BIP-340 |
| ECDH | `@noble/curves/secp256k1` | secp256k1 |
| SHA-256 | `@noble/hashes/sha2` | SHA-256 |
| HMAC | `@noble/hashes/hmac` | HMAC-SHA256 |
| HKDF | `@noble/hashes/hkdf` | HKDF-SHA256 |
| AEAD | `@noble/ciphers/aes` | AES-256-GCM |
| Argon2id | `argon2` (Rust) / `@noble/hashes/argon2` (JS) | Argon2id (64 MB, 3 iter, 4 lanes) |
| PBKDF2 | Web Crypto API | PBKDF2-SHA256 (legacy backup/Stronghold only) |
| Encoding | `@noble/hashes` | hex, utf8 |

**Gotchas for non-JS implementations:**
- `@noble/ciphers` and `@noble/hashes` require `.js` extension in import paths (JS-specific).
- `schnorr` is a separate named export from secp256k1 (not the default).
- WebSocket pubkeys are x-only (32 bytes) -- prepend `0x02` for ECDH compressed format.
- `secp256k1.getSharedSecret()` returns 33 bytes; extract x-coordinate with `[1..33]`.
- AES-256-GCM uses a 12-byte IV (nonce), not 24-byte.
- The GCM authentication tag is 16 bytes, appended to the ciphertext by the AEAD implementation.

## Appendix B: Type Definitions Reference

### NotePayload

```typescript
interface NotePayload {
  text: string
  fields?: Record<string, string | number | boolean>
}
```

### CustomFieldDefinition

```typescript
interface CustomFieldDefinition {
  id: string                // UUID
  name: string              // machine-readable key (e.g., "severity")
  label: string             // display label (e.g., "Severity Rating")
  type: 'text' | 'number' | 'select' | 'checkbox' | 'textarea'
  required: boolean
  options?: string[]         // for 'select' type
  validation?: {
    minLength?: number       // text/textarea
    maxLength?: number       // text/textarea
    min?: number             // number
    max?: number             // number
  }
  visibleToVolunteers: boolean
  editableByVolunteers: boolean
  context: 'call-notes' | 'reports' | 'both'
  allowFileUpload?: boolean
  acceptedFileTypes?: string[]
  order: number
  createdAt: string
}
```

### TelephonyProviderConfig

```typescript
interface TelephonyProviderConfig {
  type: 'twilio' | 'signalwire' | 'vonage' | 'plivo' | 'asterisk' | 'telnyx' | 'bandwidth' | 'freeswitch'
  phoneNumber: string        // E.164
  accountSid?: string
  authToken?: string
  signalwireSpace?: string
  apiKey?: string
  apiSecret?: string
  applicationId?: string
  privateKey?: string        // Vonage PEM
  authId?: string
  ariUrl?: string
  ariUsername?: string
  ariPassword?: string
  bridgeCallbackUrl?: string
  webrtcEnabled?: boolean
  apiKeySid?: string
  apiKeySecret?: string
  twimlAppSid?: string
}
```

### Hub

```typescript
interface Hub {
  id: string
  name: string
  slug: string
  description?: string
  status: 'active' | 'suspended' | 'archived'
  phoneNumber?: string
  createdBy: string
  createdAt: string
  updatedAt: string
}
```

### AuditLogEntry

```typescript
interface AuditLogEntry {
  id: string
  event: string
  actorPubkey: string
  details: Record<string, unknown>
  createdAt: string
  previousEntryHash?: string   // SHA-256 chain link
  entryHash?: string           // SHA-256 of this entry
}
```

---

## Appendix C: Legacy Encryption (pre-v2 ECIES)

> **Historical Reference Only.** This appendix documents the encryption primitives used before v2.0 (2026-Q1). They are retained so implementors can read data encrypted with the old scheme during migration. **DO NOT implement new encryption using these algorithms.**

### C.1 ECIES Key Wrapping (Replaced by Section 2.2 HPKE)

ECIES was the key-wrapping primitive in v1. It used secp256k1 ECDH + XChaCha20-Poly1305 instead of X25519 HPKE + AES-256-GCM.

See Section 2.2.1 for the full ECIES algorithm specification (retained in the main body for backward-compat read path).

### C.2 nsec-per-User Key Storage (Replaced by Section 2.11)

v1 stored a single secp256k1 secret key (nsec, bech32-encoded) per user, PIN-encrypted with PBKDF2-SHA256 + XChaCha20-Poly1305. See Section 2.6 (marked Legacy) for the full algorithm.

### C.3 Provisioning (secp256k1 ECDH + nsec Transfer)

v1 provisioning used secp256k1 ECDH for the ephemeral key exchange and transferred the nsec directly (XChaCha20-Poly1305 encrypted). The SAS derivation used the compressed X coordinate (`sharedX = shared[1..33]`) instead of the raw 32-byte X25519 output. See the migration note in Section 6 for context.

### C.4 XChaCha20-Poly1305 Wire Format (v1 encryptedContent)

v1 content was encrypted with XChaCha20-Poly1305:

```
Offset  Length    Content
------  ------    -------
0       24        XChaCha20-Poly1305 nonce (random, 24 bytes)
24      variable  Ciphertext + 16-byte Poly1305 authentication tag
```

The entire byte sequence was hex-encoded. v2 uses AES-256-GCM with a 12-byte IV (Section 2.3).
