# Crypto simplification audit — `packages/crypto/` and its four consumers

**Date:** 2026-11-14 · **Base:** `origin/main` @ `bf11215e5` · **Ask:** "streamline and improve the
quality and simplicity of the crypto impl without sacrificing security or privacy in any way".

Every claim below cites code on that base. Where I say a function has "no consumer", I mean a
word-boundary search of the hand-written sources of all four consumers came back empty: `apps/desktop/src`,
`src/client`, `apps/worker`, `apps/ios/Sources`, `apps/android/app/src/main` (with the tracked UniFFI
binding `llamenos_core.kt` and the generated directories left out). I searched Swift and Kotlin under
the camelCase name UniFFI generates. The `entity-router` string-dispatch caveat does not apply here:
it dispatches to worker *services*, and none of the crate's FFI symbols is reachable through it.

## Summary

The crate's primitives are sound: HPKE with the label as `info`, label enforcement at open,
Argon2id behind one parameter module, and one multi-reader sealing routine. The complexity sits
in the **surfaces around the crate**, not the primitives:

1. **Logic duplicated outside the crate.** Desktop re-implements Shamir, hub-field AEAD, hub-event
   decryption and the provisioning SAS inline, and mobile carried its own SAS. One of those copies is
   already wrong: the desktop Shamir commitment has no domain separation, so it cannot interoperate
   with mobile (C6).
2. **Two FFI generations side by side.** `ffi.rs` holds stateless hex-secret wrappers and `ffi_v3.rs`
   holds the stateful session. iOS and Android picked *different* subsets for the same flows, and in
   the stateless subset secrets live in Swift or Kotlin memory (C7, C8, C10).
3. **Two HPKE envelope encodings.** Every host rebuilds the `labelId` byte from the label it already
   expects, and iOS does it with a magic `0` (C4).
4. **Dead and parallel APIs.** A second PIN-storage format with no AAD, an export cipher nothing
   calls, and duplicate exports (C9, C10).

Because the repo is pre-production, deleting a duplicate costs nothing today. After M2 each one would
need a migration or a compatibility window. That argument applies to C4, C6, C7, C8 and C9 in
particular.

Verdict counts: **3 landed** in the PR, **10 filed** as issues, **6 leave alone**.

## The PR (provably non-semantic)

| # | Change | Why it is non-semantic | Evidence |
|---|--------|------------------------|----------|
| C1 | `ffi::compute_sas_code` (mobile) delegates to `provisioning::compute_sas` instead of re-implementing it | Same HKDF salt (`SAS_SALT`), info (`SAS_INFO`), output length (4), big-endian read, `% 1_000_000`, `"XXX XXX"` format. The input-length check and the error variants (`HexError`, `InvalidSecretKey`) are kept. The secret copy is now zeroized on drop. The output is unchanged, which is proven by a golden vector **computed outside the crate** (Python `hmac`/`hashlib`: ikm `0x11×32` → `"044 037"`), pinned in both `ffi` and `provisioning` tests. The pre-existing SAS tests only compared two runs of the same function, so they could not fail on a derivation change. | old `ffi.rs:211-233`, `provisioning.rs:234` |
| C2 | Delete `ffi::derive_kek_hex` | `pub(crate)` + `#[allow(dead_code)]`, no caller, not a UniFFI export. Its only test is removed with it, because what it covered was the dead wrapper. `derive_kek_from_pin` is still exercised by the `encrypt_with_pin` tests. | old `ffi.rs:114-122` |
| C3 | Correct stale text | `CryptoError` messages left over from removed crypto: the nonce message said 24 bytes (XChaCha20), but `InvalidNonce` is raised only for 12-byte AES-GCM nonces (`device_keys.rs:160`, `encryption.rs:614`). The public-key message said "x-only" (secp256k1). The PIN message said "6-8 digits", but `is_valid_credential` (`device_keys.rs:307`) requires 8+ digits or an 8+ character passphrase containing a letter. No host string-matches these messages, and `scripts/kotlin-bindings.sh check` passes, so the tracked binding is unchanged. Crate README/CLAUDE.md claimed a **WASM** target, but there is no `wasm-bindgen` dependency or build script anywhere in the repo, and the Playwright build mocks IPC in JS. The real third target is the `server` cdylib (`ffi_server.rs` → `ffi.ts`). The stale label count is removed, the module table now covers every module, and the Cargo.toml `test-kdf` comment said 8 KB where `kdf_params.rs:33` says 1 MB. | `errors.rs`, `README.md`, `CLAUDE.md`, `Cargo.toml`, `scripts/dev-setup.sh` |

