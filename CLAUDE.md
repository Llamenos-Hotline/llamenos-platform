# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Llámenos is a secure crisis response hotline app. Callers dial a phone number; calls are routed to on-shift volunteers via parallel ringing. Volunteers log notes in the app. Admins manage shifts, volunteers, and ban lists. The app must protect volunteer and caller identity against well-funded adversaries (nation states, right-wing groups, private hacking firms).

**Status: Pre-production.** No legacy fallbacks or data migrations needed. No production SDLC yet.

## Multi-Platform Architecture

Monorepo containing all platforms, shared crypto, and protocol definitions:

| Directory | Purpose |
|-----------|---------|
| `apps/desktop/` | Tauri v2 desktop shell (Rust) |
| `apps/worker/` | Bun HTTP server (Hono + PostgreSQL; directory name retained — rename is separate epic) |
| `apps/ios/` | Native SwiftUI iOS client |
| `apps/android/` | Native Kotlin/Compose Android client |
| `packages/crypto/` | Shared Rust crypto crate (native + WASM + UniFFI) |
| `packages/shared/` | Cross-boundary TypeScript types and config |
| `packages/protocol/` | JSON Schema definitions + codegen (TS/Swift/Kotlin) |
| `packages/i18n/` | Localization files + iOS/Android string codegen |

All platforms implement the same protocol: `docs/protocol/PROTOCOL.md`

## Tech Stack

