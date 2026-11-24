# Crypto Protocol Alignment: Ed25519/X25519 + HPKE + MLS

**Date**: 2026-04-27
**Status**: Draft — partly superseded (see below)

> **Superseded in part (2026-11-24, part of #2973):** MLS (§8–§9) is retired in favour of the reader-group model (#2961). SFrame (§10) is planned for app-to-app calls only, keyed per call; it is not implemented in any client. Hotline calls are hop-by-hop DTLS-SRTP, so the SFrame-over-SRTP/DTLS decision (§8 of the rationale) applies to app-to-app calls only. Sections below are kept as the original design record.
**Priority**: Critical — foundational crypto architecture for all platforms

---

## Problem Statement

The current `packages/crypto` crate is built on secp256k1 (k256) with a Nostr-derived identity model (nsec/npub, BIP-340 Schnorr). This creates friction:

1. **Curve mismatch**: The v1 prototype (llamenos-platform) already migrated to Ed25519/X25519 with HPKE. The production crate still uses k256.
2. **No forward secrecy for group operations**: Hub key distribution uses static ECIES wrapping — no ratcheting, no PCS (post-compromise security).
3. **No MLS**: Real-time voice E2EE and group messaging require a scalable group key agreement protocol. Hand-rolling is unacceptable.
4. **Identity coupling**: The nsec/npub model ties identity to a single key. The v1 prototype already implements device-based identity with sigchains. The production crate must match.
5. **PQ vulnerability**: secp256k1 offers no path to hybrid post-quantum without a full rewrite anyway.

Since the app is pre-production with zero deployed users, this is a clean break — no migration path needed.

---

## Architecture Overview

### 1. Primitive Selection

| Purpose           | Primitive                                              | Crate/Library                                              |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------------- |
| Signing           | Ed25519                                                | `ed25519-dalek` (batch verify, `Signer`/`Verifier` traits) |
| Key agreement     | X25519                                                 | `x25519-dalek`                                             |
| HPKE envelope     | DHKEM(X25519, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM | `hpke` (rozbb)                                             |
| Symmetric         | AES-256-GCM                                            | `aes-gcm` (RustCrypto)                                     |
| KDF               | HKDF-SHA256                                            | `hkdf` + `sha2`                                            |
| Subkey derivation | HMAC-SHA256                                            | `hmac` + `sha2`                                            |
| Hash-chain        | SHA-256                                                | `sha2`                                                     |
| MLS               | MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519           | `openmls` + `openmls_rust_crypto`                          |
| PQ readiness      | ML-KEM-1024 (slot)                                     | `ml-kem` (RustCrypto, feature-gated)                       |

### 2. Per-Device Keys

Each device generates two keypairs on first launch:

- **Ed25519 signing keypair**: Used for sigchain entries, auth tokens, MLS leaf credentials
- **X25519 encryption keypair**: Used for HPKE decapsulation (PUK seed wrapping, direct messages)

Storage by platform:

- **Desktop (Tauri)**: Tauri Stronghold (encrypted vault, file-backed)
- **iOS**: Keychain Services (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, Secure Enclave when available)
- **Android**: AndroidKeyStore (hardware-backed where available) with EncryptedSharedPreferences fallback

The device keypair is **never exported**. A lost device means its keys are revoked via sigchain, not recovered.

### 3. Per-User Key (PUK)

The PUK provides a stable encryption identity across devices:

- **Seed**: 32 random bytes (NOT derived from any device key)
- **Generation**: Monotonically incrementing integer (starts at 1)
- **Subkey derivation** (HMAC-SHA256):
  - `sign = HMAC(seed, "llamenos:puk:sign:v1" || BE32(gen))` → Ed25519 signing seed
  - `dh = HMAC(seed, "llamenos:puk:dh:v1" || BE32(gen))` → X25519 encryption seed
  - `secretbox = HMAC(seed, "llamenos:puk:secretbox:v1" || BE32(gen))` → AES-256-GCM key (CLKR chain)

**Distribution**: PUK seed is HPKE-sealed individually to each device's X25519 public key.

**Rotation (CLKR)**: On device removal or periodic rotation:

1. Generate new seed, increment generation
2. AES-GCM encrypt old seed under new generation's secretbox key (chain link)
3. HPKE-seal new seed to each remaining device
4. Publish `puk_rotate` sigchain entry

**Generation walk**: To decrypt historical content, walk the CLKR chain backwards using each generation's secretbox key.

### 4. Sigchain

An append-only, hash-chained log of identity operations per user:

```
SigchainLink {
  id: UUID,
  seq: u64,                    // monotonic sequence number
  prevHash: hex | null,        // SHA-256 of previous link (null for first)
  entryHash: hex,              // SHA-256(canonical(payload + prevHash + seq + timestamp))
  signerDeviceId: UUID,
  signerPubkey: hex,           // Ed25519 pubkey of signing device
  signature: hex,              // Ed25519 signature over entryHash
  timestamp: ISO-8601,
  payload: SigchainPayload,
}
```

**Payload types**:

- `user_init` — first entry, bootstraps device set
- `device_add` — add a new device (signed by existing device)
- `device_remove` — revoke a device (triggers PUK rotation)
- `puk_rotate` — record new PUK generation + CLKR chain link
- `hub_membership_change` — record joining/leaving a hub
- `mls_key_package_publish` — announce new MLS key packages
- `master_signing_update` — rotate cross-device signing key
- `device_cross_sign` — mutual attestation between devices
- `recovery_initiated` / `recovery_completed` — recovery flow markers

**Verification**: Any client fetching a user's sigchain replays it from genesis, verifying:

1. Hash-chain integrity (prevHash linkage)
2. Entry hash recomputation
3. Ed25519 signature validity
4. Semantic rules (signer must be in verified device set, generation monotonicity, etc.)

### 5. HPKE Envelope Format

Wire format for all encrypted fields (notes, messages, file keys, PUK seeds, hub PTK):

```json
{
  "v": 3,
  "labelId": <u8>,
  "enc": "<base64url — HPKE encapsulated key>",
  "ct": "<base64url — AEAD ciphertext>"
}
```

- `v: 3` — version tag (v1 was secp256k1 ECIES, v2 was transitional, v3 is HPKE)
- `labelId` — numeric ID mapping to a `CryptoLabel` constant (compact wire representation)
- `enc` — 32 bytes: X25519 ephemeral public key from HPKE encaps
- `ct` — AEAD ciphertext (AES-256-GCM with 12-byte nonce prepended by HPKE)

**HPKE parameters**:

- Mode: Base (anonymous sender, no PSK)
- KEM: DHKEM(X25519, HKDF-SHA256) — KEM ID 0x0020
- KDF: HKDF-SHA256 — KDF ID 0x0001
- AEAD: AES-256-GCM — AEAD ID 0x0002
- `info`: UTF-8 encoded label string (e.g., `"llamenos:note-key"`)
- `aad`: `"${label}:${recordId}:${fieldName}"` — binds ciphertext to its storage location

### 6. Label Enforcement at Decrypt (Albrecht Defense)

Before calling HPKE open, the recipient MUST:

1. Parse the envelope and check `v === 3`
2. Resolve `labelId` to a `CryptoLabel` constant
3. Compare resolved label against the caller's expected label
4. If mismatch → reject immediately (no HPKE call)
5. Pass the label as HPKE `info` — any tampering fails decapsulation

This prevents cross-domain swap attacks where an attacker substitutes an envelope from one column into another.

### 7. items_key Indirection

For note/message/file encryption, a two-layer key hierarchy:

```
Hub PTK (per-time-key, from MLS epoch or standalone rotation)
  └── items_key (per-member, wrapped by hub PTK via HPKE)
        └── content_key (per-note/message, random 32 bytes, wrapped by items_key via HPKE)
              └── plaintext
```

Benefits:

- Rotating hub PTK does NOT require re-encrypting all content
- items_key scopes access per-member (e.g., volunteer sees own notes only)
- Forward secrecy: deleting a content_key makes that specific item irrecoverable

### 8. MLS via OpenMLS

Each hub is an MLS group. Each device is a leaf in the ratchet tree.

**Ciphersuite**: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`

**Operations**:

- `create_group` — hub creator initializes the MLS group
- `add_member` — admin adds a user's device(s) via Welcome message
- `remove_member` — admin removes device(s), triggers Update commit
- `update` — periodic self-update for PCS
- `commit` — apply pending proposals
- `export_secret` — derive application keys (hub PTK, SFrame base key)

**Key packages**: Each device pre-publishes 100 key packages to the server. Packages are consumed on Add and replenished periodically.

**Server role**: The server is an untrusted relay. It stores MLS messages (commits, proposals, welcomes) and fans them out. It CANNOT read group state or derive application secrets.

**Scaling**: TreeKEM provides O(log n) update cost. For a hub with 50 volunteers + 5 admins, tree depth is ~6 — each commit is ~6 HPKE operations.

### 9. CLKR Coexistence

MLS provides group key agreement but requires all members to process commits in order. For offline-first scenarios:

- **MLS epoch key** is the primary hub PTK source when all members are online
- **CLKR (Closed-Loop Key Rotation)** provides a standalone fallback:
  - Hub PTK sealed to each member's PUK DH key via HPKE
  - Rotation announced via sigchain-like hub operation log
  - Used during: offline message delivery, MLS group rekey in progress, migration period

During the migration period (Phase 1 → Phase 3), CLKR is the sole key distribution mechanism. MLS is introduced in Phase 3.

### 10. SFrame Voice E2EE

Real-time voice encryption using the SFrame (Secure Frame) format:

1. MLS group derives `exporter_secret` for the current epoch
2. Per-call: `sframe_base_key = HKDF-Expand(exporter_secret, "llamenos:sframe:" + call_id, 32)`
3. Each participant derives their send key: `send_key = HKDF-Expand(sframe_base_key, participant_index, 32)`
4. Audio frames encrypted with AES-128-CTR + HMAC-SHA256 (SFrame cipher)

**Fallback** (pre-MLS): Hub PTK + HKDF derivation for per-call keys. Same SFrame format, different key source.

### 11. Post-Quantum Readiness

A hybrid KEM slot allows future PQ upgrade without protocol version bump:

- Envelope `v: 4` activates hybrid mode
- KEM: X25519 + ML-KEM-1024, combined via HKDF:
  ```
  shared_secret = HKDF-Extract(
    salt: X25519_shared,
    ikm: ML-KEM_shared || X25519_shared
  )
  ```
- `enc` field grows to accommodate ML-KEM ciphertext (~1568 bytes)
- Feature-gated behind `pq` feature in Cargo.toml — not compiled by default

### 12. UniFFI Surface

The crate exposes these types and functions to Swift/Kotlin via UniFFI:

```rust
// ---- Types ----
pub struct DeviceKeyState {
    pub device_id: String,
    pub signing_pubkey_hex: String,
    pub encryption_pubkey_hex: String,
}

pub struct PukState {
    pub generation: u32,
    pub sign_pubkey_hex: String,
    pub dh_pubkey_hex: String,
}

pub struct HpkeEnvelope {
    pub v: u8,
    pub label_id: u8,
    pub enc: String,   // base64url
    pub ct: String,    // base64url
}

pub struct SigchainLink {
    pub id: String,
    pub seq: u64,
    pub prev_hash: Option<String>,
    pub entry_hash: String,
    pub signer_device_id: String,
    pub signer_pubkey: String,
    pub signature: String,
    pub timestamp: String,
    pub payload_json: String,
}

pub struct MlsGroupState {
    pub group_id: Vec<u8>,
    pub epoch: u64,
    pub member_count: u32,
}

pub struct KeyPackageBundle {
    pub key_package_bytes: Vec<u8>,
    pub key_package_ref: Vec<u8>,
}

// ---- Operations ----

// Device key management
fn generate_device_keys(pin: String) -> Result<DeviceKeyState, CryptoError>;
fn unlock_device_keys(encrypted_blob: Vec<u8>, pin: String) -> Result<DeviceKeyState, CryptoError>;
fn lock_device_keys();
fn get_device_state() -> Result<DeviceKeyState, CryptoError>;
fn sign_bytes(message: Vec<u8>) -> Result<Vec<u8>, CryptoError>;
fn verify_signature(message: Vec<u8>, signature: Vec<u8>, pubkey_hex: String) -> Result<bool, CryptoError>;

// PUK
fn create_initial_puk(device_encryption_pubkey_hex: String, device_id: String) -> Result<PukState, CryptoError>;
fn open_puk_envelope(envelope: HpkeEnvelope, device_id: String) -> Result<Vec<u8>, CryptoError>;
fn derive_puk_subkeys(seed: Vec<u8>, generation: u32) -> Result<PukState, CryptoError>;
fn rotate_puk(old_seed: Vec<u8>, old_gen: u32, remaining_devices: Vec<DeviceKeyState>) -> Result<RotatePukResult, CryptoError>;

// HPKE
fn hpke_seal(plaintext: Vec<u8>, recipient_pubkey_hex: String, label: String, aad: Vec<u8>) -> Result<HpkeEnvelope, CryptoError>;
fn hpke_open(envelope: HpkeEnvelope, expected_label: String, aad: Vec<u8>) -> Result<Vec<u8>, CryptoError>;

// Sigchain
fn create_sigchain_link(seq: u64, prev_hash: Option<String>, payload_json: String) -> Result<SigchainLink, CryptoError>;
fn verify_sigchain_link(link: SigchainLink, expected_signer_pubkey: String) -> Result<bool, CryptoError>;

// MLS
fn mls_create_group(group_id: Vec<u8>) -> Result<MlsGroupState, CryptoError>;
fn mls_generate_key_packages(count: u32) -> Result<Vec<KeyPackageBundle>, CryptoError>;
fn mls_add_member(key_package_bytes: Vec<u8>) -> Result<MlsCommitResult, CryptoError>;
fn mls_remove_member(leaf_index: u32) -> Result<MlsCommitResult, CryptoError>;
fn mls_process_welcome(welcome_bytes: Vec<u8>) -> Result<MlsGroupState, CryptoError>;
fn mls_process_commit(commit_bytes: Vec<u8>) -> Result<MlsGroupState, CryptoError>;
fn mls_export_secret(label: String, length: u32) -> Result<Vec<u8>, CryptoError>;
fn mls_self_update() -> Result<MlsCommitResult, CryptoError>;

// SFrame
fn derive_sframe_key(call_id: String, participant_index: u32) -> Result<Vec<u8>, CryptoError>;

// Auth
fn create_auth_token(timestamp: u64, method: String, path: String) -> Result<String, CryptoError>;
fn verify_auth_token(token_json: String, pubkey_hex: String) -> Result<bool, CryptoError>;
```

### 13. Backend API Surface

New endpoints (all require device-signed auth):

```
POST   /api/devices/register
  Body: { deviceId, signingPubkey, encryptionPubkey, initialSigchainLink }
  Response: { userId, deviceRegistered: true }

GET    /api/devices/:userId
  Response: { devices: [{ deviceId, signingPubkey, encryptionPubkey, status }] }

POST   /api/key-packages/upload
  Body: { packages: [{ keyPackageBytes, keyPackageRef }] }
  Response: { accepted: number }

GET    /api/key-packages/:userId
  Response: { packages: [{ keyPackageBytes, keyPackageRef, deviceId }] }
  (Consumes one key package per device per fetch)

POST   /api/sigchain/append
  Body: { link: SigchainLink }
  Response: { accepted: true, seq: number }

GET    /api/sigchain/:userId
  Query: ?after_seq=N (incremental fetch)
  Response: { links: SigchainLink[], head_seq: number }

POST   /api/mls/:hubId/commit
  Body: { commit_bytes, welcome_bytes?, proposals: [] }
  Response: { epoch: number }

GET    /api/mls/:hubId/messages
  Query: ?after_epoch=N
  Response: { messages: [{ type, bytes, sender_device_id, epoch }] }

POST   /api/mls/:hubId/welcome
  Body: { welcome_bytes, recipient_device_ids: [] }
  Response: { delivered: number }

POST   /api/puk/envelopes
  Body: { generation, envelopes: [{ deviceId, envelope: HpkeEnvelope }] }
  Response: { stored: number }

GET    /api/puk/envelopes/:userId
  Query: ?device_id=X&generation=N
  Response: { envelope: HpkeEnvelope, generation, clkr_chain: [hex...] }
```

### 14. Crypto Label Registry Expansion

New labels required (added to `packages/protocol/crypto-labels.json`). These use the v1 hotline naming convention with colon-separated path segments and `:v1` version suffix:

```json
{
  "LABEL_PUK_SIGN": "llamenos:puk:sign:v1",
  "LABEL_PUK_DH": "llamenos:puk:dh:v1",
  "LABEL_PUK_SECRETBOX": "llamenos:puk:secretbox:v1",
  "LABEL_PUK_WRAP_TO_DEVICE": "llamenos:puk:wrap:device:v1",
  "LABEL_PUK_PREVIOUS_GEN": "llamenos:puk:prev-gen:v1",
  "LABEL_MASTER_KEY_WRAP": "llamenos:master:wrap:v1",
  "LABEL_MASTER_SELF_SIGNING": "llamenos:master:self-signing:v1",
  "LABEL_MASTER_USER_SIGNING": "llamenos:master:user-signing:v1",
  "LABEL_MASTER_RECOVERY_HANDOFF": "llamenos:master:recovery-handoff:v1",
  "LABEL_MASTER_RECOVERY_GROUP_WRAP": "llamenos:master:recovery-group:v1",
  "LABEL_PUK_RECOVERY_GROUP_WRAP": "llamenos:puk:recovery-group:v1",
  "LABEL_DEVICE_DISPLAY": "llamenos:device:display:v1",
  "LABEL_DEVICE_ENROLLMENT_SAS": "llamenos:device:enrollment-sas:v1",
  "LABEL_PAPER_KEY_SIGNING": "llamenos:paper-key:sign:v1",
  "LABEL_PAPER_KEY_ENCRYPTION": "llamenos:paper-key:encryption:v1",
  "LABEL_HUB_PTK_PREV_GEN": "llamenos:hub-ptk:prev-gen:v1",
  "LABEL_SFRAME_CALL_SECRET": "llamenos:sframe-call-secret:v1",
  "LABEL_SFRAME_BASE_KEY": "llamenos:sframe-base-key:v1",
  "LABEL_DEVICE_AUTH": "llamenos:device-auth:v1",
  "LABEL_ITEMS_KEY_EXPORT": "llamenos:items-key-export:v1",
  "LABEL_NOTE_EPOCH_KEY": "llamenos:note-epoch-key:v1",
  "LABEL_MLS_PROVISION": "llamenos:mls-provision:v1"
}
```

These labels are appended to `LABEL_REGISTRY` at indices 24+ (matching v1 hotline ordering exactly). Total registry length grows from 24 to 42 (indices 42-46 permanently retired per v1 convention).

---

## Wire Format Details

### Sigchain Link Canonical Form (for hashing)

```
SHA-256(UTF-8(JSON.stringify({
  seq,
  prevHash,
  timestamp,
  signerDeviceId,
  signerPubkey,
  payload
}, keys sorted)))
```

Keys are sorted lexicographically before serialization to ensure deterministic hashing across platforms.

### MLS Message Routing

The server stores MLS messages keyed by `(hub_id, epoch, message_type)`:

| Message Type | Routing                                   |
| ------------ | ----------------------------------------- |
| Commit       | Broadcast to all group members            |
| Proposal     | Broadcast to all group members            |
| Welcome      | Targeted to specific new member device(s) |
| KeyPackage   | Stored per-user, consumed on Add          |

Fan-out is push-based (WebSocket) with pull fallback (GET endpoint with epoch cursor).

### Auth Token Format (Ed25519)

Replaces BIP-340 Schnorr auth tokens:

```json
{
  "pubkey": "<ed25519 pubkey hex>",
  "sig": "<ed25519 signature hex>",
  "ts": <unix timestamp seconds>,
  "method": "GET",
  "path": "/api/..."
}
```

Signed message: `SHA-256(UTF-8("llamenos:device-auth:v1:" + timestamp + ":" + method + ":" + path))`

---

## Platform-Specific Key Storage

### Desktop (Tauri Stronghold)

```
~/.local/share/com.llamenos.app/stronghold/device.stronghold
  ├── ed25519_signing_key (32 bytes)
  └── x25519_encryption_key (32 bytes)
```

Protected by PIN-derived key (PBKDF2-SHA256, 600K iterations). Stronghold provides:

- Runtime memory encryption
- Zeroize on drop
- File-level encryption at rest
- No swap-to-disk for key material

### iOS (Keychain Services)

```
kSecClass: kSecClassKey
kSecAttrKeyClass: kSecAttrKeyClassPrivate
kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
kSecAttrKeyType: (custom — stored as generic data)
kSecAttrApplicationTag: "com.llamenos.device.ed25519" / "com.llamenos.device.x25519"
```

Secure Enclave (P-256 only) used for device attestation if available; Ed25519/X25519 keys stored in software keychain with biometric/passcode gate.

### Android (AndroidKeyStore)

```
KeyStore alias: "llamenos_device_ed25519" / "llamenos_device_x25519"
Cipher: AES/GCM/NoPadding (hardware-backed where available)
UserAuthenticationRequired: true
UserAuthenticationValidityDuration: 300 (seconds)
```

Fallback: EncryptedSharedPreferences (Jetpack Security) on devices without hardware keystore support.

---

## Decisions to Review

### 1. Curve: Ed25519/X25519 over secp256k1

**Chosen**: Ed25519 (signing) + X25519 (key agreement)

**Alternatives considered**:

- **Keep secp256k1**: Nostr compatibility, existing code. Rejected because: (a) Nostr relay integration is being replaced by self-hosted strfry with opaque encrypted events — no benefit from Nostr key format; (b) secp256k1 ECDH is awkward (x-only pubkeys, 33-byte compressed points requiring prefix gymnastics); (c) no native HPKE KEM for secp256k1; (d) MLS ciphersuites only define X25519 or P-256.
- **P-256/P-384**: Better hardware support (Secure Enclave, AndroidKeyStore native). Rejected because: (a) NIST curve trust concerns for activist-facing software; (b) OpenMLS ciphersuite selection favors X25519; (c) `dalek` ecosystem is more audited for Rust; (d) P-256 can still be used for device attestation separately.

### 2. HPKE crate: `hpke` (rozbb) over `hpke-rs`

**Chosen**: `hpke` crate by rozbb (Michael Rosenberg)

**Alternatives considered**:

- **`hpke-rs`** (franziskuskiefer): Wraps OpenSSL or RustCrypto backends. Rejected because: (a) OpenSSL dependency is unacceptable for mobile/WASM; (b) less idiomatic Rust API; (c) maintained by one person with less community review.
- **`hpke` (rozbb)**: Pure Rust, uses RustCrypto primitives (`x25519-dalek`, `aes-gcm`, `hkdf`), no C dependencies, compiles to WASM and iOS/Android. Well-audited (used by Signal's libsignal-protocol-rust for testing). Supports all modes (Base, PSK, Auth, AuthPSK). MIT licensed.

### 3. MLS library: OpenMLS over Wire core-crypto

**Chosen**: `openmls` (OpenMLS project)

**Alternatives considered**:

- **Wire core-crypto**: Wire's Rust MLS implementation. Rejected because: (a) tightly coupled to Wire's infrastructure (Proteus, key store, delivery service); (b) not designed as a library — it's an application; (c) MPL-2.0 license adds complexity; (d) much larger dependency surface.
- **OpenMLS**: Designed as a reusable library. Clean trait-based crypto backend (`openmls_rust_crypto`). Well-defined persistence trait (`OpenMlsKeyStore`). Supports custom credential types. RFC 9420 compliant. Apache-2.0. Active maintenance by multiple orgs.
- **Build from scratch**: Unacceptable — MLS is a 100+ page RFC with subtle security properties.

### 4. Symmetric cipher: AES-256-GCM over XChaCha20-Poly1305

**Chosen**: AES-256-GCM for HPKE AEAD and items_key encryption

**Alternatives considered**:

- **XChaCha20-Poly1305**: Currently used in the secp256k1 ECIES path. Better nonce-misuse resistance (24-byte nonce vs 12-byte). Rejected for the HPKE path because: (a) HPKE RFC 9180 only defines AES-128-GCM and AES-256-GCM as AEAD options — no ChaCha variant; (b) MLS ciphersuites similarly only define AES-GCM; (c) consistency with HPKE/MLS is more important than nonce length since HPKE generates nonces internally.
- **AES-128-GCM**: Lighter, faster. Rejected because 256-bit provides PQ margin (Grover's algorithm halves effective key length).

### 5. PUK subkey derivation: HMAC-SHA256 over HKDF-Expand

**Chosen**: HMAC-SHA256 with label || generation concatenation

**Alternatives considered**:

- **HKDF-Expand**: More "standard" for KDF. Rejected because: (a) HMAC-SHA256 with distinct labels achieves the same domain separation; (b) simpler implementation across platforms (fewer parameters); (c) v1 prototype uses this pattern and it's been reviewed; (d) HKDF-Expand is HMAC anyway — using it adds no security margin but adds API complexity.

### 6. Sigchain signature: Ed25519 over BIP-340 Schnorr

**Chosen**: Standard Ed25519 signatures

**Alternatives considered**:

- **BIP-340 Schnorr (secp256k1)**: Currently used. Rejected because: (a) we're removing secp256k1 entirely; (b) Ed25519 has simpler verification (no x-only key handling); (c) dalek provides batch verification for free; (d) MLS leaf credentials use Ed25519 — single signing key serves both purposes.

### 7. Key package count: 100 pre-published per device

**Chosen**: 100 key packages pre-published

**Alternatives considered**:

- **10 packages**: Too few — a busy hub with frequent member changes could exhaust them before the device comes online to replenish.
- **1000 packages**: Excessive storage. 100 \* 50 devices = 5000 packages per hub — manageable. Replenishment threshold set at 20 remaining.

### 8. SFrame over SRTP/DTLS

**Chosen**: SFrame (Secure Frame) for voice E2EE

**Alternatives considered**:

- **SRTP with end-to-end keys**: Standard for VoIP. Rejected because: (a) SRTP terminates at the SFU — not truly E2EE unless the SFU is trusted; (b) SFrame is designed for E2EE over untrusted relays; (c) SFrame integrates naturally with MLS exporter secrets.
- **Insertable Streams + raw AEAD**: Too low-level, browser-specific. SFrame provides a well-defined framing format.

### 9. items_key indirection over direct PTK→content encryption

**Chosen**: Hub PTK → items_key → content_key (three layers)

**Alternatives considered**:

- **PTK → content_key directly**: Simpler, fewer wrapping operations. Rejected because: (a) PTK rotation would require re-wrapping ALL content keys — O(n) in total content; (b) no per-member scoping — any member with PTK could decrypt any content; (c) items_key provides a natural revocation boundary (remove member = delete their items_key envelope).
- **PUK → content_key (no hub involvement)**: Every member encrypts to every reader individually. Rejected because: (a) O(n) envelopes per note for n admins; (b) no group-level key agreement; (c) current v1 pattern already shown to be expensive.

### 10. Nostr identity removal

**Chosen**: Remove nsec/npub entirely, replace with device-based Ed25519 identity

**Alternatives considered**:

- **Keep Nostr for relay auth only**: Use nsec for relay connection, Ed25519 for everything else. Rejected because: (a) maintaining two key systems adds attack surface and confusion; (b) strfry relay auth can use any signature scheme — we'll configure it to accept Ed25519; (c) the relay sees only opaque encrypted blobs anyway — it doesn't need Nostr-format verification.
- **Derive Ed25519 from nsec**: Use HKDF to derive Ed25519 seed from secp256k1 secret. Rejected because: (a) ties new system to old key material; (b) key compromise of nsec compromises derived Ed25519; (c) clean break is simpler and more auditable.
