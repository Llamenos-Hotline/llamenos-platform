# Llamenos Protocol: Cryptographic operations: call records and key storage

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 2.5 Call Record Metadata Encryption

Active calls remain as plaintext (routing necessity). When a call completes, sensitive metadata is encrypted into an envelope and stored permanently.

#### What Gets Encrypted

```typescript
interface CallRecordMetadata {
  answeredBy: string | null   // Volunteer pubkey
  callerNumber: string        // caller's E.164 number (never a hash — see below)
}
```

While the call is live the server holds the number only as `active_calls.caller_number_sealed`: AES-256-GCM under a key HKDF-derived from `SERVER_KEK` (info = `LABEL_CALLER_NUMBER_SEAL`, AAD = `label:callId`), so a volunteer can ban the caller without seeing it. It is opened once, into this envelope, and the active row is deleted in the same transaction (end or stale-call archive). No hash of the number is kept on the server (see §2.10 Ban Hashing).

#### What Stays in Plaintext

```
startedAt, endedAt, duration, status, hasTranscription,
hasVoicemail, hasRecording, recordingSid
```

No part of the caller's number is on this list: the last four digits are not stored, sent, or displayed (#2262). `callRecordResponseSchema` has no field for them. A client titles a call by its hub, its times, its outcome and, for an admin whose envelope opens, the decrypted number.

`hasRecording` is true only once the server holds its OWN sealed copy of the call's recording (see §4.8 "Call recording storage"); `recordingSid` is never used to reach the provider for playback.

#### Algorithm

Same envelope pattern as per-message encryption but using `LABEL_CALL_META`. Every call belongs to a hub (#2460), and when it ends the server seals its record, per call, to the union (deduplicated) of (§2.4.2):

- the hub's `admin` reader set, plus the transitional instance key `ADMIN_DECRYPTION_PUBKEY` (in no reader set);
- the hub's `call-history` reader set (holders of `calls:read-history`, D2);
- the `call-history-own` subject readers: the answering volunteer's own devices, when they hold `calls:read-own-history` in the hub (D3, #1342). No other volunteer's.

The wire field keeps its name, `adminEnvelopes`; each envelope names the key it is sealed to, so a reader finds its own by `pubkey`. Readers are fixed when the call ends. Super-admins are never recipients (the admin invariant in §4.15 is the one definition of who an admin is and who reads):

```
encryptCallRecordForStorage(metadata_object, admin_x25519_pubkey_hexes[]):

  1. record_key = random(32)
  2. iv = random(12)
  3. ciphertext_with_tag = AES-256-GCM.encrypt(
       key     = record_key,
       iv      = iv,
       aad     = empty,
       message = UTF-8(JSON.stringify(metadata_object))
     )
  4. encrypted_content = hex(iv || ciphertext_with_tag)
  5. admin_envelopes = admin_x25519_pubkey_hexes.map(pk => {
       sealed = HPKE.Seal(
         recipientPk = hex_to_bytes(pk),
         plaintext   = record_key,
         info        = UTF-8("llamenos:call-meta"),
         aad         = empty
       )
       return {
         pubkey: pk,
         enc:    hex(sealed[0..32]),
         ct:     hex(sealed[32..])
       }
     })
  6. Return { encryptedContent, adminEnvelopes }
```

Decryption: `HPKE.Open(device_x25519_secret_key, enc_bytes, ct_bytes, info=UTF-8("llamenos:call-meta"), aad=empty)` returns `record_key`. Then AES-256-GCM decrypt using `iv = data[0..12]`, `aad = empty`. Call records are stored records — the same no-AAD format as §2.4.

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

