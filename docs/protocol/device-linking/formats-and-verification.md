# Llamenos Protocol: Device linking: formats, ceremony and conformance

> Part of the [Llamenos Interoperability Protocol](../PROTOCOL.md). Section numbers are stable identifiers; the index maps each one to its file.

### 6.4 QR Code Format

*Status: specified; implemented by no platform. `llamenos-link` does not appear anywhere in the repository, the iOS `Info.plist` registers only the `llamenos` scheme, and the Android manifest registers `llamenos://` with hosts `oauth`/`call`/`hub` only. Registering the scheme on both mobile platforms is part of implementing this subsection.*

One canonical form on all platforms:

```
llamenos-link://provision?r=<roomId>&t=<token>&k=<ePK_n>
```

- `r` — the server-issued room ID.
- `t` — the server-issued opaque token, presented by both devices on every room request.
- `k` — REQUIRED. Unpadded base64url of `ePK_n`, the new device's 32-byte ephemeral X25519 public key (43 characters). The primary MUST take `ePK_n` from here, MUST abort if the room's `ephemeralPubkey` differs (§6.3 step 5), and MUST NOT fall back to the relay's copy. A QR without a well-formed `k` is a parse error.
- `s` — OPTIONAL base64url-encoded server origin, for clients linking against a non-default server. Implementations MUST default to their configured server when `s` is absent.

Parsing rules: the scheme is case-insensitive; unknown query parameters are ignored; any other QR content (raw JSON, `llamenos:provision:…`, a relay host in the authority position, wrong scheme) MUST be rejected with a parse error, never interpreted.

**Why `k` is required.** The QR is the only channel between the two devices that the server and the network cannot write to, and a 6-digit SAS (~20 bits) is only sound if `ePK_n` reaches the primary through it. If a man in the middle can substitute `ePK_n` on the primary's leg, it holds both secrets of that leg, so it learns the primary's SAS the moment the claim is published. It then signs forged claims with its own key, grinding `ePK_p'` until `X25519(eSK_n, ePK_p')` yields the same six digits on the new device. That takes about 10^6 X25519 operations: seconds. With `ePK_n` pinned by the QR, the attacker cannot compute the primary's SAS. A forged claim on the new device's leg then matches with probability 10^-6, and only as one online attempt per ceremony. This defect predates #1865, which closes it here.

### 6.5 Short Code (Manual Entry)

*Status: specified; no derivation exists in code on any platform.*

For users who cannot scan a QR code:

```
short_code = roomId[0..8].toUpperCase()
// e.g., "A1B2C3D4"
```

`roomId` is a `crypto.randomUUID()`, so the first eight characters are its first group.

The short code is a UX fallback for locating the room, not a secret; the token still comes from the primary scanning the full QR or from the user transcribing it. **So does `ePK_n`:** manual entry has no authenticated channel for it other than the user, and without it the SAS is grindable (§6.4). An implementation that offers manual entry MUST require the user to transcribe `k` as well as `t`, and MUST treat the transcribed values exactly as the QR's. **The short code alone is not sufficient to complete a link** — the retired desktop implementation offered a short-code input that could not proceed without the full token, which is a dead end rather than a fallback. An implementation of §6.5 MUST therefore also provide transcribed-token entry, or omit the short code entirely rather than offer a path that cannot complete.

### 6.6 SAS Verification Ceremony

*Status: derivation implemented in `packages/crypto/src/provisioning.rs` (`compute_sas`) and reachable through the FFI on all three platforms; the two-screen ceremony itself is implemented by no client.*

Derivation (both sides, independently):

```
sasBytes = HKDF(SHA-256, ikm=shared,
           salt=UTF-8("llamenos:sas"),
           info=UTF-8("llamenos:provisioning-sas"),
           length=4)
num  = sasBytes[0]<<24 | sasBytes[1]<<16 | sasBytes[2]<<8 | sasBytes[3]   // unsigned big-endian
code = (num % 1000000), zero-padded to 6 digits
display = "XXX XXX"   // two groups of three digits, space-separated
```

Ceremony rules:

