# Llamenos Protocol: Cryptographic operations: HMAC, device keys and audit chain

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

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

#### Ban Hashing

The server stores a digest of a number **only if that number is banned**. A caller who is not banned is digested transiently to be compared with the ban lists and the digest is dropped. `BAN_HASH_KEY` is a file-only secret (never in the database, `.env` or a config backup).

The digest is an oblivious PRF (RFC 9497, mode `0x00` OPRF, suite `ristretto255-SHA512`), implemented once in `packages/crypto/src/ban_digest.rs` (#2759). Two parties compute it:

- **The server**, from a caller identifier it already holds (an inbound call; a call's sealed number when a volunteer bans from the call), with `Evaluate`.
- **An admin's client**, for a number the admin types, without the server ever receiving it: the client `Blind`s the number, the server `BlindEvaluate`s the blinded element (§4.47 `/evaluate`, `/search/evaluate`), and the client `Finalize`s the answer. No client holds the key, so nobody with the stored digests but not `BAN_HASH_KEY` can enumerate the (small) phone-number space offline; the evaluate endpoints are the only oracle, and they are permission-checked, rate-limited and audited.

```
banDigest(identifier, scope, ban_hash_key_hex):
  // scope = the hub id, or the literal "platform"
  sk_scope = OPRF.DeriveKeyPair(seed = hex_to_bytes(ban_hash_key_hex),
                                info = UTF-8(LABEL_BAN_KEY_DERIVE + ":" + scope)).skS
  input    = UTF-8(HMAC_BAN_PREFIX + identifier)
  return hex(OPRF.Evaluate(sk_scope, input))        // 64 bytes -> 128 hex chars

client, for a typed number (refused unless E.164 `^\+\d{7,15}$`; never normalised):
  (blind, blindedElement) = OPRF.Blind(input)       // send hex(blindedElement), 32 bytes
  evaluatedElement        = <server: OPRF.BlindEvaluate(sk_scope, blindedElement)>
  phoneHash               = hex(OPRF.Finalize(input, blind, evaluatedElement))
```

`phoneHash` is the one name of this value on every platform and in every body and response. A hub's digest cannot be re-keyed to another scope: promoting a hub ban to the platform needs the number again, digested under both scopes (§4.47). Neither the ban store nor any ban request or response carries digits of the number.

**Key continuity and re-entry (#2829).** A stored digest is valid only under the `BAN_HASH_KEY` it was made with, and it can never be recomputed: the server did not keep the number, and that is the point of the OPRF. Two things therefore end a ban's enforcement, and neither may happen silently:

- the digest scheme changed (the HMAC → OPRF switch), or
- `BAN_HASH_KEY` is not the key the stored digests were made under (a key file lost and regenerated, or restored wrongly).

The server records `banKeyFingerprint(key) = hex(OPRF.Evaluate(DeriveKeyPair(seed, "LABEL_BAN_KEY_DERIVE:ban-key-fingerprint"), "llamenos:ban-key-fingerprint:v1"))` in `ban_key_check` and compares it at every boot (`RecordsService.reconcileBanKey`). A different key makes the server **refuse to boot**, naming the operator's way out: restore the original key, or — when the replacement is deliberate — boot once with `BAN_KEY_REPLACED_ACK=<the new key's fingerprint>`. A first boot with no recorded fingerprint and bans already stored is the scheme change. In both acknowledged cases every ban is **moved** from `bans` to `ban_reentries` in one transaction: its digest is dropped, and only the non-identifying context (when, by whom, the admin's note, the cause) is kept. No migration re-digests a ban and no row is left in `bans` that reads as enforced and matches nothing; keeping the old HMAC column to match on either is not an option, as it is the enumerable value the OPRF replaces.

The retired bans reach the admin through the list they already read: `GET /hubs/:hubId/bans` and `GET /admin/bans` carry `reentries[]` (`banReentryResponseSchema`: `id`, `reason`, `bannedBy`, `bannedAt`, `cause` = `digest-scheme` | `key-replaced`, `retiredAt`), and `DELETE …/bans/reentries/:id` (`bans:delete` / `bans:delete-platform`, audited `banReentryDismissed`) removes one once its number is banned again.

#### Messaging Thread Hashing

A messaging conversation is identified by a per-hub keyed hash of the sender's identifier (`conversations.contact_identifier_hash`). `MESSAGING_HASH_KEY` is a file-only secret (`/run/secrets/messaging-hash-key`; never in the database, `.env` or a config backup) and is a key of its own: the only other value hashed under it is the blast subscriber's `identifier_hash` (below), which is the same hash by design. No ban or audit hash of the same number can be compared with a thread hash.

```
messagingContactHash(identifier, hub_id | null, messaging_hash_key_hex):
  // scope = the hub id, or the literal "global" when none is given (the inbound webhook always gives one, #2395)
  scope_key = HKDF-SHA256(ikm  = hex_to_bytes(messaging_hash_key_hex),
                          salt = "",
                          info = UTF-8(LABEL_MESSAGING_CONTACT_HUB_KEY + ":" + scope),
                          len  = 32)
  input = UTF-8(HMAC_MESSAGING_CONTACT_PREFIX + identifier)
  return hex(HMAC-SHA256(scope_key, input))
```

A blast subscriber is identified by the same hash (`subscribers.identifier_hash`, per hub), whichever way the row was created: the webhook keyword handler stores the router's value, and the bulk importer (`POST /api/blasts/subscribers/import`) calls the same function with the hub it imports into. A single prefix, `HMAC_MESSAGING_CONTACT_PREFIX`, is used for both, so a subscriber's STOP matches the row an import created. `HMAC_SUBSCRIBER` is retired: nothing hashes under it any more, and its registry slot stays (the registry is append-only).

`identifier` is `IncomingMessage.senderIdentifier`, the same value the sealed reply address holds (the Signal UUID when present, otherwise the number). It is computed once, by the messaging router after the adapter has parsed the webhook; adapters do not hash. The same contact in two hubs has two unrelated hashes. The reply address (`contact_identifiers`) stays sealed under `SERVER_KEK` with `LABEL_CONTACT_ID`; its format is unchanged.

No part of the contact's number is stored or displayed: the conversation has no `contactLast4`, and `ContactTimelineSummary` has no `last4`. A client names a thread by a short prefix of `contactIdentifierHash`, or "Unknown" when it is empty, and searches by that prefix.

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

