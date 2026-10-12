# CLAUDE.md — packages/crypto

Shared Rust cryptographic core for the Llamenos crisis response hotline platform. Lives in-repo at `packages/crypto/` — it is **not** a separate repository.

## Overview

This crate provides a single, auditable implementation of all cryptographic operations across all platforms:

- **Desktop (Tauri v2)**: Linked as a native Rust dependency (`apps/desktop/Cargo.toml` path dep)
- **iOS (native SwiftUI)**: Exposed via UniFFI XCFramework (`build-mobile.sh ios`)
- **Android (native Kotlin/Compose)**: Exposed via UniFFI JNI `.so` files (`build-mobile.sh android`)
- **Browser (test builds only)**: Compiled to WebAssembly via `wasm-bindgen`

## Modules

| Module | Purpose |
|--------|---------|
| `labels` | 68 domain separation constants (source of truth: `../../packages/protocol/crypto-labels.json`) |
| `hpke_envelope` | HPKE key wrapping/unwrapping (RFC 9180 X25519-HKDF-SHA256-AES256-GCM) |
| `encryption` | Per-note/message/file envelope encryption (HPKE + AES-256-GCM) |
| `device_keys` | Ed25519 signing + X25519 encryption keypair generation and PIN-protected storage |
| `sigchain` | Append-only, hash-chained, Ed25519-signed device authorization records |
| `puk` | Per-User Key hierarchy + Cascading Lazy Key Rotation (CLKR) |
| `auth` | Ed25519 auth token generation/verification |
| `blind_index` | Blind indexing for server-side E2EE search (HMAC-SHA256) |
| `provisioning` | X25519 ECDH device provisioning with SAS verification |
| `mls` | MLS group management (RFC 9420, OpenMLS 0.9) — **behind the `mls` feature, default-off** (see Feature Flags) |
| `sframe` | SFrame voice E2EE key derivation |
| `padding` | Power-of-2 payload padding (traffic analysis mitigation) |
| `ffi`, `ffi_v3` | UniFFI bindings for iOS/Android |

## Protocol Compatibility

The authoritative reference is `../../docs/protocol/PROTOCOL.md`. Domain separation constants are defined in `../../packages/protocol/crypto-labels.json` and must match generated constants in all clients. NEVER use raw string literals for crypto contexts.

## Development

```bash
# From repo root:
bun run crypto:test          # cargo test
bun run crypto:test:mobile   # cargo test --features mobile (UniFFI tests)
bun run crypto:clippy        # cargo clippy
bun run crypto:fmt           # cargo fmt --check

# Mobile build:
./scripts/build-mobile.sh ios      # Build iOS XCFramework
./scripts/build-mobile.sh android  # Build Android JNI .so files (debug + release variants)
# Android outputs:
#   dist/android/jniLibs-debug/   — test-kdf (x86_64 emulator)
#   dist/android/jniLibs-release/ — production (arm64-v8a + armeabi-v7a)
```

## Feature Flags

- `mobile` — Enable UniFFI scaffolding for iOS/Android. Required for library builds targeting mobile. Without it, the static archive has zero UniFFI symbols.
- `test-kdf` — Use minimal Argon2id params (1MB/1iter/1lane) instead of production params (64MB/3iter/4lanes). For emulator/CI testing only — MUST NEVER be in `default` features or release builds.
- `uniffi-bindgen` — Extends `mobile` with the `uniffi-bindgen` CLI tool.
- `mls` — **Default-off.** Gates `src/mls.rs` and its `openmls`/`openmls_rust_crypto`/`openmls_basic_credential` dependencies. MLS backs hub-state group messaging, which is not required for notes/calls/messaging (all HPKE-based) and is not on the Internal Availability path. The `openmls` → `hpke-rs` → `libcrux` chain has carried aarch64 constant-time-timing advisories (RUSTSEC-2026-0212, -0207, -0208) — gating keeps them out of every shipped iOS/Android binary (`mobile` feature) and the server build (`server` feature) unless a consumer explicitly opts in with `--features mls`. The pinned `openmls` 0.9 / `openmls_rust_crypto` 0.6 / `hpke-rs` 0.7 chain resolves to the patched `libcrux-sha3` 0.0.10 / `libcrux-secrets` 0.0.6, so opt-in `mls` builds are covered as well. Decision recorded in [#708](https://github.com/rhonda-rodododo/llamenos-platform/issues/708). Verify exclusion with `cargo tree -e normal --manifest-path packages/crypto/Cargo.toml | grep libcrux` (empty without `--features mls`).
  - **`Cargo.lock` is not the build graph.** `cargo audit` scans the lockfile, which is feature-agnostic and so lists every optional dependency in the resolved graph — including ones no feature ever enables. `libcrux-kem` 0.0.9 is the standing example: it enters the lockfile as a dep of `hpke-rs-libcrux`, which is an **optional backend** of `hpke-rs` that `openmls_rust_crypto` never selects (it uses `hpke-rs-rust-crypto`). So `libcrux-kem` is compiled by **no** configuration of this crate, `--features mls` included — `cargo tree -e normal --features mls | grep libcrux-kem` is empty, `cargo build --features mls` emits no `liblibcrux_kem*` artefact, and the resulting rlib carries zero `libcrux_kem` symbols. When an advisory lands on a lockfile-only crate, establish reachability from the **build artefacts**, not from the lockfile or the advisory count; the live allowlist entries and their reasoning are in `.cargo/audit.toml`.

## Crypto Architecture

All cryptographic operations use:
- **Signing**: Ed25519 (ed25519-dalek)
- **Key agreement**: X25519 (x25519-dalek)
- **Envelope encryption**: HPKE RFC 9180 (DHKEM(X25519) + HKDF-SHA256 + AES-256-GCM)
- **Symmetric**: AES-256-GCM (PIN storage, items_key, content encryption)
- **KDF**: HKDF-SHA256
- **PIN/passphrase key derivation**: Argon2id (64MB, 3 iterations, 4 parallelism)

Legacy secp256k1/ECIES/Schnorr/XChaCha20-Poly1305 code has been fully removed. No legacy fallbacks exist — this is a pre-production codebase.