1. Each device displays the code **on its own screen**. The SAS or its derivative MUST NOT travel through the relay.
2. The primary device MUST NOT post the payload (step 11) until the user confirms the codes match. The claim step (step 7) is the only pre-confirmation write the primary makes. It exposes the per-room ephemeral public key `ePK_p`, the primary's public signing key, and a signature, and nothing else.
3. The new device MUST NOT import keys (step 14) until the user has confirmed the code it displayed in step 8. A payload that arrives before confirmation is held, unimported.
4. After decryption, the new device re-derives the SAS from the ECDH shared secret and asserts equality with the confirmed code before importing (step 13). Because the payload AEAD key derives from the same shared secret the SAS attests, a party that fails the comparison cannot produce a payload the new device accepts.
5. A mismatch at any point aborts the attempt (§6.10). Both devices discard the ephemeral state and, if the user retries, start a fresh room with fresh ephemeral keys.
6. The primary MUST have obtained `ePK_n` from the QR (or from user transcription, §6.5), never from the relay alone. The 6-digit code resists a man in the middle only under that condition (§6.4).

Security note: 6 digits is ~20 bits of verification entropy. `packages/crypto/src/sas.rs` implements an 80-bit emoji SAS (10 symbols from a 256-entry table, canonically ordered `min(pk) || max(pk) || nonce` as a role-confusion defence) for EP02; it is **not** used by provisioning, which has its own 6-digit `compute_sas`. Migrating the ceremony to the emoji SAS changes only §6.6 and is wire-compatible with the same transport.

### 6.7 Payload Formats

Two payload formats are specified. **Exactly one is in force.** §6.14 is the conformance matrix.

#### 6.7.1 Single-Seed Payload (v0 — superseded)

This is the historical format previously implemented by `packages/crypto/src/provisioning.rs`. PR #1382 replaces it with v1. The AEAD plaintext is the 32 raw bytes of the X25519 secret the primary used for the ECDH — no version byte, no framing:

```
plaintext = the primary's 32-byte X25519 encryption secret (raw)

prov_key  = HKDF(SHA-256, ikm=shared,
              salt=UTF-8("llamenos:provisioning:v1"),
              info=UTF-8("llamenos:device-provision"),
              length=32)
nonce     = random(12)
ct        = AES-256-GCM(key=prov_key, nonce=nonce, message=plaintext,
              aad=UTF-8("llamenos:device-provision"))
wire      = hex(nonce || ct)                     // 12 + 32 + 16 = 60 bytes = 120 hex chars
```

The historical decrypt side rejected any plaintext whose length was not exactly 32 bytes. The AAD is the bare `LABEL_DEVICE_PROVISION` constant, so v0 has no format binding and therefore no downgrade defence.

**v0 carries only one seed, and the primary's Ed25519 signing seed is not transported.** That is the defect recorded in issue #1026 and fixed by §6.7.2. Clients MUST NOT re-derive the missing seed from the transported one: the signing and encryption seeds are generated by independent `getrandom` calls (`packages/crypto/src/device_keys.rs`, and §2.11), so a re-derived key is simply a different key — it silently fails to open every ciphertext wrapped to the real one, with no error on either side. Note that the surviving desktop import path does exactly this re-derivation, which is why it cannot produce a working linked device (§6.14).

#### 6.7.2 Device Key Bundle (v1 — implemented in Rust)

> **Status:** Rust implements this format with the #1865 key agreement and transcript AAD, and the format-binding AAD label is registered (§6.2). The desktop IPC commands predate #1865 and fail closed (§6.14). The end-to-end linking UI and mobile encrypt path remain unimplemented. A v0 and a v1 payload are mutually undecryptable — the AAD differs — so the two formats cannot coexist on one deployment and the cutover must be atomic across compatible clients.

The AEAD plaintext is a 65-byte binary bundle — not JSON:

```
byte  0      : 0x01                                (bundle format version)
bytes 1..33  : primary Ed25519 signing seed        (32 bytes)
bytes 33..65 : primary X25519 encryption seed      (32 bytes)
```

Both seeds are carried, and the new device adopts them exactly as transported. Implementations MUST NOT invent a derivation to shrink the bundle.

Sealing:

