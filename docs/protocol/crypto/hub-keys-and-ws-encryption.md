# Llamenos Protocol: Cryptographic operations: hub keys and WebSocket encryption

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 2.7 Hub Key Management

Each hub has a random symmetric key. It seals the hub's tag and team labels, the names of the hub's own roles (`LABEL_HUB_ROLE_ENCRYPT`; §4 "Roles (PBAC)") and note exports, and is the key `decrypt_hub_event` uses. The hub key is NOT derived from any identity key -- it is pure random bytes.

A device holds **one key per hub it belongs to**, keyed by hub id (desktop `CryptoState::hub_keys`, mobile `hub_keys` in the crate's FFI state). Never a single "current" key: a user can be a member of several hubs at once, and a single slot would seal one hub's data under whichever hub's key was loaded last.

#### Key Generation

```
hub_key = random(32)   // in Rust, on a manager's device; never leaves Rust
```

A manager generates a hub's key only when the hub holds **no wrap for anyone** (`GET /api/hubs/:hubId/key/recipients` returns `envelopes: []`). Generating while a key exists would replace the key every other member holds.

#### Distribution

Wraps are HPKE (§2.2) under `LABEL_HUB_KEY_WRAP`, in the wire encoding (hex `enc`/`ct`). The label, its registry `labelId` and the AAD are fixed by the crate -- `encryption::hpke_wrap_key` / `hpke_unwrap_key` -- which every platform calls; no client passes them:

```
wrap(hub_key[32], member_device_x25519_pubkey_hex):
  sealed = HPKE.Seal(
    recipientPk = hex_to_bytes(member_device_x25519_pubkey_hex),
    plaintext   = hub_key,
    info        = UTF-8("llamenos:hub-key-wrap"),
    aad         = UTF-8("llamenos:hub-key-wrap:key-wrap")
  )
  return { enc: hex(sealed.enc), ct: hex(sealed.ct) }
```

An envelope is **sealed to** the member's device X25519 key and **filed under** the member's Ed25519 user pubkey -- `{ pubkey: <user pubkey>, enc, ct }` -- because that is the identity the server authenticates and `GET /key` looks the wrap up by. (Sealing to the Ed25519 key "works" and opens for nobody, #1021.) One wrap per user: a user with several devices can open it on one of them, which is the single-device pilot's model.

`GET /api/hubs/:hubId/key/recipients` -- requires `hubs:manage-keys` **or hub admin, in the hub's own roles**. A super-admin with no role in the hub is refused (D1). Hub admin counts because the invariant guarantees every hub one, and nothing guarantees a `hubs:manage-keys` holder: a new hub's founder gets the smallest role that confers hub-admin. Read in one snapshot:

```
{ generation: int,              // hubs.hub_key_generation, the envelope set's version
  epoch:      int,              // hubs.hub_key_epoch: which KEY the wraps hold (0, +1 per rotation)
  rotation:   { proof, check } | null,   // the statement that introduced `epoch` (Key Rotation)
  envelopes:  RecipientEnvelope[],   // every wrap held, for current members
  members:    [{ pubkey, encryptionPubkey | null }],   // device key to wrap for
  rotationRequired: bool,       // someone who held the current key has left
  sealed?:    { tags, teams, roles } }   // present iff rotationRequired: every hub-sealed value
```

`PUT /api/hubs/:hubId/key` -- `{ envelopes, expectedGeneration }`, same authority. A **compare-and-set**: it succeeds only if the hub is still at `expectedGeneration`, replaces the set, and moves the generation forward by one in the same statement; otherwise **409**. So of two managers who each generated a first key at once, exactly one key is installed, and the loser drops its key and loads the winner's. A shred also moves the generation, so a replayed write cannot re-install a destroyed key. Hub-key writes are never queued for offline replay.

A distributor re-sends the existing `envelopes` unchanged and adds wraps only for members who lack one, so distributing never takes anyone's access away. It wraps the key **it already holds**, never one re-opened from what the server returns at that moment: anyone can seal a key to a device's public key, so re-opening the server's copy would let a server swap in a key it chose. A held key is never replaced -- except by a rotation the device has verified (Key Rotation, below). A distributor first confirms that the key it holds opens the current `rotation.check` (it holds this epoch's key), and distributes nothing while `rotationRequired`: the key a departed member still knows is not handed to anyone new.

Members fetch their wrap from `GET /api/hubs/:hubId/key` (404 when none) and open it:

```
unwrap(envelope, device_x25519_secret_key[32]):
  return HPKE.Open(recipientSk = device_x25519_secret_key,
                   enc = hex_to_bytes(envelope.enc), ciphertext = hex_to_bytes(envelope.ct),
                   info = UTF-8("llamenos:hub-key-wrap"),
                   aad  = UTF-8("llamenos:hub-key-wrap:key-wrap"))
  // hub_key: 32 bytes, held in Rust under the hub id
```

**Desktop lifecycle** (`src/client/lib/hub-key-manager.ts`): for every member hub, on sign-in, on a membership change and on every relay (re)connect -- load; if nobody holds a key and this user manages the hub, generate and wrap for every member with a device key; adopt a rotation that replaced the held key; if this user manages the hub, rotate the key if `rotationRequired`, then add wraps for members who lack one. The same sync runs right after an admin action that can make someone leave a hub (a role change, deactivation, deletion). A hub this user is no longer a member of has its key dropped from CryptoState. Creating a hub generates its key at once. Sealing a hub field loads the key on demand and refuses (`HubKeyUnavailableError`) rather than write anything the hub cannot read -- there is no plaintext fallback. A member who joins while no manager's device is online cannot read hub-sealed data until one comes online; that is inherent to a zero-knowledge distribution.

**Trust.** The device keys a distributor wraps for come from the server's device registry, as for every envelope in §2.4.1. Until the user sigchain is wired, a client cannot verify them independently: a server that lists a key it holds for a member receives the hub key.

#### Hub-Wide Encryption / Decryption

```
encryptForHub(plaintext_string, hub_key[32], label):
  nonce = random(12)
  ciphertext = AES-256-GCM(hub_key, nonce, aad = UTF-8(label)).encrypt(UTF-8(plaintext_string))
  return hex(nonce || ciphertext)

decryptFromHub(packed_hex, hub_key[32], label):
  data = hex_to_bytes(packed_hex)
  return UTF-8_decode(AES-256-GCM(hub_key, data[0..12], aad = UTF-8(label)).decrypt(data[12..]))
```

#### Key Rotation

When someone who held a hub's key leaves, the key is replaced with a fresh one that is wrapped for the remaining members only, and everything the hub holds sealed under the old key is re-sealed under the new one. The departed member is not among the new wraps, so nothing sealed afterwards -- and nothing the server holds afterwards -- opens for them.

**Trigger (server).** Every path that takes a wrap away from someone who held one sets `hubs.hub_key_rotation_due` in the same transaction: removal from the hub (`IdentityService.removeHubRole`), erasure (`ErasureService`), and a `PUT /key` whose new set drops a previous holder. With the wrap deleted, the flag is the only record that the departure happened. `rotationRequired` in `GET /key/recipients` is that flag **or** a wrap still held by someone who is no longer an actionable member (deactivated, deleted, signing key revoked) -- either way someone outside the hub knows the current key.

**Rotation (a manager's device).** A manager whose device holds the current key, on seeing `rotationRequired`:

```
new_key   = random(32)                         // in Rust, a staging CryptoState slot; never derived
envelopes = [ wrap(new_key, m.encryptionPubkey) for m in members if m.encryptionPubkey ]
resealed  = for each value v in `sealed`:  { from: v, to: encryptForHub(decryptFromHub(v, old_key, L), new_key, L) }
                                           // L = the value's own label; a value that does not open
                                           // under old_key is carried unchanged
check     = encryptForHub(JSON{ hubId, epoch: epoch + 1 },        new_key, LABEL_HUB_KEY_ROTATION)
proof     = encryptForHub(JSON{ hubId, epoch: epoch + 1, check }, old_key, LABEL_HUB_KEY_ROTATION)
POST /api/hubs/:hubId/key/rotate { expectedGeneration, envelopes, rotation: { proof, check }, resealed }
```

`POST /api/hubs/:hubId/key/rotate` -- same authority as `PUT /key`, one transaction, refusing with no trace left:

- **409** unless the hub is still at `expectedGeneration` (the same compare-and-set as `PUT /key`), and not shredded.
- **403** for a wrap addressed to anyone who is not a current member -- the departed member above all.
- **409** unless the wraps address **exactly** the current members that have a device key. A rotation cannot drop anyone, so it cannot orphan the hub's content from an admin.
- **409** unless `resealed` names every tag, team and hub-role value the hub holds (locked for the transaction), each `from` identical to what is stored -- otherwise a value would be left under a key nobody holds.

On success it replaces the wraps and the values, moves the generation and `hubs.hub_key_epoch` on by one, stores `{ proof, check }`, clears the flag, and audits `hubKeyRotated`. The client never distributes while a rotation is due, and rotates before it distributes.

**Adoption (every member's device).** `GET /api/hubs/:hubId/key/rotation` (any member) returns `{ epoch, rotation: { proof, check } | null }`. A device holding a key:

```
if epoch == 0 or rotation == null:          held key is current
elif open(check, held_key) == {hubId, epoch}: held key is current
elif open(proof, held_key) == {hubId, epoch, check}:
    open this device's wrap (GET /key) into a staging slot
    adopt it only if open(check, staged_key) == {hubId, epoch}
else:                                         unverifiable -- keep the held key, adopt nothing
```

The server has never held a hub key, so it cannot write a `proof` that opens under the old key, nor a `check` that opens under a key of its own choosing: a device never adopts a key the server picked. A device that is two or more rotations behind cannot verify the chain and keeps its key until its next unlock, when it loads its wrap exactly as on first load. A value that does not open under the held key prompts an adoption, and a device confirms its key is current before it seals anything new (`encryptForHub` refuses to seal under a rotated-out key).

**What rotation does not do.** It cannot take back what a departed member already copied: values they read before leaving, and anything they kept under the old key. It removes their access to everything stored or sealed after it. Until a manager's device runs it, the old key stays current -- the removing admin's device rotates at once, but a departure by an instance admin with no role in the hub (D1) waits for a hub admin's device to come online. And the trust caveat above applies here too: a server that lists a device key it holds for a member is given the new key, and a departed member who colluded with the server could write a `proof` (they know the old key); neither gives the server anything the device-registry trust does not already.

**Not yet on mobile (#2831).** iOS and Android load the current key at unlock and do not adopt a rotation within a session: a mobile device that was unlocked across a rotation cannot open re-sealed values until its next unlock, and an iOS tag written in that window is sealed under the old key. Android's hub-switch refresh also replaces a held key with whatever wrap the server returns, without the verification above.

### 2.8 WebSocket Event Encryption

> **Note:** "Events" in this section refers to real-time WebSocket messages (call rings, presence updates, settings pushes). This is distinct from the deprecated `/api/hubs/:hubId/events` REST endpoint group (Section 4.32), which was a calendar/scheduling data type now superseded by entity types with `category:"event"` in the Records API.

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

#### Server-Published Relay Events

The frames the server's relay publishes (`apps/worker/lib/ws-events.ts` `publishEvent`) are what clients actually receive: call rings, call updates, new messages. They are **not** sealed under the hub key above, but under an account-wide, epoch-scoped server key:

```
epoch      = floor(unix_seconds / 86400)                      // UTC day; also the frame's `epoch` field
event_key  = HKDF(SHA-256, ikm = SERVER_SECRET,
                  salt = UTF-8(LABEL_SERVER_EVENT_ENCRYPTION_KEY),
                  info = UTF-8("{LABEL_HUB_EVENT_EPOCH}:{epoch}"), length = 32)
padded     = [4-byte LE length][UTF-8(json)][random padding]  // total a power of two, minimum 512
payload    = hex(nonce(12) || AES-256-GCM(event_key, nonce, aad = UTF-8("{LABEL_HUB_EVENT_EPOCH}:{epoch}")).encrypt(padded))
```

A client reads `serverEventKeyHex` (this epoch) and `serverEventKeyPrevHex` (the previous one) from `GET /api/auth/me`, and MUST open a frame with **the frame's own `epoch`** in the AAD and strip the padding. A frame whose epoch neither stored key covers (a socket that outlives UTC midnight) is retried once after re-reading `/api/auth/me`. The epoch-less `LABEL_HUB_EVENT` AAD above is not what the relay uses; a reader that applies it opens nothing.

`packages/crypto/tests/fixtures/server-event-vectors.json` holds frames **written by the server** (`packages/crypto/scripts/gen-server-event-vectors.ts` runs `encryptEventContent`), with the event keys `/api/auth/me` returns. Every client's production reader MUST open each recorded `payload` to its `plaintext` given the recorded `epoch`, and MUST NOT open it without the epoch.

A relay lists a user's hubs once, in its `authenticated` reply, and never announces a later membership. A client that learns of a new membership (from `GET /api/hubs`) re-authenticates the socket to subscribe to it.

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
    salt = UTF-8(LABEL_SERVER_SIGNING_KEY),   // "llamenos:server-signing-key:v1"
    info = UTF-8(LABEL_SERVER_SIGNING_INFO),  // "llamenos:server-signing-key-info:v1"
    length = 32
  )

  pubkey = Ed25519.pubkeyFromSeed(signing_seed)  // 32-byte Ed25519 public key, hex-encoded

  Return { secretKey: signing_seed, pubkeyHex }
```

See `apps/worker/lib/server-identity.ts` `deriveServerKeypair()` for the implementation.

The server's pubkey is distributed to clients via `GET /api/config` in the `serverWebSocketPubkey` field. Clients verify server-published WebSocket events against this pubkey.

