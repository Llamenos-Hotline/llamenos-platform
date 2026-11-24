# Llamenos Protocol: Device linking: roles, primitives and flow

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

## 6. Device Linking Protocol

Llamenos has exactly **one** device-linking protocol. Desktop (Tauri), iOS, and Android MUST implement this section and only this section; per-client variants of the QR format, transport, role assignment, or payload are protocol violations (issue #1027).

> **Implementation status — read this before building against §6.**
>
> **No client implements device linking today.** Commit `7e6c88cbc` ("stop offering device linking in the pilot build", #1405) removed the link-device screens, view models, routes and deep links from desktop, iOS and Android, because linking reported success without exchanging usable keys. Linking is M2 work.
>
> What exists today is: the server room-relay API (§4.19, three endpoints), the Rust primitives in `packages/crypto/src/provisioning.rs`, and the Tauri IPC commands in `apps/desktop/src/crypto.rs` — the last reachable only from tests, and carrying a known defect (§6.14). There is no QR encoder, no QR parser, no registered URI scheme, no short-code derivation, and no primary-device encrypt path on either mobile platform.
>
> §6 is therefore a **specification to build to**, not a description of shipped behaviour. Every subsection carries a status, and §6.14 is the authoritative conformance matrix with file-level evidence. Where this section says MUST, it binds an implementation of that subsection — it does not assert that one exists.

This section also records the three divergent implementations that #1027 replaced. All of them were deleted by `7e6c88cbc`; "Dropped" below means the code is gone, and "Kept" means the design decision is carried forward into this specification, **not** that shipping code implements it:

| Retired implementation | Disposition |
|---|---|
| Desktop raw-JSON QR `{"r":roomId,"t":token}` | **Dropped** — no deep-link registration on mobile; this spec adopts the URI form in §6.4, which nothing implements yet |
| Android `llamenos:provision:<roomId>:<relayUrl>` QR | **Dropped** — the relay URL is obsolete; HTTP rooms are the only transport |
| iOS `llamenos-link://<relay>/<roomId>` QR | **Dropped**; §6.4 reuses the `llamenos-link` scheme name but no platform registers or parses it |
| iOS Nostr-relay WebSocket transport (`kind 20001`) | **Dropped** — the server never accepted client-published events on the WebSocket at all, and 20001 is the typing-indicator kind in `packages/shared/event-kinds.ts`; the server implements only the HTTP room API |
| Android mock flow (ECDH against `SecureRandom`, `delay(2000)` success) | **Dropped** — never a protocol; the §6.10 success-reporting rule exists to make this class of defect impossible |
| Desktop HTTP-room transport, new device displays QR | **Design kept** — matches Signal's role assignment and the deployed server API; the screens themselves were removed |
| Two-seed key-bundle payload (PR #1382) | **Implemented in Rust** (§6.7.2), with the ephemeral key agreement of #1865 (§6.3); the desktop IPC commands still drive the pre-#1865 key agreement and fail closed against it (§6.14); the end-to-end linking screens and mobile encrypt path remain unimplemented |

> **Profile split.** The roles (§6.1), transport, and SAS ceremony (§6.3–§6.6) are the final design. They changed once more before any client shipped: #1865 took the primary's long-term X25519 key out of the key agreement — replacing it with a per-room ephemeral authenticated by a signed claim (§6.3.1) — and made the QR carry the new device's ephemeral key (§6.4). **v0** (§6.7.1) is the historical single-seed payload; PR #1382 implements **v1** (§6.7.2), the two-seed bundle, in Rust and desktop crypto. The end-to-end linking UI and mobile encrypt path are still unimplemented. The **target profile** (§6.12) replaces the payload again once the identity layer has a PUK and sigchain in active use. Each payload revision changes only the payload and, for the target profile, the claim body — the QR format, room transport, SAS ceremony and failure rules do not change.

### 6.1 Roles

*Status: specified; no platform implements either side (§6.14).*

- **New device** — the device being linked. It holds no account credentials yet. It generates its ephemeral ECDH keypair, creates the room, and **displays** the QR code, which carries that ephemeral public key (§6.4). This is Signal's role assignment and matches the deployed server API. Note that the retired iOS and Android screens had the *new* device scanning, the reverse of this assignment; implementations MUST follow this section, not the retired code.
- **Primary device** — an already-authorized device holding the user's device keys (§2.11). It **scans** the QR, drives the SAS ceremony, and posts the encrypted key bundle. For every room it generates a fresh ephemeral X25519 keypair of its own: its long-term keys never enter the key agreement, and its long-term Ed25519 key only signs the claim (§6.3.1). The payload endpoint requires an authenticated session. That session is the interim authorization proof, with an important caveat: the server accepts a `senderPubkey` from the session but does not store or check it (`apps/worker/services/identity.ts`, `setProvisionPayload`), so the payload is bound to the room token, not to a particular authorized device. See §6.12 for what the identity layer adds.
- **Server** — untrusted relay. It stores the ephemeral pubkey and the encrypted payload. It never sees plaintext key material, the provisioning key, or the SAS; no server-side code derives any of them.

Both devices MUST execute the flow with a human present: the SAS comparison (§6.6) is a user action, not a background check. An implementation that "links" without one is non-conformant.

### 6.2 Primitives and Domain Separation

All cryptography is X25519 ECDH between two ephemeral keys (32-byte Montgomery u-coordinate keys, hex-encoded on the wire; implementations MUST reject the all-zero shared secret, which indicates a low-order peer key), HKDF-SHA256, AES-256-GCM (12-byte nonce, 16-byte tag), and Ed25519 for the claim signature (§6.3.1).

| Constant | Value | Purpose |
|----------|-------|---------|
| `LABEL_PROVISIONING_SALT` | `llamenos:provisioning:v1` | HKDF salt for the payload AEAD key |
| `LABEL_DEVICE_PROVISION` | `llamenos:device-provision` | HKDF info for the payload AEAD key; also the v0 AEAD associated data |
| `SAS_SALT` | `llamenos:sas` | SAS HKDF salt |
| `SAS_INFO` | `llamenos:provisioning-sas` | SAS HKDF info |
| `LABEL_DEVICE_PROVISION_CLAIM` | `llamenos:device-provision-claim:v1` | Ed25519 signature context for the claim (§6.3.1) |

Every constant above is registered in `packages/protocol/crypto-labels.json` — the single authoritative source for domain-separation constants (§2.1) — and mirrored in `packages/crypto/src/labels.rs`.

The v1 bundle payload (§6.7.2) uses the registered format-binding AAD label `LABEL_DEVICE_PROVISION_BUNDLE` (`llamenos:device-provision-bundle:v1`). It is appended at `labelId` 99 in `packages/crypto/src/labels.rs`; the `HMAC_SIP_VOLUNTEER_SECRET` label from main remains at 98. `LABEL_DEVICE_PROVISION_CLAIM` is appended at `labelId` 100 (#1865). Registry positions are append-only and permanent: index 53 is a tombstone that must never be reused, and a label may only be appended, never inserted. The JSON object member order is not the `labelId`; the Rust `LABEL_REGISTRY` array assigns IDs by position, and `packages/crypto/label-registry.wire.snapshot` pins every index-to-string mapping. New labels must be added to `crypto-labels.json`, appended to the registry, and shipped through codegen before use. Implementations MUST NOT define crypto labels locally as raw string literals.

### 6.3 Protocol Flow

*Status: steps 1–4 and 10–14 map onto endpoints that exist; steps 5–8 (the claim step) do not — see the callout below. The cryptography of every step is implemented in `packages/crypto/src/provisioning.rs`.*

```
New Device                           Server                    Primary Device
----------                           ------                    ----------------
1. eSK_n, ePK_n = X25519.generate()
   (fresh per linking attempt)

2. POST /api/provision/rooms
   { ephemeralPubkey: hex(ePK_n) }
                                  creates room: roomId, token
   <-- { roomId, token }

3. Display QR: llamenos-link://provision?r=<roomId>&t=<token>&k=<b64url(ePK_n)> (§6.4)

4. Poll GET /api/provision/rooms/:id?token
                                                           5. Scan QR → roomId, token, ePK_n
                                                              GET room (token)
                                                              <-- { ephemeralPubkey }
                                                              ABORT unless ephemeralPubkey == ePK_n from the QR
                                                           6. eSK_p, ePK_p = X25519.generate()
                                                              (fresh per room — NOT the long-term encSK)
                                                              shared = X25519(eSK_p, ePK_n)
                                                              discard eSK_p: it performs this one ECDH only
                                                              claim = §6.3.1, signed with the long-term sigSK
                                                              sas = derive (§6.6)
                                                              DISPLAY sas on primary screen
                                                           7. POST /api/provision/rooms/:id/claim    [NOT IMPLEMENTED]
                                                              { token, primaryClaim: hex(claim) }
                                  stores primaryClaim                                                 [NOT IMPLEMENTED]
   <-- poll now returns primaryClaim                                                                  [NOT IMPLEMENTED]
8. VERIFY claim against ePK_n (§6.3.1);
   failure → ABORT (§6.10)
   shared = X25519(eSK_n, ePK_p)
   sas = derive (§6.6)
   DISPLAY sas on new-device screen

9. USER COMPARES BOTH SCREENS (§6.6)
   match → continue;  mismatch → ABORT (§6.10)

                                                           10. payload = §6.7.2 bundle
                                                               prov_key = HKDF(SHA-256, shared,
                                                                 salt=LABEL_PROVISIONING_SALT,
                                                                 info=LABEL_DEVICE_PROVISION, len=32)
                                                               nonce = random(12)
                                                               ct = AES-256-GCM(prov_key, nonce, payload,
                                                                 aad = LABEL_DEVICE_PROVISION_BUNDLE || ePK_n || claim)
                                                           11. POST /api/provision/rooms/:id/payload (authenticated)
                                                               { token, encryptedNsec: hex(nonce||ct),
                                                                 primaryPubkey: hex(sigPK) }

   <-- poll returns status "ready" + encryptedNsec + primaryPubkey
12. VERIFY claim again (§6.3.1)
    data = hex_decode(encryptedNsec)
    plaintext = AES-256-GCM.decrypt(prov_key, nonce=data[0..12], ct=data[12..],
      aad = LABEL_DEVICE_PROVISION_BUNDLE || ePK_n || claim)
    CHECK: tag authenticates; then the §6.7.2 length/version rules; then
      Ed25519.public(bundle signing seed)  == sigPK in the claim, and
      X25519.public(bundle encryption seed) != ePK_p
13. re-derive sas from shared; assert equal to the code confirmed in step 9
14. import the transported key material into §2.11 PIN-encrypted device storage
    report success (§6.10 rule)
```

> **Steps 5–8 do not exist.** There is no `POST /api/provision/rooms/:id/claim` route, no claim body schema, no `primary_claim` column, and `primaryClaim` appears nowhere outside this document and `packages/crypto`. Consequently the new device has, today, **no way to learn `ePK_p`**, so it cannot derive `shared` and cannot display a SAS at step 8. The deployed server returns `primaryPubkey` only in the `status: "ready"` response — i.e. with the payload, after the point where the SAS must already have been compared. Implementing §6.3 requires the claim endpoint; until it exists, a conforming two-screen SAS ceremony is not constructible.
>
> In the retired desktop implementation the field named `primaryPubkey` carried the primary's **X25519 encryption** pubkey, and the new device fed it straight into the ECDH. Implementations MUST NOT copy that: no long-term key of either device is an ECDH input, and `primaryPubkey` is the Ed25519 signing key.

Notes:

- **Both ECDH inputs are ephemeral.** `eSK_p`/`ePK_p` are generated for one room and used for exactly one ECDH. The primary's long-term X25519 encryption keypair (`encSK`/`encPK`, §2.11) is **not** an input to the key agreement, and implementations MUST NOT substitute it for `eSK_p`. The new device enforces this after decryption (step 12): a bundle whose encryption key is `ePK_p` is rejected.
- **Why: forward secrecy of a payload that carries the signing identity.** The §6.7.2 bundle transports both long-term seeds, including the Ed25519 signing seed, which authors sigchain records. When the ECDH used `encSK` (before #1865), anyone who captured a `provision_rooms` row — the server operator, a database backup, a subpoena — and later obtained `encSK` alone could decrypt the row and recover the signing seed, collapsing §2.11's independence of the two seeds. With both inputs ephemeral, `shared` exists only while the two ephemeral secrets do. Compromising every long-term key afterwards decrypts no past room. `long_term_keys_cannot_open_a_past_provisioning_room` in `provisioning.rs` tests exactly that, with positive controls.
- The `primaryPubkey` field of the payload post is the primary's **Ed25519 signing** pubkey and MUST equal `sigPK` in the claim. The new device makes no decision on it: the verified claim and the AEAD-authenticated bundle are authoritative (§6.10, unauthenticated metadata). The deployed server treats the field as an opaque string and does not validate it.
- The JSON envelope schemas live in `packages/protocol/schemas/provisioning.ts`: `createRoomBodySchema`, `roomPayloadBodySchema`, `provisionRoomResponseSchema` and `provisionRoomStatusResponseSchema`. There is no claim-body schema. The claim (§6.3.1) and the payload (§6.7) are binary, hex-encoded, and have no Zod schema.

#### 6.3.1 Claim

The claim is how the primary's ephemeral key reaches the new device, signed by the identity being transported. It is binary, hex-encoded on the wire (`hex258`):

```
byte  0       : claim version = 0x01                    (PROVISIONING_CLAIM_VERSION)
bytes 1..33   : ePK_p  — the primary's ephemeral X25519 public key for this room
bytes 33..65  : sigPK  — the primary's long-term Ed25519 signing public key
bytes 65..129 : sig    = Ed25519.sign(sigSK,
                           UTF-8("llamenos:device-provision-claim:v1")   // LABEL_DEVICE_PROVISION_CLAIM
                           || 0x01 || ePK_n || ePK_p)
total         : 129 bytes = 258 hex chars
```

Every field after the label is fixed-length, so the signed message is unambiguous. The new device verifies the claim when it arrives (step 8, before any SAS is shown) and again before decrypting (step 12). Verification uses the new device's **own** `ePK_n`, never a value from the relay:

1. Length exactly 129 bytes and version byte `0x01`; otherwise failure.
2. `ePK_p` is a valid 32-byte X25519 key, not all-zero.
3. `sigPK` decodes to an Ed25519 point and is not of small order.
4. `sig` verifies under RFC 8032 **strict** rules — canonical `S`, no small-order components — over the message above. A claim minted for another room covers a different `ePK_n` and fails here.

What the claim provides: it binds `ePK_p` to this room and to the identity whose seeds the bundle carries. Step 12 checks that the bundle's signing seed derives `sigPK`, so a payload cannot transport an identity other than the one that authorized the room's key. The AAD binds the ciphertext to the exact claim that was verified.

What it does not provide: authentication of the primary to a new device that has no prior knowledge of `sigPK`. An attacker can sign a claim with a key of their own. Defeating a man in the middle is the job of the SAS (§6.6), and that relies on the QR carrying `ePK_n` (§6.4).

#### Server Implementation

Cross-reference: `apps/worker/routes/provisioning.ts` (three routes), `apps/worker/services/identity.ts` (`createProvisionRoom`, `getProvisionRoom`, `setProvisionPayload`, `PROVISION_ROOM_TTL_MS`).

The server stores only the ephemeral pubkey and the encrypted payload — it cannot decrypt the payload or compute the SAS. The `encryptedNsec` field name is retained for backward compatibility with pre-Phase-6 clients; it carries the payload ciphertext described in §6.7 and has never carried a bech32 `nsec` in this protocol.

### Interim Implementation: Seed-Transport Linking

> **Status:** This is what the code does today (`packages/crypto/src/provisioning.rs`, `apps/desktop/src/crypto.rs`). Section 6.1 above describes the target. The difference is not cosmetic — see "What this does not deliver".

Section 6.1 requires a PUK and a sigchain: the new device generates its own keypairs, and the primary wraps the PUK to the new device's X25519 key and authorizes it with a signed sigchain entry. The PUK and sigchain modules exist (`packages/crypto/src/puk.rs`, `packages/crypto/src/sigchain.rs`) but have no application call sites yet, so there is no PUK to wrap and no chain to append to.

Until they are wired, linking transports the primary device's seeds. The §6.3 flow is unchanged (ephemeral–ephemeral X25519 ECDH, signed claim, SAS, `LABEL_PROVISIONING_SALT`/`LABEL_DEVICE_PROVISION` HKDF, `hex(iv || ct_with_tag)` wire format); the payload and import steps are:

```
11'. Build the device key bundle (65 bytes, binary):
     byte  0      : bundle version = 0x01
     bytes 1..33  : primary Ed25519 signing seed
     bytes 33..65 : primary X25519 encryption seed

     BOTH seeds are carried. They are independently random (Section 2.11) and
     neither is derivable from the other, so a device that receives only one
     cannot reconstruct the other: it would hold a different X25519 key than the
     one existing ciphertext was wrapped to, and would decrypt nothing — with no
     error raised on either side.

12'. Encrypt the bundle:
     iv  = random(12)
     ct_with_tag = AES-256-GCM.encrypt(
       key = prov_key,             // as in step 10, unchanged
       iv  = iv,
       message = bundle,
       aad = UTF-8("llamenos:device-provision-bundle:v1")   // LABEL_DEVICE_PROVISION_BUNDLE
             || ePK_n || claim                              // transcript (§6.3.1)
     )
     encryptedPayload = hex(iv || ct_with_tag)

     The AAD is specific to this bundle format, so a payload built for any other
     provisioning format fails the GCM tag check rather than being accepted:
     format changes cannot be silently downgraded.

     Every byte of the payload is inside the AEAD — nothing travels in the clear.
     The AEAD key comes from the same ECDH shared secret the SAS attests, so a
     party that fails SAS comparison cannot produce a payload the new device
     accepts.

17'. The new device checks the bundle version, then adopts BOTH seeds exactly as
     transported and stores them PIN-encrypted (Section 2.11). It does not
     re-derive either seed from the other.

18'. The linked device shares the primary's device identity. It does not
     generate its own keypairs and there is no sigchain entry.
```

#### What this does not deliver

Relative to §6.1, seed-transport linking gives up:

| §6.1 property | Status under the interim seed-transport implementation |
|---|---|
| New device has its own Ed25519/X25519 identity | **Not delivered** — it adopts the primary's |
| Sigchain entry authorizing the new device | **Not delivered** — no chain is written, so a linked device is invisible to device-level authorization and audit |
| Per-device revocation | **Not delivered** — revoking a linked device means rotating the user's keys, because it holds the same ones |
| PUK wrapped per device (`LABEL_PUK_WRAP_TO_DEVICE`) | **Not delivered** — no PUK is in use |
| Long-term secrets never transported | **Not delivered** — both seeds cross the wire (AEAD-protected, SAS-verified) |
| Compromise of one device does not expose others | **Not delivered** — all linked devices share one keypair |

What it does deliver, and §6.1 also requires: a linked device can actually read the user's existing data, and Section 2.11's independence of the signing and encryption seeds is preserved end to end — the encryption key is never a function of the signing key. Since #1865 it also delivers **forward secrecy of the transport**: no long-term key is an ECDH input, so a captured room stays sealed even after every long-term key is compromised (§6.3 notes). Before #1865, a captured room plus the primary's long-term encryption key yielded both seeds, the signing seed included.

Wiring the PUK and sigchain layers, and then implementing §6.1 as written, is the remaining work.