```
prov_key = HKDF(SHA-256, ikm=shared,
             salt=UTF-8("llamenos:provisioning:v1"),
             info=UTF-8("llamenos:device-provision"),
             length=32)
nonce    = random(12)                            // fresh per payload, never reused under one prov_key
ct       = AES-256-GCM(key=prov_key, nonce=nonce, message=bundle,
             aad=UTF-8("llamenos:device-provision-bundle:v1")    // LABEL_DEVICE_PROVISION_BUNDLE (§6.2)
                 || ePK_n || claim)                              // 32 + 129 bytes, §6.3.1
wire     = hex(nonce || ct)                      // 12 + 65 + 16 = 93 bytes = 186 hex chars
```

The associated data binds the payload to format v1 and to the room's transcript: a payload built for any other provisioning format, or under any other claim, fails the GCM tag check rather than being accepted, so format changes cannot be silently downgraded. `shared` here is the ephemeral–ephemeral secret of §6.3; the bundle layout itself did not change in #1865, and a payload sealed the pre-#1865 way (long-term ECDH, bare-label AAD) fails the tag check under this one. No shipped client ever exchanged one. The version byte is checked only **after** the tag verifies, so distinguishing tag failures from version failures leaks nothing. `PROVISIONING_BUNDLE_VERSION` is defined in Rust; generated client constants are not required because the version is parsed inside the crypto implementation.

### 6.8 Wire Payloads

*Status: the three endpoints below exist as described unless marked otherwise. §4.19 documents the same API from the REST side; the two MUST agree.*

Room creation (new device, unauthenticated):

```
POST /api/provision/rooms
Body:   { "ephemeralPubkey": hex64 }        // hex(ePK), 32-byte X25519 pubkey
Response: { "roomId": string, "token": string }
```

Payload post (primary device, authenticated):

```
POST /api/provision/rooms/:id/payload
Auth:   Required (primary device session)
Body:   { "token": string,
          "encryptedNsec": hex186,           // §6.7.2 bundle
          "primaryPubkey": hex64 }          // Ed25519 sigPK; MUST equal the claim's
Response: { "ok": true }
Room not found: 404.  Wrong token: 403.  Room expired: 410.
```

Room poll (either device, token required):

```
GET /api/provision/rooms/:id?token=<token>
Response, 200, status "waiting":  { "status": "waiting", "ephemeralPubkey": hex64 }
Response, 200, status "ready":    { "status": "ready", "ephemeralPubkey": hex64,
                                    "encryptedNsec": hex186, "primaryPubkey": hex64 }
Response, 200, status "expired":  { "status": "expired" }          // status only; the row is deleted
Room not found: 404.  Wrong token: 403.
Per-room cap: 3 token presentations per room per 10 minutes → 429 + Retry-After.
```

A `status: "ready"` read **consumes** the room via an atomic `DELETE … RETURNING`; it is single-use.

> **Not implemented.** This specification requires two additions to the above:
>
> ```
> POST /api/provision/rooms/:id/claim                                   [NOT IMPLEMENTED]
> Auth:   Required (primary device session)
> Body:   { "token": string, "primaryClaim": hex258 }                 // §6.3.1
> Response: { "ok": true }
> Effect: room status stays "waiting"; GET responses begin including primaryClaim
> ```
>
> and, consequently, a fourth GET shape: `{ "status": "waiting", "ephemeralPubkey": hex64, "primaryClaim": hex258 }` (the `ready` shape also carries `primaryClaim`, so a new device that missed the waiting poll can still verify). Neither exists in the server, the `provision_rooms` table, the Zod schemas, or any client. The new device needs `primaryClaim` from the poll before it can display the SAS (§6.3 step 8), which is why the claim step exists and why §6.3 is not executable without it. The server stores the claim opaquely; it cannot forge one the new device accepts for this room without the signer's key, and a claim signed with any other key changes the SAS.

Implementations MUST validate field lengths before decoding: `hex64` = 64 hex chars (32 bytes), `hex120` = 120 hex chars (60 bytes), `hex186` = 186 hex chars (93 bytes), `hex258` = 258 hex chars (129 bytes). This is a **client-side obligation only**: the server's Zod schemas enforce minimum lengths (`ephemeralPubkey` ≥ 60 characters; `token`, `encryptedNsec`, `primaryPubkey` ≥ 1) and no hex charset or exact-length check, so a client MUST NOT infer a well-formed peer value from the fact that the server accepted it.

