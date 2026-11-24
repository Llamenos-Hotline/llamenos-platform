# Llamenos Protocol: Cryptographic operations: labels and envelopes

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

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
| `LABEL_DEVICE_PROVISION` | `llamenos:device-provision` | Device provisioning ECDH shared key derivation (HKDF info) |

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
| `LABEL_CONTACT_ID` | `llamenos:contact-identifier` | Contact identifier encryption |
| `LABEL_CONTACT_PROFILE` | `llamenos:contact-profile` | Contact profile data encryption |
| `LABEL_CASE_SUMMARY` | `llamenos:case-summary` | Case summary encryption |
| `LABEL_CASE_FIELDS` | `llamenos:case-fields` | Case custom field encryption |
| `LABEL_CASE_COMMENT` | `llamenos:case-comment` | Case comment (timeline interaction) encryption — §2.18 |

#### HMAC Domain Separation

| Constant | Value | Purpose |
|----------|-------|---------|
| `HMAC_PHONE_PREFIX` | `llamenos:phone:` | Phone number hashing prefix |
| `HMAC_IP_PREFIX` | `llamenos:ip:` | IP address hashing prefix |
| `HMAC_BAN_PREFIX` | `llamenos:ban:` | Ban-list hashing prefix (§2.10 Ban Hashing) |
| `HMAC_MESSAGING_CONTACT_PREFIX` | `llamenos:messaging-contact:` | Messaging thread hashing prefix (§2.10 Messaging Thread Hashing) |
| `HMAC_KEYID_PREFIX` | `llamenos:keyid:` | Key identification hashing prefix |
| `HMAC_SUBSCRIBER` | `llamenos:subscriber` | Retired (#2261): subscribers are hashed under `HMAC_MESSAGING_CONTACT_PREFIX`; the slot stays so the registry keeps its indices |
| `HMAC_PREFERENCE_TOKEN` | `llamenos:preference-token` | Preference token HMAC key |

#### Recovery / Backup

| Constant | Value | Purpose |
|----------|-------|---------|
| `RECOVERY_SALT` | `llamenos:recovery` | Recovery key PBKDF2 fallback salt (legacy) |
| `LABEL_BACKUP` | `llamenos:backup` | Generic backup encryption |

#### Server WebSocket Identity

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_SERVER_NOSTR_KEY` | `llamenos:server-nostr-key` | HKDF salt for server WebSocket keypair derivation |
| `LABEL_SERVER_NOSTR_KEY_INFO` | `llamenos:server-nostr-key:v1` | HKDF info parameter (versioned for rotation) |

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