Verification: `crypto:test` 313 passed (baseline 312, plus 1 golden), `crypto:test:mobile` 359 passed
(baseline 358, plus 2 new, minus 1 removed), clippy `-D warnings` clean with and without `mobile`,
`fmt --check` clean, `cargo check --features server` clean, and `kotlin-bindings.sh check` OK.

## Issues filed (one per independently landable unit)

### C4 — Two HPKE envelope encodings; every host rebuilds `labelId` — #2771

- **Today.** `HpkeEnvelope {v, labelId, enc, ct}` is base64url (`hpke_envelope.rs:76`). The stored note,
  message and record key envelopes are `KeyEnvelope {enc, ct}` and `RecipientKeyEnvelope {pubkey, enc, ct}`
  in **hex**, with **no `labelId`** (`encryption.rs:32,42`). To open one, each host rebuilds a v3
  envelope from the label it already expects:
  - `src/client/lib/platform.ts:1002-1003` (`toIpcEnvelope`)
  - `apps/ios/Sources/Services/CryptoService.swift:103` (`mobileLabelToId`)
  - `apps/ios/Sources/Models/Extensions.swift:139,143`, which hardcodes `labelId: 0`, a raw magic number for `LABEL_NOTE_KEY`
  - `ffi.rs:hpke_unwrap_key_hex`

  Other stored values carry the full `HpkeEnvelope` JSON, for example platform-role names
  (`platform-roles-section.tsx:134`).
- **What actually defends.** `hpke_seal` and `hpke_open` bind the label as HPKE `info`
  (`hpke_envelope.rs:114,192`). That binding is the cryptographic Albrecht defence: a wrong label fails
  the AEAD. The explicit `resolved_label != expected_label` check (`:159`) is defence in depth, but it
  compares the expected label against itself whenever the host derived the `labelId` from that same
  label. On the stored-key path it can never fire.