### 6.9 Ordering, Freshness, and Nonce Rules

- **Room TTL.** Rooms expire 5 minutes after creation (`PROVISION_ROOM_TTL_MS` in `apps/worker/services/identity.ts` — a hardcoded constant, not configurable by env var or setting). Polling an expired room returns `200` with `{ "status": "expired" }` and deletes the row; a missing room returns `404` and a wrong token `403`.
- **Single use.** A room is consumed once the new device has fetched the payload: the `status: "ready"` read is an atomic `DELETE … RETURNING`, so exactly one concurrent caller receives the payload and the room cannot be reused. Only `waiting` and `ready` are ever persisted — there is no `consumed` status, because the row is gone. A failed or aborted ceremony starts over: fresh room, fresh token, fresh ephemeral keypair on the new device.
- **No timestamps on the wire.** Freshness is enforced by room TTL plus single-use rooms, not by comparing clocks — device clocks cannot be assumed correct, and no linking message carries a timestamp.
- **Nonce discipline.** The 12-byte GCM nonce MUST be fresh random per payload. Since each room has a fresh ECDH shared secret, `prov_key` is per-room; nonce reuse across rooms is impossible for an honest implementation and catastrophic within one.
- **Token entropy.** The server-issued token is 16 random bytes from `crypto.getRandomValues` — exactly 128 bits, the floor this specification requires, with no margin. It is the room's only access control after creation. The `t` parameter travels in the QR, so the QR itself is the secret — treat displayed-linking screens like a password prompt (auto-hide, no screenshots where the platform supports blocking them).
- **Per-room request cap, and its conflict with polling.** The server caps **token presentations** per room at 3 per 10-minute window, returning `429` with `Retry-After`. The limiter is keyed on the room id and runs *before* the token is validated, so it counts every GET — including correct ones — and the budget is shared between both devices. A new device that polls as §6.3 step 4 directs is therefore rate-limited on its fourth request, and the primary's own GET (step 5) spends from the same three. **An implementation of §6.3 cannot complete the ceremony against the current server without either long-polling/push for the room state or a server change that counts only failed token presentations.** Clients MUST NOT work around this by retry-looping through the 429 (§6.10).
- **Key zeroization.** Ephemeral keys and the shared secret are zeroized after the attempt terminates, success or failure (§2.11 storage applies to the imported seeds). The primary's `eSK_p` lives shorter still: it is consumed by its single ECDH at step 6 and never persisted, so it no longer exists when the payload is posted. Forward secrecy depends on neither ephemeral secret being written to disk or logs.

### 6.10 Failure Modes and the Success-Reporting Rule