- **Runtime/Package Manager**: Bun (monorepo with `workspaces`)
- **Tooling**: [mise](https://mise.jdx.dev/) — polyglot version manager; pins Bun 1.3.5, JDK 17, Ruby 3.3. Rust/Swift are NOT mise-managed (handled by `rust-toolchain.toml` / Xcode). Run `mise install` once after cloning.
- **Desktop**: Tauri v2 + Vite + TanStack Router + shadcn/ui — native Rust backend with webview frontend
- **iOS**: Native SwiftUI (iOS 17+, `@Observable`, SPM)
- **Android**: Native Kotlin 2.3/Compose (minSdk 26, Material 3, Hilt DI + KSP, AGP 9.1, Gradle 9.4)
- **Backend**: Bun HTTP server (Hono + PostgreSQL, self-hosted), Cloudflare Workers (marketing site only)
- **SIP Bridge**: Protocol-agnostic SIP bridge (`sip-bridge/`), PBX_TYPE selects ARI/ESL/Kamailio backend
- **Shared Crypto**: `packages/crypto/` Rust crate — single auditable implementation for all platforms (native, WASM, UniFFI)
- **Protocol**: `packages/protocol/` JSON Schema → codegen (TypeScript, Swift, Kotlin via quicktype-core)
- **Telephony**: 8 providers via `TelephonyAdapter` interface (Twilio, SignalWire, Vonage, Plivo, Telnyx, Bandwidth, Asterisk, FreeSWITCH). `SipBridgeAdapter` base class for ARI/ESL/Kamailio backends. `PBX_TYPE` env var selects backend for `sip-bridge/`.
- **Auth**: Ed25519/X25519 per-device keys for E2EE + WebAuthn session tokens for multi-device support
- **i18n**: `packages/i18n/` — 22 locales (source of truth: `packages/i18n/languages.ts`; never hardcode a count/list elsewhere — `bun run i18n:validate` fails loudly if one drifts from `packages/i18n/locales/`) + codegen for iOS `.strings` and Android `strings.xml`
- **Deployment**: Docker Compose / Helm (VPS self-hosted), Cloudflare Tunnels for ingress. EU/GDPR-compatible.
- **Testing**: E2E via Playwright (desktop), XCUITest (iOS), Compose UI tests (Android), Cucumber BDD (Android E2E), backend BDD; Rust tests via `cargo test`
- **Desktop Security**: Tauri Stronghold (encrypted vault), isolation pattern, CSP, single-instance
- **Load Testing**: k6-based load tests for calls, messages, and mixed traffic (`bun run load:*`)

## Architecture Roles

| Role | Can See | Can Do |
|------|---------|--------|
| **Caller** | Nothing (GSM phone) | Call the hotline number |
| **User with Volunteer role** | Own notes only | Answer calls, write notes during shift |
| **Admin** | All notes, audit logs, active calls, billing data | Manage volunteers, shifts, ban lists, spam mitigation settings |

## Security Requirements

These are non-negotiable architectural constraints, not guidelines:

- **E2EE / zero-knowledge**: The server should not be able to read call notes, transcripts, or PII. Encrypt at rest minimum; E2EE where feasible.
- **User identity protection**: Personal info (name, phone) visible only to admins, never to other users or callers.
- **Call spam mitigation**: Real-time ban lists, optional CAPTCHA-like voice bot detection (randomized digit input), network-level rate limiting. Admins toggle these in real-time.
- **Audit logging**: Every call answered, every note created — visible to admins only.
- **GDPR compliance**: EU parent org, data handling must comply.

## Directory Structure

```
apps/
  desktop/            # Tauri v2 desktop shell (Rust)
    src/lib.rs        # Tauri setup (plugins, tray, IPC handlers)
    src/crypto.rs     # IPC command wrappers delegating to packages/crypto
    Cargo.toml        # Dependencies including packages/crypto path dep
    tauri.conf.json   # Tauri config (CSP, window, bundle, plugins)
    capabilities/     # Tauri capability permissions
  worker/             # Bun HTTP server (Hono + PostgreSQL; directory name retained — rename is separate epic)
    routes/           # Hono route handlers
    db/               # Drizzle ORM schemas + migrations (bun-jsonb custom type)
    services/         # Business logic service classes
    telephony/        # TelephonyAdapter interface + 8 adapters (incl. SipBridgeAdapter base)
    messaging/        # MessagingAdapter interface + SMS, WhatsApp, Signal, Telegram, RCS adapters
    lib/              # Auth, crypto, webauthn utilities
    # (no wrangler.jsonc — see site/wrangler.jsonc for marketing site)
  ios/                # Native SwiftUI iOS client
    Sources/          # Swift source (App/, Services/, Views/, ViewModels/)
    Tests/            # XCTest + XCUITest
    Package.swift     # SPM config
  android/            # Native Kotlin/Compose Android client
    app/src/main/     # Kotlin source (crypto/, api/, ui/, di/, service/)
    gradle/           # Version catalog (libs.versions.toml)
sip-bridge/           # Protocol-agnostic SIP bridge (replaces asterisk-bridge/); PBX_TYPE selects ARI/ESL/Kamailio
signal-notifier/      # Zero-knowledge Signal notification sidecar (port 3100; HMAC-hashed contact resolution)
packages/
  crypto/             # Shared Rust crypto crate (native + WASM + UniFFI)
    src/              # Rust source (HPKE/X25519-HKDF-SHA256-AES256-GCM, Ed25519/Schnorr, PBKDF2, HKDF, XChaCha20-Poly1305, SFrame, MLS)
    scripts/          # Build scripts (build-mobile.sh for iOS/Android)
    Cargo.toml        # Crate config
  shared/             # Cross-boundary TypeScript types and config
    types.ts          # Shared types (CustomFieldDefinition, NotePayload, etc.)
    crypto-labels.ts  # Domain separation constants (re-exported from protocol)
  protocol/           # Cross-platform type codegen (Zod → quicktype)
    schemas/          # 80+ Zod schema files (source of truth for all types)
    tools/codegen.ts  # Zod → toJSONSchema() → quicktype → TS/Swift/Kotlin (with Kotlin default injection + Swift renaming)
    tools/schema-registry.ts  # Maps 85+ Zod schemas to named JSON Schemas
    openapi-snapshot.json     # OpenAPI spec snapshot (written by dev server on startup)
    generated/        # Auto-generated types — GITIGNORED (typescript/, swift/, kotlin/)
    crypto-labels.json # Domain separation constants (source of truth; see file for current count)
  i18n/               # Localization package
    locales/          # 22 locale JSON files — see packages/i18n/languages.ts for the current list
    languages.ts      # Language config (codes, labels, Twilio voice IDs)
    tools/            # i18n-codegen.ts → iOS .strings + Android strings.xml + Kotlin I18n.kt
                      # validate-strings.ts → cross-platform string ref validator
  test-specs/         # Cross-platform BDD Gherkin specs (129 .feature files tagged @backend/@desktop/@ios/@android)
    features/         # Gherkin feature files (core/, admin/, security/, shifts/, platform/{desktop,mobile}/)
    tools/validate-coverage.ts  # Cross-platform scenario-to-implementation coverage checker
src/
  client/             # Frontend SPA (Vite + React)
    routes/           # TanStack file-based routes
    components/       # App components + ui/ (shadcn primitives)
    lib/              # Client utilities (auth, platform, ws, i18n, hooks)
      platform.ts     # Platform abstraction — Tauri IPC to Rust CryptoState
tests/
  mocks/              # Tauri IPC mock layer for Playwright test builds
  steps/              # BDD step definitions organized by domain (backend-owned)
docs/
  protocol/PROTOCOL.md  # Cross-platform wire format, crypto, API, permission spec
  epics/              # Feature epic documents
```

**Path aliases** (tsconfig.json + vite.config.ts):
- `@/*` → `./src/client/*`
- `@worker/*` → `./apps/worker/*`
- `@shared/*` → `./packages/shared/*`
- `@protocol/*` → `./packages/protocol/*`
- `@llamenos/i18n` → `./packages/i18n/index.ts`

## Key Technical Patterns

- **Multi-hub routing axiom**: Any authenticated user — regardless of role — can be a member of multiple hubs simultaneously. The app must receive calls, push notifications, and relay events from ALL member hubs regardless of which hub is currently active in the UI. The active hub controls browsing context only. **Never gate incoming call or notification handling on active hub state.** Background push handlers must never call `setActiveHub` — only explicit user tap actions or the app-unlocked call answer path may switch the active hub.
- **TelephonyAdapter**: Abstract interface for 8 voice providers (Twilio, SignalWire, Vonage, Plivo, Telnyx, Bandwidth, Asterisk, FreeSWITCH). `SipBridgeAdapter` is a shared base class for Asterisk and FreeSWITCH. `PBX_TYPE` env var selects ARI/ESL/Kamailio for `sip-bridge/`. All telephony logic goes through this adapter — never call provider APIs directly from business logic.
- **MessagingAdapter**: Abstract interface for text messaging channels (SMS, WhatsApp, Signal, Telegram, RCS/Google RBM). Signal adapter is complete (receipts, reactions, typing, registration, retry queue, identity trust, failover). Inbound webhooks route to the conversation service.
- **Parallel ringing**: All on-shift, non-busy volunteers ring simultaneously. First pickup terminates other calls.
- **Shift routing**: Automated, recurring schedule with ring groups. Fallback group if no schedule is defined.
- **E2EE notes**: Per-note forward secrecy — unique random key per note, HPKE-wrapped for each reader via PUK (Per-User Key). PUK → items_key → per-note content key (cascading lazy key rotation). Dual-encrypted: one copy for volunteer, one for each admin (multi-admin envelopes).
- **E2EE messaging**: Per-message envelope encryption — random symmetric key, HPKE-wrapped for assigned volunteer + each admin. Server encrypts inbound on webhook receipt, discards plaintext immediately.
- **HPKE crypto**: RFC 9180 X25519-HKDF-SHA256-AES256-GCM replaces secp256k1 ECIES everywhere. Ed25519/X25519 per-device keys (no more single nsec per user). Label enforcement at decrypt (Albrecht defense — domain separation labels defined in `packages/protocol/crypto-labels.json`).
- **User sigchain**: Append-only hash-chained, Ed25519-signed device authorization records. PUK (Per-User Key) with Cascading Lazy Key Rotation. MLS via OpenMLS (behind `mls` feature flag) for hub state.
- **SFrame voice E2EE**: Key derivation integrated into `packages/crypto` for encrypted voice channel media.
- **Platform abstraction**: `src/client/lib/platform.ts` is Tauri-only — all crypto calls route through Rust via IPC. Device private keys NEVER enter the webview. Always import from `platform.ts`, never from `@tauri-apps/*` directly.
- **packages/crypto**: Shared Rust crypto crate (formerly separate `llamenos-core` repo). All crypto operations (HPKE, Ed25519/Schnorr, PBKDF2, HKDF, XChaCha20-Poly1305, SFrame, MLS) implemented once in Rust, compiled to native (Tauri), WASM (browser), and UniFFI (mobile). Desktop links via `apps/desktop/Cargo.toml` path dep to `../../packages/crypto`.
- **Signal notification sidecar**: `signal-notifier/` at port 3100. Zero-knowledge: resolves contacts via HMAC-hashed identifiers, never stores plaintext phone numbers. Shared `SIGNAL_NOTIFIER_BEARER_TOKEN` between app and sidecar.
- **Firehose inference agent**: LLM-powered message extraction using OpenAI-compatible SDK. Processes incoming message streams for structured data extraction.
- **Blast/Broadcast service**: PostgreSQL-backed delivery queue with per-channel rate limiting. Manages batched delivery of bulk messages (SMS/WhatsApp/Signal/Telegram/RCS) with per-recipient status tracking and retry logic.
- **Kubernetes health probes**: `/health/ready` and `/health/live` endpoints. Prometheus ServiceMonitor configured. Caddyfile.production with security headers. Ansible preflight + smoke-check playbooks.
- **Protocol codegen**: `packages/protocol/tools/codegen.ts` generates Swift Codable structs and Kotlin @Serializable data classes from Zod schemas (via `toJSONSchema()` + quicktype). Also generates crypto label constants from `crypto-labels.json`. Zod schemas in `packages/protocol/schemas/` are the single source of truth (moved from `apps/worker/schemas/`). Schema registry in `packages/protocol/tools/schema-registry.ts` maps 85+ Zod schemas to named types. Kotlin post-processor injects `@Serializable` defaults for `.optional().default()` fields. Swift post-processor strips convenience extensions, adds `Sendable`, renames 15 types that shadow builtins. Run `bun run codegen` after schema changes. Generated output is gitignored — codegen runs as a build prerequisite.
- **Key management**: PIN-encrypted per-device Ed25519/X25519 keys stored in Tauri Store (desktop), iOS Keychain, or Android Keystore (EncryptedSharedPreferences). Rust CryptoState holds device private key; UI only sees pubkey. Device linking via ephemeral ECDH provisioning rooms. User sigchain authorizes new devices.
- **Tauri IPC mock for tests**: Playwright tests run in a regular browser. `PLAYWRIGHT_TEST=true` triggers Vite aliases that route `@tauri-apps/api/core` and `@tauri-apps/plugin-store` to JS mock implementations in `tests/mocks/`. The mock maintains a CryptoState that mirrors the Rust side.
- **Mobile crypto**: iOS uses UniFFI XCFramework from `packages/crypto/`, Android uses JNI `.so` files. Both wrap CryptoService as a singleton — device private key is private and never leaves the service layer.
- **Hub key distribution**: Random 32 bytes (`crypto.getRandomValues`), HPKE-wrapped individually per member via `LABEL_HUB_KEY_WRAP`. Rotation on member departure excludes departed member.
- **Client-side transcription**: WASM Whisper via `@huggingface/transformers` ONNX runtime. AudioWorklet ring buffer → Web Worker isolation. Audio never leaves the browser.
- **Reproducible builds**: `Dockerfile.build` with `SOURCE_DATE_EPOCH`, content-hashed filenames. `CHECKSUMS.txt` in GitHub Releases. SLSA provenance + SBOM + cosign. knope manages release PRs automatically — never manually bump versions. Verification via `scripts/verify-build.sh`.
- **Hash-chained audit log**: SHA-256 chain with `previousEntryHash` + `entryHash` for tamper detection (Epic 77).
- **Domain separation**: All crypto context constants defined in `packages/protocol/crypto-labels.json` (source of truth; see file for current count), generated to TS/Swift/Kotlin via codegen. NEVER use raw string literals for crypto contexts. Label enforced at decrypt (Albrecht defense).
- **Blast/Broadcast service**: PostgreSQL-backed delivery queue with per-channel rate limiting. Manages batched delivery of bulk messages (SMS/WhatsApp/Signal/Telegram/RCS) with per-recipient status tracking and retry logic.
- **Kubernetes health probes**: `/health/ready` and `/health/live` endpoints. Prometheus ServiceMonitor configured. Caddyfile.production with security headers. Ansible preflight + smoke-check playbooks.
- **Key management**: PIN-encrypted per-device Ed25519/X25519 keys stored in Tauri Store (desktop), iOS Keychain, or Android Keystore (EncryptedSharedPreferences). Rust CryptoState holds device private key; UI only sees pubkey. Device linking via ephemeral ECDH provisioning rooms. User sigchain authorizes new devices.
- **Tauri IPC mock for tests**: Playwright tests run in a regular browser. `PLAYWRIGHT_TEST=true` triggers Vite aliases that route `@tauri-apps/api/core` and `@tauri-apps/plugin-store` to JS mock implementations in `tests/mocks/`. The mock maintains a CryptoState that mirrors the Rust side.
- **Mobile crypto**: iOS uses UniFFI XCFramework from `packages/crypto/`, Android uses JNI `.so` files. Both wrap CryptoService as a singleton — device private key is private and never leaves the service layer.
- **Hub key distribution**: Random 32 bytes (`crypto.getRandomValues`), HPKE-wrapped individually per member via `LABEL_HUB_KEY_WRAP`. Rotation on member departure excludes departed member.
- **Client-side transcription**: WASM Whisper via `@huggingface/transformers` ONNX runtime. AudioWorklet ring buffer → Web Worker isolation. Audio never leaves the browser.
- **Reproducible builds**: `Dockerfile.build` with `SOURCE_DATE_EPOCH`, content-hashed filenames. `CHECKSUMS.txt` in GitHub Releases. SLSA provenance + SBOM + cosign. knope manages release PRs automatically — never manually bump versions. Verification via `scripts/verify-build.sh`.
- **Hash-chained audit log**: SHA-256 chain with `previousEntryHash` + `entryHash` for tamper detection (Epic 77).
- **Domain separation**: All crypto context constants defined in `packages/protocol/crypto-labels.json` (source of truth; see file for current count), generated to TS/Swift/Kotlin via codegen. NEVER use raw string literals for crypto contexts. Label enforced at decrypt (Albrecht defense).
- **Blast/Broadcast service**: PostgreSQL-backed delivery queue with per-channel rate limiting. Manages batched delivery of bulk messages (SMS/WhatsApp/Signal/Telegram/RCS) with per-recipient status tracking and retry logic.
- **Kubernetes health probes**: `/health/ready` and `/health/live` endpoints. Prometheus ServiceMonitor configured. Caddyfile.production with security headers. Ansible preflight + smoke-check playbooks.

## Gotchas

- `@noble/ciphers` and `@noble/hashes` require `.js` extension in imports (e.g., `@noble/ciphers/chacha.js`)
- `schnorr` is a separate named export: `import { schnorr } from '@noble/curves/secp256k1.js'`
- Hub key is random bytes, NOT derived from any identity key — see `hub-key-manager.ts`
- **`asterisk-bridge/` no longer exists** — replaced by `sip-bridge/`. Use `PBX_TYPE` env var to select ARI/ESL/Kamailio backend.
- **HPKE replaces ECIES**: All new key-wrapping code must use HPKE (RFC 9180 X25519-HKDF-SHA256-AES256-GCM). No secp256k1 ECIES for new features.
- **Per-device keys, not nsec**: Users have Ed25519/X25519 device keys authorized via sigchain. `nsec` is no longer the identity primitive.
- **Signal notifier auth**: `SIGNAL_NOTIFIER_BEARER_TOKEN` must match between app config and `signal-notifier/` sidecar config.
- **knope manages versions**: Never manually bump `package.json`, `Cargo.toml`, or platform version files. knope auto-maintains release PRs with changelogs.
- **Tauri-only desktop**: No browser/PWA fallback. `platform.ts` always routes through Tauri IPC. Use `PLAYWRIGHT_TEST=true` for test builds that mock the IPC layer.
- **packages/crypto path dep**: `apps/desktop/Cargo.toml` references `../../packages/crypto`. No external repo needed.
- **wrangler.jsonc**: Only exists at `site/wrangler.jsonc` (Cloudflare Pages, marketing site). No wrangler config in `apps/worker/` — the backend is Bun+PostgreSQL, not a Cloudflare Worker.
- **iOS UniFFI**: Build with `packages/crypto/scripts/build-mobile.sh ios`, copy XCFramework to `apps/ios/`. **Mobile crypto is real — there is no mock fallback on either platform.** The `#if !canImport(LlamenosCore)` stand-in types this file used to describe no longer exist anywhere under `apps/ios/`.
- **Android JNI**: Build with `packages/crypto/scripts/build-mobile.sh android`, which produces debug (test-kdf, x86_64) and release (production, ARM) variants in `dist/android/jniLibs-{debug,release}/`. Copy to `apps/android/app/src/{debug,release}/jniLibs/`. `CryptoService` calls `System.loadLibrary("llamenos_core")` and then guards every operation with `check(nativeLibLoaded)` at 31 sites — it hard-fails without the native library rather than falling back to placeholder crypto.
- **Zod `.optional().default()` pattern**: Always use `.optional().default(value)` for fields with defaults in `packages/protocol/schemas/`. Never use bare `.default(value)` — it produces wrong JSON Schema output in Zod 4, breaking Kotlin/Swift codegen defaults. The Kotlin post-processor in `codegen.ts` reads `"default"` values from JSON Schema and injects them into generated `@Serializable` data classes.
- **Schemas moved to protocol**: All Zod schemas live in `packages/protocol/schemas/` (moved from `apps/worker/schemas/`). Worker routes import from `@protocol/schemas`. Old epic docs may reference the old path — the new path is canonical.
- **mise version management**: `.mise.toml` pins Bun 1.3.5, JDK 17, Ruby 3.3. Rust is NOT pinned in mise — `rust-toolchain.toml` files handle it via rustup. Swift is NOT pinned — managed by Xcode. Use `.mise.local.toml` for personal overrides; never edit `.mise.toml` for local preferences.
- **Run `mise install` after pulling**: Tool versions in `.mise.toml` may change between commits.
- **Load testing**: k6-based load tests available via `bun run load:*` scripts for performance validation

## Development Commands

### First-Time Setup

```bash
mise install          # Install pinned Bun, JDK 17, Ruby — run once after cloning or pulling
mise run --list       # Discover all available mise tasks (discovery helpers for new contributors)
                      # All `bun run` scripts continue to work unchanged; mise tasks are wrappers
```

After `mise install`, install Ruby gems for Fastlane: `cd apps/ios && bundle install`

### Workspace Bootstrap

```bash
mise run setup              # First-time full setup (installs tools, deps, builds crypto, runs codegen)
mise run setup --quick      # Skip mobile builds (desktop/backend only)
bun run workspace-setup     # Manual incremental sync (runs automatically on bun install)
bun run workspace-setup --force  # Full rebuild without timestamp checks
bun run workspace-setup --ios    # Include iOS crypto build
bun run workspace-setup --android  # Include Android crypto build
```

Mobile builds are skipped by default for speed. Pass `--ios` or `--android` explicitly, or use branch names like `feat/ios-*` / `feat/android-*` / `feat/mobile-*` to auto-enable them.

### Local Backend Setup (REQUIRED for backend development and testing)

**Always use dev compose (backing services) + `bun run dev:server` (app with file watching):**

```bash
# 1. Start backing services (PostgreSQL, RustFS)
docker compose -f deploy/docker/docker-compose.dev.yml up -d

# Optional profiles: --profile signal  --profile telephony  --profile inference  --profile monitoring
# telephony profile adds Kamailio + CoTURN; signal adds signal-notifier sidecar

# 2. Start app locally (auto-reloads on code changes via --watch)
bun run dev:server

# 3. Run backend BDD tests
bun run test:backend:bdd

# 4. Full sidecar integration tests (signal-notifier, inference agent, etc.)
scripts/test-integration-full.sh
```

**NEVER use the production compose** (`deploy/docker/docker-compose.yml`) for local development or testing. It bundles the app into a Docker image that won't reflect code changes until rebuilt. The `docker-compose.ci.yml` overlay is for CI; `docker-compose.production.yml` overlay is for production.

```bash
# iOS (runs locally on Mac M4)
bun run ios:status                       # Check Xcode, Rust, xcodegen status
bun run ios:setup                        # First-time: install Rust targets, xcodegen, xcbeautify
bun run ios:build                        # Build iOS app (auto-generates .xcodeproj)
bun run ios:test                         # Run unit tests (LlamenosTests)
bun run ios:uitest                       # Run XCUITests on simulator
bun run ios:xcframework                  # Build LlamenosCoreFFI XCFramework from Rust
bun run ios:all                          # xcframework + build + test + uitest
bun run crypto:test:mobile               # Rust crypto tests with mobile FFI

# Desktop (runs on Linux machine)
bun install                              # Install dependencies
bun run tauri:dev                        # Tauri desktop dev (Vite + Rust backend)
bun run tauri:build                      # Tauri desktop release build
bun run dev                              # Vite dev server (test builds only — no Rust backend)

# Backend (runs on Linux machine)
bun run dev:server                       # Bun HTTP server with file watching

# Build & Test (runs on Linux machine)
bun run build                            # Vite build → dist/client/
bun run typecheck                        # Type check (tsc --noEmit)
bun run test                             # Run all Playwright E2E tests (auto-builds with mocks)
bun run test:ui                          # Playwright UI mode
bun run test:build                       # Vite build with Tauri IPC mocks (for Playwright)

# Crypto (Rust — runs on either machine)
bun run crypto:test                      # cargo test on packages/crypto
bun run crypto:test:mobile               # cargo test with --features mobile (FFI tests)
bun run crypto:clippy                    # cargo clippy on packages/crypto
bun run crypto:fmt                       # cargo fmt --check on packages/crypto

# Codegen (runs on either machine)
bun run codegen                          # Generate TS/Swift/Kotlin types from Zod schemas (via quicktype)
bun run i18n:codegen                     # Generate iOS .strings + Android strings.xml + Kotlin I18n.kt
bun run i18n:validate                    # Check locale completeness
bun run i18n:validate:android            # Validate R.string.* refs match codegen output
bun run i18n:validate:ios                # Validate localized string refs in Swift
bun run i18n:validate:desktop            # Validate t('key') calls match en.json
bun run i18n:validate:all                # Run all three validators

# Unified Test Orchestration (runs on either machine)
bun run test:all                         # Codegen + build + test ALL available platforms
bun run test:changed                     # Only test platforms affected by git changes
bun run test:feature <name>              # Run tests matching a feature name across platforms
bun run test:desktop                     # Desktop: codegen → typecheck → playwright
bun run test:ios                         # iOS: codegen → xcodebuild → unit + UI tests
bun run test:android                     # Android: codegen → gradle unit + lint + androidTest
bun run test:worker                      # Worker: codegen → typecheck → integration tests
bun run test:crypto                      # Crypto: cargo test + clippy
bun run test:backend:bdd                 # Backend BDD against local backend (API-level)

# Deploy (runs on Linux machine)
bun run deploy                           # Deploy EVERYTHING (Worker + marketing site)
bun run deploy:api                       # Deploy Worker only
bun run deploy:site                      # Deploy marketing site only

# Android (runs on Linux machine)
bun run test:android                     # Unit tests + lint + build androidTest APK
bun run test:android:e2e                 # Cucumber BDD E2E on connected device/emulator

# Version Management (managed by knope — do NOT manually edit version files)
bun run version:bump <major|minor|patch> [description]     # Bump version across ALL platforms via knope

# Utilities
bun run bootstrap-admin                  # Generate admin keypair
```

**Deployment rules — NEVER run `wrangler pages deploy` or `wrangler deploy` directly.** Always use `bun run deploy` or `bun run deploy:site` from the root. Running wrangler from the wrong directory will deploy the wrong artifact.

**Key config files**: `site/wrangler.jsonc` (Cloudflare Pages, marketing site only), `playwright.config.ts`, `.env` (Twilio creds + ADMIN_PUBKEY, gitignored)

## Claude Code Working Style

### Development Workflow

- **New feature**: `superpowers:brainstorming` → spec → `superpowers:writing-plans` → plan → `superpowers:executing-plans`
- **Bug fix**: `superpowers:systematic-debugging`
- **Code complete**: `superpowers:verification-before-completion` + `superpowers:requesting-code-review`

Domain skills (e.g. `bdd-feature-development`, `protocol-schema-change`) are **reference material** used during plan execution — not primary workflow entry points.

`docs/epics/` contains historical planning documents for reference. New planning uses superpowers specs (`docs/superpowers/specs/`) and plans (`docs/superpowers/plans/`).

**Fleet/CI determinism rules** (16 checkable invariants, each from a live failure) are
canonical at `docs/superpowers/specs/2026-09-11-llamenos-fleet-orchestrator-design.md#determinism-invariants`
and folded into every worker via `.claude/agents/fragments/_worker-rules.md` — read them
there, do not re-paste them here.

### Test Philosophy

1. Tests assert **behavior** (state changes, API responses, data persistence) — never assert UI element existence
2. Every test is **isolated** — per-test PostgreSQL schema, no shared state between tests
3. Tests must **pass immediately** — no `waitForTimeout()`, use DOM-native or Playwright `waitFor` only

### Parallel Agent Execution

- **Dispatch agents per client in parallel**: iOS, Android, Desktop, Backend work happens simultaneously — never serialize across platforms
- **Test-first on changes**: Before running any suite, update tests/test infra to match the change. Never run to see what breaks.
- **After every major iteration**: Run all e2e and test suites (iOS unit, Android unit, Desktop E2E, backend BDD) to confirm green before moving on
- **Fully complete plans**: Never mark a spec/plan done before all tasks are complete. No quiet deferral. If something is incomplete, say so and keep going.

### General Rules

- Implement features completely — no stubs, no shortcuts, no TODOs
- Edit files in place; never create copies. Git history is the backup
- Keep the file tree lean. Commit frequently
- No legacy fallbacks until the app is in production
- Use context7 MCP for library documentation lookups
- Clean up unused files when pivoting. Refactor proactively
- NEVER delete or regress functionality to fix type issues or get tests passing