- **Simpler shape.** (a) *Non-wire:* add crate entry points that take `(enc, ct, expected_label, aad)`,
  so no host ever builds a `labelId`; delete `toIpcEnvelope`-style shims and the magic `0`. (b) *Wire,
  operator decision:* use one envelope encoding. Either all hex `{enc, ct}` with the label implied by
  context (drop `labelId` and, eventually, the append-only registry's reason to exist for HPKE), or the
  full `HpkeEnvelope` everywhere.
- **Preserves.** Label binding through HPKE `info` (unchanged), and the `label_to_id` registration check
  at seal (unchanged). (b) drops a byte that adds no security when the receiver supplies the label, but it
  does remove the explicit early check for full-envelope readers. Treat that as a decision, not a cleanup.
- **Blast radius.** All three targets and all four consumers. **Wire-format change:** (a) no, (b) yes.
  **Effort:** (a) small to medium, (b) medium. **Worth it:** yes. (a) is unambiguous. (b) is cheap now and
  expensive after M2.

### C5 — Desktop `CryptoState` re-implements crate functions inline — #2766

- **Today.** `apps/desktop/src/crypto.rs` (2720 lines):
  - `encrypt_hub_field` / `decrypt_hub_field` (`:916-985`) are a byte-for-byte copy of `encryption::encrypt_hub_field` / `decrypt_hub_field` (`encryption.rs:483-506`). The crate's own doc says it is "identical to the desktop Tauri command".
  - Hub-event decrypt (`:880-910`) duplicates `ffi_v3::mobile_decrypt_hub_event`.
  - `provision_compute_sas` (`:1576-1612`) is a third copy of the SAS derivation.
- **Simpler shape.** Each command calls the crate function, and the copies are deleted.
- **Preserves.** The same bytes, because the crate functions are already the reference. The crate copy
  also rejects unregistered labels through `require_registered_label`, which the desktop copy repeats
  by hand.
- **Blast radius.** Desktop only, plus `tests/mocks/tauri-core.ts`, which mirrors it. **Wire-format
  change:** no. **Effort:** small. **Worth it:** yes.

### C6 — Desktop Shamir is a second implementation, and its commitment has no domain separation (BUG) — #2764

- **Today.** `apps/desktop/src/crypto.rs:992-1165` re-implements GF(2^8) Shamir (`gf256_mul`, `gf256_inv`,
  `shamir_split`, `shamir_combine`). Its `shamir_commit` (`:1146`) is `SHA-256(x ‖ y)`. The crate's
  `shamir::commit` (`shamir.rs:337`), which mobile calls through `mobile_shamir_commit`, is
  `SHA-256(LABEL_SHAMIR_COMMIT ‖ x ‖ y)`. A commitment made on desktop can never verify on mobile, or
  the reverse. The desktop one also lacks the domain separation the label (registry index 89) was
  added for.
- **Simpler shape.** Desktop commands call `llamenos_core::shamir`, and about 170 lines are deleted.
- **Preserves, and restores.** Domain separation for the commitment, plus one GF(256) implementation
  to audit.
- **Blast radius.** Desktop plus its JS mock. **Wire-format change:** yes, for desktop-produced
  commitments only, which are already incompatible with every other platform. Pre-production, so no
  migration is needed. **Effort:** small. **Worth it:** yes, and before any recovery-group data exists.

### C7 — Desktop provisioning commands predate #1865 and pass a pubkey where a claim is expected — #2765

- **Today.** `provision_decrypt_and_import` (`crypto.rs:1619-1644`) passes `primary_enc_pubkey_hex`
  into the `claim_hex` parameter of `provisioning::decrypt_provisioned_bundle` (`provisioning.rs:484-486`).
  Both are `&str`, so it compiles. It fails closed, because the claim parse rejects a 32-byte key.
  `provision_compute_sas` computes the SAS from a JS-supplied pubkey and **never verifies the signed
  claim**, while the crate's `compute_provisioning_sas` (`provisioning.rs:453`) does. Neither command
  has a caller: `provisionComputeSas` and `provisionDecryptAndImport` in `platform.ts` are referenced
  nowhere. That makes this unwired, not dead.
- **Simpler shape.** Commands take a `claim_hex` and call `compute_provisioning_sas` /
  `decrypt_provisioned_bundle`. In the crate, newtype the hex arguments (`ClaimHex`, `X25519PubHex`) so
  this class of swap stops compiling.
- **Preserves, and restores.** The signed-claim binding (#1865) on the desktop new-device path.
- **Wire-format change:** no. **Effort:** small. **Worth it:** yes, before the flow is wired.

### C8 — Mobile device-linking FFI implements the pre-#1865 protocol and puts secrets in host memory — #2767

- **Today.**
  - iOS uses `generate_ephemeral_keypair_mobile` (`ffi_v3.rs:1085`, whose doc says "the secret IS exposed") and `compute_shared_x_hex` (`ffi.rs:129`). The ephemeral X25519 secret and the raw ECDH output both sit in Swift (`CryptoService.swift:147-167`).
  - Android keeps the ephemeral secret in Rust (`mobile_generate_ephemeral_key`), but `mobile_ecdh_complete` (`ffi_v3.rs:1255`) returns the raw shared secret as hex to Kotlin (`CryptoService.kt:1004,1030`).
  - Both then call `decrypt_with_shared_key_hex` (`ffi.rs:172`), whose own doc says it uses `LABEL_DEVICE_PROVISION` AAD, "cannot open a device key bundle", and that "mobile device linking is not implemented".
- **Simpler shape.** Three stateful exports over the provisioning module: generate-ephemeral (secret held
  in `MobileState`), `compute_provisioning_sas(claim)`, and `decrypt_provisioned_bundle(claim, payload)`.
  The result is imported straight into the session, as desktop does. Delete `compute_shared_x_hex`,
  `generate_ephemeral_keypair_mobile`, `mobile_ecdh_complete`, `decrypt_with_shared_key_hex`, and,
  after the switch, the host-side use of `compute_sas_code`.
- **Preserves, and improves.** No device or ephemeral secret, and no ECDH output, leaves Rust. This is the
  property `ffi_v3`'s header promises and desktop already meets.
- **Wire-format change:** no; it adopts the existing #1865 format. **Effort:** medium, iOS + Android +
  crate. **Worth it:** yes. Mobile linking cannot work today in any case.

### C9 — Event decryption: seven implementations, two formats, keys in host memory — #2768

- **Today.**
  - Hub-key events use AAD `LABEL_HUB_EVENT`, in `ffi_v3.rs:870` `mobile_decrypt_hub_event`, `:905` `…_with_attribution`, `:1120` `…_trial` (a functional duplicate of `with_attribution`, per its own doc), and desktop `crypto.rs:880`.
  - Server events: `ffi.rs:242` `decrypt_server_event_hex` takes the key **from the host**, and iOS and Android both call it (`CryptoService.swift:159`, `CryptoService.kt:938`). Meanwhile `mobile_set_server_event_keys` keeps the same key in Rust. `mobile_decrypt_server_event` (`ffi_v3.rs:940`) also uses AAD `LABEL_HUB_EVENT` under the server key. `mobile_decrypt_server_event_with_epoch` (`:994`) matches what the server emits (`apps/worker/lib/ws-events.ts:58-119`: an HKDF per-epoch key, AAD `LABEL_HUB_EVENT_EPOCH:{epoch}`, and padding). It re-implements `padding::unpad` inline.
  - The server composes these info and AAD strings in TypeScript (`ws-events.ts:64,118`, `hub-event-crypto.ts:117-128`) over the raw `hkdfSha256`/`symmetricEncrypt` FFI.
- **Simpler shape.** One crate `events` module: `seal_server_event` / `open_server_event(epoch)` and
  `seal_hub_event` / `open_hub_event`. The info and AAD composition happens once, in Rust, and is
  exported through `ffi_server` the way `case_record` already is (#2499). Mobile then has one stateful
  open per format, keys never cross into the host, and `decrypt_server_event_hex` plus whichever
  non-epoch server-event path proves unused are deleted (verify against `hub-event-crypto.ts` first).
- **Preserves.** The same AAD and info bytes, now with a single definition. It also enforces "crypto
  decisions belong in the Rust crate".
- **Wire-format change:** no, if the bytes are kept. Deleting a whole format would be a protocol decision.
  **Effort:** medium. **Worth it:** yes.

### C10 — UniFFI surface: unused exports, duplicates, and iOS/Android divergence — #2769

- **No consumer on either platform:** `hpke_wrap_key_hex`, `hpke_unwrap_key_hex`,
  `encrypt_note_for_recipients`, `mobile_wake_key_pubkey`, `encrypt_with_pin`, `decrypt_with_pin`,
  `is_valid_pin` (`encryption.rs`; mobile uses `mobile_is_valid_pin`).
- **Duplicates:** `random_bytes_hex` (`ffi.rs:43`) and `mobile_random_bytes_hex` (`ffi_v3.rs:1060`),
  both used by iOS.
- **Unwired, not dead (keep and flag):** `mobile_recovery_group_split_private_key` (`ffi.rs:629`). The
  recovery-group flow calls `…_generate_keypair` but never splits on mobile.
- **Platform divergence:** of 78 exports, 29 are used by only one platform and 5 by neither. For the same flows, iOS
  uses hub-field encrypt/decrypt and the attribution decrypt, while Android uses `mobile_load_hub_key`,
  the trial decrypt, PUK rotate/unwrap and sigchain verify.
- **Simpler shape.** Delete the unused exports, then merge `ffi.rs` into `ffi_v3.rs` (one mobile surface).
- **Wire-format change:** no. Regenerate the Kotlin binding with `kotlin-bindings.sh sync`.
  **Effort:** small. **Worth it:** yes.

### C11 — Second PIN-storage format and a dead export cipher — #2770

- **Today.** `encryption.rs:533-637` defines `EncryptedKeyData`, `derive_kek_from_pin`,
  `encrypt_with_pin`, `decrypt_with_pin` and `is_valid_pin`. The format has a vestigial `iterations`
  field, AES-GCM with **no AAD**, and no stored KDF parameters. It runs parallel to `device_keys`
  (`derive_kek` `:295`, `EncryptedDeviceKeys`), which is the format every platform actually uses. No
  production consumer exists; iOS only names the type in `Generated/LlamenosCoreExtensions.swift:7` and a
  Keychain JSON test (`KeychainServiceTests.swift:112`). `encrypt_export` (`encryption.rs:509`, HKDF of a
  secret key) has no consumer either. The desktop export is `encryptHubField(json, HKDF_CONTEXT_EXPORT)`
  (`platform.ts:1341`), a *different* construction, so the crate function is a trap for the next caller.
- **Simpler shape.** Delete all of it. Retarget the iOS Keychain test to `EncryptedDeviceKeys`.
- **Preserves.** No live data uses the format. The remaining format is the stronger one.
- **Wire-format change:** no live format changes. **Effort:** small. **Worth it:** yes, and cheap now.

### C12 — One AEAD helper and one RNG helper — #2772

- **Today.** 29 non-test `Aes256Gcm::new_from_slice` call sites in the crate, plus 5 in desktop, each
  re-implementing `nonce(12) ‖ ct ‖ tag(16)` packing, the `< 28` length check and nonce generation. There
  are 27 non-test `getrandom::getrandom(..)` sites. `encryption.rs:99-138` already has the
  right private helpers.
- **Simpler shape.** `aead::{seal_packed, open_packed}` and `rng::array::<N>()`. Each call site maps the
  helper's error to its current variant (`DecryptionFailed` / `WrongPin` / `InvalidCiphertext`), so error
  paths stay identical.
- **Preserves.** The same bytes and the same errors. Land it with per-site known-answer tests first.
- **Wire-format change:** no. **Effort:** medium; it touches most modules. **Worth it:** yes, after
  C5/C9 have removed the call sites that are going away anyway.

### C13 — `CryptoError` is flat and stringly — #2773

- **Today.** `flat_error` (`errors.rs:7`) means hosts get only a message. `InvalidInput(String)` and
  `InvalidFormat(String)` carry dozens of distinct conditions, `InvalidFormat` alone at 47 sites.
  `SignatureVerificationFailed` (16 uses) and `InvalidSignature` (14) mean the same thing. No host
  string-matches today (searched), so this is debt, not a live bug.
- **Simpler shape.** Merge the duplicate variants, and use a non-flat error with typed fields for the
  conditions hosts must branch on (wrong PIN, no hub key, locked).
- **Preserves.** Decrypt failures must stay one opaque `DecryptionFailed`
  (`hpke_envelope.rs:151-153` deliberately collapses them). Do not split that variant.
- **Wire-format change:** no, though the error ABI changes. **Effort:** medium. **Worth it:** later,
  alongside C10.

### C14 — Labels with no consumer, some naming data the encryption scope covers (privacy) — #2774 (and #1876)

- **Today.** 31 of 109 labels in `crypto-labels.json` have no reference in the crate or in any
  hand-written consumer. These include `LABEL_SHIFT_NAME`, `LABEL_RING_GROUP_NAME`,
  `LABEL_SHIFT_OVERRIDE_NOTE`, `LABEL_AVAILABILITY_REASON`, `LABEL_HUB_ROLE_ENCRYPT`, `LABEL_EVENT_DETAILS`
  and `LABEL_TRANSCRIPTION`. For shift and ring-group names the data is confirmed plaintext in an
  `encryptedName` field (`ring-groups-panel.tsx:64`, rendered raw at `__root.tsx:370`). That part is
  already tracked in **#1876**. The others need a per-label answer: encrypted under another label (then the
  label is vestigial), or not encrypted (then it is a privacy bug).
- **Verdict on the registry itself:** leave it alone. Tombstoning unused entries is a wire-format change
  with near-zero benefit. The defect is the missing consumers, not the strings.

### C15 — Docs describe a key hierarchy that does not exist — #2775

The root `CLAUDE.md` "E2EE notes" bullet describes "PUK → items_key → per-note content key (cascading
lazy key rotation)". In code, notes wrap a random per-note key directly for each reader with HPKE
(`encryption.rs:163`, `seal_multi_reader` `:313`). `LABEL_ITEMS_KEY_EXPORT` and `LABEL_NOTE_EPOCH_KEY`
have no code at all. Only the PUK level exists (`puk.rs`), and it is unwired. The fix belongs in the
root `CLAUDE.md`. The same file's labels gotcha ("nothing catches the drift") is also stale: #1646 added
`label_registry_indices_are_append_only` (`labels.rs:1116`), and the JSON `description` was corrected.

## Leave alone (with reasons)

- **L1 — `unwrap` / `expect` / panics across FFI.** Every non-test occurrence is either infallible by
  construction (fixed-length HKDF expands, `try_into` right after a length check such as
  `ffi_server.rs:681,690` or `sframe.rs:261`) or an OS RNG failure. Panicking on an RNG failure is
  correct, because a fallback would be placeholder crypto. UniFFI turns panics into host exceptions. An
  unwind out of an `extern "C"` function in `ffi_server` aborts, which is acceptable for RNG failure.
- **L2 — The PUK / items_key / note-key cascade.** The question was whether all three levels earn their
  keep. Only one level is built, so there is nothing to simplify in code (see C15 for the docs).
  Sigchain and PUK are built but unwired, which makes them planned work, not dead code, and they stay.
- **L3 — The `mls` flag.** Cleanly gated (`lib.rs:39-40`, `#[cfg(feature = "mls")] pub mod mls`). No
  non-MLS path references it, and the dependency chain is excluded from `mobile` and `server` builds.
- **L4 — Labels' two sources of truth.** Already guarded by the append-only snapshot (#1646). The real
  simplification is C4(b), which would remove most of the reason the numeric registry exists.
- **L5 — Multi-admin envelope fan-out.** There is one implementation (`seal_multi_reader` /
  `open_multi_reader`, `encryption.rs:313,373`), shared by stored records and `case_record`. This is
  already the target shape.
- **L6 — PBKDF2 vs HKDF.** The crate uses only Argon2id (through `kdf_params`) and HKDF. PBKDF2 survives
  only in the TS backup *reader* (documented at `backup.rs:12`), so the lead does not hold for the crate.
  The duplicate Argon2 wrapper goes away with C11.

## Ordering

C6 and C7 are bugs, small and desktop-only, so they go first. C5, C10 and C11 are mechanical deletions.
C8 and C9 move secrets back into Rust. C4(a) before C4(b), and C4(b) needs an operator decision. C12 and
C13 come last, once the surfaces have shrunk.