The success-reporting rule (issue #1028) is normative:

> **A client MUST NOT report linking success, transition to a success state, enable account access, or persist any "linked" flag unless it has (a) authenticated the payload AEAD tag, (b) satisfied the length and version rules of the payload profile it implements (§6.7.1: plaintext exactly 32 bytes; §6.7.2: 65 bytes with leading `0x01`, plus the step-12 identity checks of §6.3), and (c) persisted the imported key material in §2.11 PIN-encrypted storage.** Every other terminal outcome MUST surface as an explicit failure to the user. A success screen for an exchange that did not happen — including simulated delays standing in for cryptography — is a protocol violation, not a UX choice. This rule is why device linking was withdrawn from the pilot build (#1405) rather than left in place reporting success.

Required behaviour per failure:

| Failure | Detected by | Required behaviour |
|---|---|---|
| SAS mismatch | user comparison (§6.6) | Abort. Primary MUST NOT post the payload; new device MUST NOT import. Discard ephemeral state. |
| SAS re-derivation mismatch after decrypt | new device, step 13 | Treat as tampering: failure, no import, no success state. |
| Room `ephemeralPubkey` ≠ QR `k`, or QR without `k` | primary, step 5 | Abort. Post no claim; the relay has substituted the new device's key. |
| Claim malformed, wrong version, or signature fails (§6.3.1) | new device, steps 8 and 12 | Abort. Display no SAS; no import. A claim for another room fails here. |
| Bundle signing key ≠ claim `sigPK` | new device, step 12, after the tag verifies | Failure; no import. |
| Bundle encryption key = `ePK_p` (primary used its long-term key as the ephemeral) | new device, step 12, after the tag verifies | Failure; no import. Accepting it would adopt an identity whose transport was decryptable by its own long-term key. |
| GCM tag failure | new device decrypt | Failure. Never import partial plaintext. Under §6.7.2 a payload from another format is indistinguishable from tampering at this layer — that is the downgrade defence working; under §6.7.1 there is no such binding. |
| Wrong bundle version byte (§6.7.2 only) | new device, after tag verifies | Failure; no partial import; no downgrade to "best effort". |
| Plaintext length wrong for the active profile | new device | Failure. |
| All-zero ECDH output (low-order peer key) | either device | Failure; reject the peer key. |
| Room not found (404) | either device, polling | Explicit failure UI; offer retry with a fresh room. |
| Wrong token (403) | either device | Explicit failure UI. Note this is a positive room-existence oracle; clients MUST NOT use it to probe. |
| Room expired (200 + `{"status":"expired"}` on GET; 410 on the payload POST) | either device | Explicit failure UI; offer retry with a fresh room. A `200` is **not** success — clients MUST branch on `status`, not on the HTTP code. |
| Per-room cap (429 + Retry-After) | either device | Stop. Surface an explicit failure and let the user restart with a fresh room. MUST NOT retry-loop, and MUST NOT ignore `Retry-After`. |
| Payload arrives before user confirms SAS | new device | Hold unimported until confirmation; the import gate is step 13–14, not payload arrival. |
| Unauthenticated metadata in any envelope | either device | Security decisions MUST be made only on AEAD-authenticated content (inside the tag) or server-authenticated session state. Fields outside the ciphertext are advisory at best — "verify a signature only if the field is present" is a known vulnerability class (the retired iOS implementation), not an acceptable pattern. |

### 6.11 Revocation Interplay

Both payload profiles in §6.7 give every linked device the primary's keypair. Consequences, stated so no client over-promises:

- **Revoking one linked device is impossible without rotating the user's keys.** `DELETE /api/devices/:id` and `DELETE /api/devices` remove device records, and `POST /api/devices/:id/revoke` additionally appends a `device_remove` sigchain link and reports `pukRotationNeeded`. But because linked devices share one Ed25519/X25519 identity, the only effective response to a suspected compromise of any linked device is rotating the user's device keypair — which invalidates every linked device — and re-linking. Clients MUST say "revoke this device and rotate keys", not "revoke this device".
- **Device-level audit cannot distinguish linked devices** under either §6.7 profile. Per-device revocation and audit arrive with the target profile (§6.12) and with per-device hub-key envelopes (#1106) — which do not exist today: `hub_keys` is keyed `(hubId, recipientPubkey)`, one envelope per user per hub, with no device dimension.
- **Logout / delete-all-devices** (the device-lifecycle BDD scenarios in `packages/test-specs/features/security/device-lifecycle.feature`) deletes the device rows, and the push and VoIP tokens with them because they are columns on `devices`. It does not rotate keys and does not unlink other devices by itself. Note that `DELETE /api/devices/:id` documents itself as triggering PUK rotation but does not — only `POST /api/devices/:id/revoke` touches the sigchain.

### 6.12 Relationship to the Identity Layer (Target Profile)

This spec's transport **assumes an authorized device set**: the primary is an authenticated, already-authorized device, and linking copies that authorized identity to a new device under SAS verification. Linking does not create authorization.

The target profile — to be specified as a payload revision once the identity layer (§2.11, "Device Authorization (Sigchain)") has a PUK and sigchain in active use on the clients — changes only the payload and the claim body:

1. The new device generates its **own** Ed25519 + X25519 keypairs (§2.11) and publishes its pubkeys via the claim step (a `devicePubkey` field added to the claim body).
2. The payload becomes an HPKE-wrapped PUK (`LABEL_PUK_WRAP_TO_DEVICE`, §2.1) to the new device's X25519 key, **plus a mandatory primary-signed sigchain entry** authorizing the new device. The sigchain entry travels inside the AEAD; there is no optional authorization field, and a missing entry is a hard failure — never a skipped check.
3. The new device opens the PUK, verifies the sigchain entry against the primary's signing key, appends the entry to its local chain view, and only then reports success (the §6.10 rule is unchanged: success means imported keys **and** verified authorization).

Current state of the prerequisites, stated precisely because the gap is what makes the target profile unbuildable today: the PUK envelope endpoints exist (`POST/GET /api/puk/envelopes`) and every platform wraps the PUK FFI, but **no client code calls any of it**; sigchain is wired for recovery-group enrollment (one desktop flow) and for the optional fields on device revoke, which no client sends. Shipping half the target — a PUK wrap with no sigchain entry — would create an unauthorized device the system accepts: a live cryptographic hole traded for today's honest limitation. Implementations MUST therefore exchange the §6.7.2 payload and MUST NOT improvise authorization proofs.

Wire compatibility: the payload field is opaque, versioned hex. The target profile mints a new AAD label and bundle version and changes only the §6.7 payload and the claim body; the QR format (§6.4), room transport (§6.8), SAS ceremony (§6.6), and all failure rules (§6.10) are unchanged. Every new AAD label is subject to the registration rule in §6.2.

### 6.13 Worked Examples (Test Vectors)

Fixed inputs (test vector only — never real keys):

| Value | Hex |
|---|---|
| Primary X25519 encryption seed | `0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20` |
| Primary Ed25519 signing seed | `2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40` |
| New-device ephemeral secret `eSK_n` | `65666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f8081828384` |
| Primary ephemeral secret `eSK_p` | `a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0` |
| GCM nonce | `c9cacbcccdcecfd0d1d2d3d4` |

Public keys an implementation must reproduce:

| Value | Hex |
|---|---|
| Primary encryption pubkey `encPK` (long-term) | `07a37cbc142093c8b755dc1b10e86cb426374ad16aa853ed0bdfc0b2b86d1c7c` |
| Primary signing pubkey `sigPK` (long-term) | `e7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0` |
| New-device ephemeral pubkey `ePK_n` | `5714769d116bf76436ae74bc793d2c30ad1903c59ac5273805c7e2698b410c36` |
| Primary ephemeral pubkey `ePK_p` | `ad438bfae31f6c093d61d4339255ea798092c9fadd07b97827f4b0ae9dee7c1c` |

#### 6.13.1 Historical vectors (pre-#1865 key agreement — not accepted)

Before #1865 the ECDH was `X25519(encSK, ePK_n)`, with the primary's **long-term** key. These values identify that wire format; the current implementation rejects both payloads, because the key agreement and the AAD both differ.

| Value | Hex / result |
|---|---|
| ECDH shared secret `X25519(encSK, ePK_n)` | `c9ea6a3f79a000b60b076d4afc990b272f3f0b5aaa3f0b8713c209273e363863` |
| `prov_key` | `27daf7f82e9d4b2403fdc17443328eb86392ae64a4fac8685f3f3c65057c643c` |
| SAS code | `879 691` |
| v0 payload (§6.7.1; 32-byte encryption seed; AAD `llamenos:device-provision`) | `c9cacbcccdcecfd0d1d2d3d411e7a3b9316aa1661a22d9e86b6b2b015249daa992dd539befc2907ea6efc1d8e9aed88786ec11cc010a453950c37aca` |
| Pre-#1865 v1 payload (65-byte bundle; AAD `llamenos:device-provision-bundle:v1` alone) | `c9cacbcccdcecfd0d1d2d3d411c4829e104980493b01f8cf4a480a3e736afb8eb3fe72b4cee1b15987cce0c73f461cd2912f7b48fa0a7ca96122c00a7f25065905402ac27d9efcc201bb98825d7c072b748c37c2db0bd9a07da456e8ad` |

#### 6.13.2 v1 bundle payload with signed claim (§6.3.1, §6.7.2 — implemented)

| Value | Hex / result |
|---|---|
| ECDH shared secret `X25519(eSK_p, ePK_n)` = `X25519(eSK_n, ePK_p)` | `668b4fdf4b11fe97f88760b64ea39652f57fdea46b4df43b3ea4ea9948f7680a` |
| `prov_key` (HKDF, §6.7.2) | `7bcd50b37c674739a2cb7e33383701e91adcd8eb5ee169050272203ae605f87e` |
| SAS HKDF output (4 bytes) | `e91868d4` (= 3910691028 unsigned big-endian; `3910691028 % 1000000 = 691028`) |
| SAS code | **`691 028`** |
| Claim signed message (`LABEL_DEVICE_PROVISION_CLAIM` ‖ `01` ‖ `ePK_n` ‖ `ePK_p`) | `6c6c616d656e6f733a6465766963652d70726f766973696f6e2d636c61696d3a7631015714769d116bf76436ae74bc793d2c30ad1903c59ac5273805c7e2698b410c36ad438bfae31f6c093d61d4339255ea798092c9fadd07b97827f4b0ae9dee7c1c` |
| Ed25519 signature (deterministic, RFC 8032) | `a9a87061ba9144381a58c15b1abb30ef27cbb5b0506f8a8da3a034a9f09b4069f327fd151f70544c88c2761bee46d1b1f8fdcc0e96b370bffe36a53f76d09e0c` |
| Claim `primaryClaim` (258 hex chars) | `01ad438bfae31f6c093d61d4339255ea798092c9fadd07b97827f4b0ae9dee7c1ce7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0a9a87061ba9144381a58c15b1abb30ef27cbb5b0506f8a8da3a034a9f09b4069f327fd151f70544c88c2761bee46d1b1f8fdcc0e96b370bffe36a53f76d09e0c` |
| Ciphertext with tag | `87dfa871dd6003ff9ef91ba34caa45b28cfdaa97fad9cb1df66b4316bb4bc162eb95d3453505ea3cd9f70d3f3e121c028bef21259069df3598fe2fb67bd5e523ed81d37cae5d420e0e36f90dcada15c374` |
| Wire payload `encryptedNsec` (186 hex chars) | `c9cacbcccdcecfd0d1d2d3d487dfa871dd6003ff9ef91ba34caa45b28cfdaa97fad9cb1df66b4316bb4bc162eb95d3453505ea3cd9f70d3f3e121c028bef21259069df3598fe2fb67bd5e523ed81d37cae5d420e0e36f90dcada15c374` |

Verification procedure:

1. Rebuild the claim from `ePK_p`, `sigPK` and the signature, and verify it per §6.3.1 against `ePK_n`.
2. Compute the shared secret from either side; both give the value above. Derive `prov_key` and the SAS per §6.6/§6.7.2; both devices must display `691 028`.
3. Decrypt the wire payload with `prov_key`, nonce `c9cacbcccdcecfd0d1d2d3d4`, and AAD `UTF-8("llamenos:device-provision-bundle:v1") || ePK_n || claim`. The plaintext must be `01`, then the signing seed, then the encryption seed, all from the table above.
4. Negative checks: the same payload under the bare label AAD, or under the v0 AAD, MUST fail the tag check. The long-term `X25519(encSK, ePK_n)` shared secret of §6.13.1 MUST NOT open it.

#### Pinning

`protocol_worked_example_6_13_2` in `packages/crypto/src/provisioning.rs` decrypts the §6.13.2 payload and reproduces its claim byte for byte, so this table and the implementation cannot drift apart. The values were computed independently with `@noble/curves`, `@noble/hashes` and `@noble/ciphers`. `packages/crypto/tests/interop.rs` additionally emits a fresh provisioning vector into `packages/crypto/tests/fixtures/test-vectors.json` (gitignored, written at test time), and `tests/crypto-interop.spec.ts` verifies it in JS: claim signature, ECDH against `ePK_p`, transcript AAD, both seeds, SAS, and that the long-term key does not open it. That vector's primary ephemeral and nonce are random, so it differs on every run.

### 6.14 Conformance Matrix

What exists at the time of writing, with evidence. This table is the thing to update first when any part of §6 is implemented; a normative claim elsewhere in §6 that contradicts it is a defect in §6.

| Surface | Status | Evidence |
|---|---|---|
| `POST /api/provision/rooms` | **Implemented** | `apps/worker/routes/provisioning.ts`; unauthenticated, min-length validation only |
| `GET /api/provision/rooms/:id` | **Implemented**, shapes per §6.8 | `apps/worker/services/identity.ts` `getProvisionRoom`; atomic single-use consume |
| `POST /api/provision/rooms/:id/payload` | **Implemented**, authenticated | `provisioning.ts`; `senderPubkey` accepted but never stored or checked |
| `POST /api/provision/rooms/:id/claim` | **Not implemented** | No route, no schema, no column; `primaryClaim` appears nowhere outside this document and `packages/crypto` |
| `primaryClaim` on GET | **Not implemented** | `provision_rooms` has no such column |
| Per-room cap (3 / 10 min) | **Implemented**, counts correct polls too | `provisioning.ts`; blocks a conforming polling client (§6.9) |
| Room TTL 5 min | **Implemented**, hardcoded | `identity.ts` `PROVISION_ROOM_TTL_MS` |
| Exact hex-length validation (§6.8) | **Not implemented** server-side | `packages/protocol/schemas/provisioning.ts` uses `min()` only |
| §6.7.1 v0 payload (seal/open) | **Superseded** | Historical format; current Rust provisioning uses v1 |
| §6.7.2 v1 bundle payload, transcript AAD | **Implemented** in Rust | `packages/crypto/src/provisioning.rs` |
| Ephemeral–ephemeral key agreement (§6.3) | **Implemented** in Rust | `provisioning.rs` `encrypt_device_bundle_for_provisioning` (fresh `EphemeralSecret` per room, consumed by its one ECDH); forward secrecy pinned by `long_term_keys_cannot_open_a_past_provisioning_room` |
| Claim seal / verify (§6.3.1) | **Implemented** in Rust | `provisioning.rs` `compute_provisioning_sas` (verify, then SAS) and `decrypt_provisioned_bundle` (verify, decrypt, identity checks); not yet exported over UniFFI or WASM |
| `LABEL_DEVICE_PROVISION_CLAIM` | **Registered** as `labelId` 100 | `crypto-labels.json`, `labels.rs`, `label-registry.wire.snapshot`, generated constants |
| QR `k` parameter (§6.4) | **Not implemented** | no QR encoder or parser exists |
| `LABEL_DEVICE_PROVISION_BUNDLE` | **Registered** as `labelId` 99 | `crypto-labels.json`, `labels.rs`, generated constants (§6.2) |
| `PROVISIONING_BUNDLE_VERSION` | **Defined** in Rust | `packages/crypto/src/provisioning.rs` |
| 6-digit SAS derivation | **Implemented** in Rust + reachable via FFI on all platforms | `provisioning.rs` `compute_sas`; `packages/crypto/src/ffi.rs` |
| Two-screen SAS ceremony | **Not implemented** on any client | no link UI exists (#1405); and not constructible without the claim step |
| QR encode / decode (§6.4) | **Not implemented** | `llamenos-link` appears nowhere in the repository |
| `llamenos-link` URI scheme registration | **Not registered** | iOS `Info.plist` and the Android manifest register only `llamenos://` |
| Short code (§6.5) | **Not implemented** | no derivation in any client |
| Primary-device encrypt path, mobile | **Not implemented** | iOS and Android wrap only `compute_shared_x_hex` / `decrypt_with_shared_key_hex`; neither has an encrypt side, so neither can act as primary |
| Desktop IPC commands | **Pre-#1865; fail closed; no linking UI** | `apps/desktop/src/crypto.rs`: the primary-side `provision_encrypt_for_device` was **removed** (#2158) — it sealed both device seeds to a webview-chosen key with no native confirmation, so the desktop has no primary-side linking command until one is rebuilt behind a Rust-owned, user-confirmed session. `provision_compute_sas` runs a raw ECDH against whatever key it is given. `provision_decrypt_and_import` passes that key where the claim is expected and is rejected with `InvalidFormat`. To conform, desktop must forward `claimHex` and call `compute_provisioning_sas` |
| Desktop Playwright IPC mock | **Pre-#1865** | `tests/mocks/tauri-core.ts` still mirrors the long-term-key ECDH and bare-label AAD |
| Target profile (PUK + sigchain) | **Not implemented** | PUK endpoints and FFI exist with no client callers; sigchain wired only for recovery-group enrollment and the unused revoke fields (§6.12) |

---

