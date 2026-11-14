# packages/crypto

Shared Rust cryptographic core for Llamenos. All cryptographic operations are implemented **once** in this crate and compiled to three targets (native, UniFFI, and a C-ABI `cdylib` for the server):

| Target | How | Used by |
|--------|-----|---------|
| Native Rust | Path dependency in `apps/desktop/Cargo.toml` | Tauri desktop (keys never enter webview) |
| UniFFI XCFramework | `./scripts/build-mobile.sh ios` | iOS SwiftUI client |
| UniFFI JNI `.so` | `./scripts/build-mobile.sh android` | Android Kotlin/Compose client |
| C-ABI `cdylib` (`--features server`) | `./scripts/build-server.sh`, loaded by `ffi.ts` via `bun:ffi` | Bun backend (`apps/worker`) |

There is no WASM build. The Playwright test build does not load this crate at all: it
aliases the Tauri IPC layer to the JavaScript mock in `tests/mocks/`.

## What it provides

- **HPKE envelope encryption** (RFC 9180, X25519-HKDF-SHA256-AES256-GCM) — key wrapping for notes, messages, files, hub key, PUK
- **Ed25519/X25519 device keys** — per-device signing + encryption keypairs; PIN-protected storage via Argon2id
- **Sigchain** — append-only, hash-chained, Ed25519-signed device authorization log
- **PUK (Per-User Key)** — user-level key hierarchy with Cascading Lazy Key Rotation (CLKR)
- **Domain separation labels** — Albrecht defense; enforced at decrypt. The label strings live in `../protocol/crypto-labels.json`; the numeric `labelId` is the index into `LABEL_REGISTRY` (`src/labels.rs`), pinned append-only by `label-registry.wire.snapshot`. Do not restate the count anywhere — it changes.
- **Blind indexing** — HMAC-SHA256-based server-side search over encrypted data
- **MLS** (RFC 9420, OpenMLS 0.9) — group key management for hub state, behind the default-off `mls` feature
- **SFrame** — voice E2EE key derivation
- **Payload padding** — power-of-2 bucketing for traffic analysis resistance

## Building

```bash
# From repo root
bun run crypto:test           # cargo test
bun run crypto:test:mobile    # cargo test --features mobile
bun run crypto:clippy         # lint
bun run crypto:fmt            # format check

# Mobile
./scripts/build-mobile.sh ios      # → LlamenosCoreFFI.xcframework
./scripts/build-mobile.sh android  # → libllamenos_core.so (multiple ABIs)
```

## Key rules

- **Never use raw string literals for crypto contexts** — always use constants generated from `../protocol/crypto-labels.json`
- **HPKE for all key wrapping** — Ed25519/X25519 + HPKE (RFC 9180) is the only crypto path
- **`mobile` feature is required** for iOS/Android library builds — without it, the static archive has zero UniFFI symbols
- Private key material uses `zeroize::Zeroizing<>` throughout; secrets are cleared on lock/drop

## Security docs

- `docs/security/CRYPTO_ARCHITECTURE.md` — full primitive inventory, key hierarchy, envelope format
- `docs/protocol/PROTOCOL.md` — wire formats and protocol contracts
- `docs/security/THREAT_MODEL.md` — adversary profiles and trust boundaries
