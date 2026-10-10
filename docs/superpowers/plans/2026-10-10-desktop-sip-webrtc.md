# Desktop In-App Audio — SIP/WebRTC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desktop volunteer who clocks in — for any hub, in any number of hubs — registers one SIP endpoint against our own Kamailio edge, is rung in the app for calls from every hub they are on shift for, and answers with two-way audio over SIP/TLS signalling and mandatory DTLS-SRTP media. Failure to register is visible to the volunteer and to routing, never silent. This closes #1770, the last M1 client gap.

**Architecture:** The SIP stack and the entire media path live in the Tauri Rust shell as an in-repo `llamenos-voice` crate wrapping liblinphone (bindgen over the C API, consumed as a version- and checksum-pinned prebuilt per target). The webview keeps call state, hub attribution and UI — which already work there — and learns registration/call state exclusively through `voice:*` events. The SIP credential, TURN credentials, the TLS trust anchor, media and all key material never cross IPC in either direction.

**Tech Stack:** Rust 2024 (Tauri v2.11.1 shell, `=2.11.1` pinned), liblinphone C API via bindgen, reqwest/rustls pinned-TLS net stack (`apps/desktop/src/net.rs`), TypeScript/React webview (`src/client/lib/platform.ts` IPC abstraction), Playwright with the Tauri IPC mock (`tests/mocks/tauri-core.ts`), Docker Compose telephony stack (`deploy/docker/tests/telephony/`).

**Spec:** PR #1787 — `docs/superpowers/specs/2026-10-10-desktop-sip-webrtc-design.md` (branch `spec/1770-desktop-sip`). **Read it before Task 1.** Its decisions are reviewed and settled: Rust-shell confinement (§1), liblinphone prebuilt (§3), DTLS-SRTP mandatory with SFrame deliberately unbound at M1 (§4), #1200 clock-in lifecycle semantics (§5.3), the four-tier test plan (§8). This plan implements that spec; it does not re-litigate it.

## Global Constraints

Copied from the spec; these bind every task below.

- **IPC boundary (spec §1.4).** Never crosses, in either direction: the SIP username/password, the TURN credential pair, the TLS trust anchor, RTP or decoded PCM audio, DTLS/SRTP key material, SFrame keys, device private keys. The webview receives registration state and call snapshots only.
- **Four-layer IPC rule (spec §1.4).** Every new IPC command lands in all four of: `tauri::generate_handler!` in `apps/desktop/src/lib.rs`, `ALLOWED_COMMANDS` in `apps/desktop/isolation/index.html`, the `TauriIpcCommand` union in `src/client/lib/platform.ts`, and the `commands` record in `tests/mocks/tauri-core.ts`. `src/client/lib/desktop-ipc-boundary.test.ts` parses all four and fails on disagreement.
- **Version pins.** `tauri = "=2.11.1"` in `apps/desktop/Cargo.toml` stays aligned with `@tauri-apps/api` in `package.json` (`tests/tauri-version-alignment.spec.ts` enforces). liblinphone is consumed ONLY as a version- and checksum-pinned prebuilt artifact per target, recorded in `apps/desktop/linphone-sdk-checksums.txt` and the SBOM. **Never build liblinphone from source in CI** (spec §3.1).
- **Multi-hub axiom (spec §5.3).** One SIP registration per volunteer device — the identity is per-volunteer (`vol_<pubkey16>`), not per-hub. Hub attribution rides the relay channel (`call:ring` carries `hubId`), never SIP. Incoming call handling is never gated on active-hub state; `setActiveHub` moves with the answer, never the ring.
- **Media/signalling policy (spec §§4.2, 7.1).** DTLS-SRTP is mandatory; an unencrypted media path is never negotiated as a fallback. Signalling honours only `transport: 'tls'`; `tcp`/`udp` from the server is surfaced as misconfiguration, never followed. TLS verification is never disabled and never falls back to the ambient device store when the server publishes `tlsTrustAnchorPem`.
- **SFrame is not bound at M1 (spec §4).** No task in this plan touches `sframe_*` for the voice path. The `[volunteers-sframe]` groundwork stays as it is.
- **No new crypto label (spec §6 #11).** There is no key derivation in this path; do not add to `packages/protocol/crypto-labels.json` or `LABEL_REGISTRY`.
- **i18n (spec §6 #12).** All new user-facing strings go in a `softphone.*` namespace, never `voice.*` (that namespace is caller-facing IVR TTS text). Add keys to `packages/i18n/locales/en.json`, then `bun run i18n:codegen && bun run i18n:validate:all`. Never edit a generated platform string file.
- **Failure policy (spec §7).** Credentials and media fail closed and loud; routing fails open (server-side, already shipped — desktop changes nothing about it). No silent retry loops on 4xx.
- **Docs hygiene (spec §10).** No operator detail (hosts, IPs, provider accounts, deployment paths) in any file this plan produces.
- **Out of scope (spec §2/§9.6):** outbound calling, video, conferencing, recording changes, mobile client changes, the caller leg, removal of the `webrtc.ts` `unsupported` shim and the `webrtc-token` route (a follow-up, not a silent side effect).

## Environment setup (once, before Task 1)

```bash
bun install --frozen-lockfile && bun run codegen && bun run i18n:codegen
docker compose -f deploy/docker/docker-compose.dev.yml up -d
```

The desktop crate builds standalone: `cargo build --manifest-path apps/desktop/Cargo.toml` (it has its own `Cargo.lock`; it is not in a cargo workspace).

## File Structure

| File | Responsibility |
|---|---|
| `scripts/fetch-linphone-sdk.sh` *(new)* | Fetch + sha256-verify the pinned liblinphone prebuilt for one target into `apps/desktop/vendor/linphone-sdk/<target>/`. |
| `apps/desktop/linphone-sdk-checksums.txt` *(new)* | The independent sha256 record per target artifact (mirrors `apps/ios/linphone-sdk-checksums.txt`). This one IS a gate: the fetch script refuses a mismatch. |
| `.github/workflows/desktop-voice.yml` *(new)* | Matrix job (ubuntu/macos/windows) that runs the fetch script and builds `llamenos-voice-sys`; a Linux job for the Tier 2 headless e2e. |
| `apps/desktop/voice/sys/` *(new crate `llamenos-voice-sys`)* | bindgen over `linphone/core.h` against the vendored SDK; raw bindings, link rules, smoke test. Unsafe lives here and only here. |
| `apps/desktop/voice/` *(new crate `llamenos-voice`)* | Safe wrapper: `VoiceCore` on the liblinphone pump thread, command channel, registration/call state mapping, hygiene defaults. |
| `apps/desktop/voice/examples/sip_e2e.rs` *(new)* | The Tier 2 headless test binary: register through the TLS edge, answer an echo call, exit 0/1. |
| `apps/desktop/src/voice.rs` *(new)* | Tauri IPC handlers (`voice_*`), the shell-side credential fetch, the lifecycle manager, `AppHandle::emit` of `voice:*` events. |
| `apps/desktop/src/lib.rs` | Register the `voice_*` commands in `generate_handler!`; construct `VoiceState`; hook crypto-lock and quit to unregister. |
| `apps/desktop/isolation/index.html` | Add every `voice_*` command to `ALLOWED_COMMANDS`. |
| `apps/desktop/Cargo.toml` | Add `llamenos-voice = { path = "voice" }`. |
| `src/client/lib/platform.ts` | Extend `TauriIpcCommand`; add `voice*` wrappers and `listenVoice*` event subscriptions with the `PLAYWRIGHT_TEST` listener-registry branch. |
| `src/client/lib/voice.ts` *(new)* | Webview voice store: desired-state sync triggers, event reduction via `useSyncExternalStore`, selectors for UI. |
| `src/client/lib/queries/shifts.ts` | Fire `voiceSyncRegistrations()` on clock-in/clock-out mutation settlement and on shift-status data. |
| `src/client/routes/index.tsx` | Answer/decline/hangup/mute routing: in-app legs go through `voice_*`; phone-leg UX untouched. |
| `src/client/components/voice-controls.tsx` *(new)* | Active-call controls (mute, hangup, device picker) and the registration-state badge. Testid-only. |
| `tests/mocks/tauri-core.ts` | Mock `voice_*` command handlers with an in-memory voice state machine; `voice_test_*` mock-only injection commands; `emitVoiceEvent`. |
| `tests/voice-desktop.spec.ts` *(new)* | Tier 3 Playwright specs (multi-hub ring, answer flow, failure rendering, workspace churn). |
| `deploy/docker/tests/telephony/kamailio-edge.e2e.ts` | Tier 1 extension: REGISTER expiry cap assertion. |
| `deploy/docker/tests/telephony/run-desktop-sip-e2e.sh` *(new)* | Tier 2 runner mirroring `run-android-sip-e2e.sh`. |
| `packages/i18n/locales/en.json` (+ locale files) | `softphone.*` keys. |
| `docs/protocol/PROTOCOL.md` | Document `GET /api/telephony/sip-token` (spec §10 — today undocumented). |
| `docs/release/desktop-voice-tier4.md` *(new)* | The Tier 4 per-release sign-off checklist. |

---

### Task 0: Operator checkpoint — accept the pinned-artifact reproducibility trade-off

**This is a gate, not a formality.** The spec (§3.1 "Build cost — the honest price") states that pinning a large prebuilt C++ FFI artifact weakens the reproducible-build story to "reproducible given the pinned artifacts", and records it as an *accepted* trade-off. That acceptance must be an explicit operator decision on the record before anyone wires a binary blob into the desktop release. A worker must not silently pass this.

**Files:**
- Modify: none (a comment on #1770).

**Interfaces:**
- Produces: an operator-approval comment URL that Task 1's PR body quotes. No code may reference an artifact pin until this exists.

- [ ] **Step 1: Post the decision request on #1770**

Post a comment on the issue with exactly this content (fill the two bracketed slots):

```markdown
## Operator decision requested — desktop voice build cost

Spec PR #1787 (§3.1) chooses liblinphone consumed as a **prebuilt, version- and
checksum-pinned artifact per desktop target**, wrapped in an in-repo
`llamenos-voice` crate. The stated cost: the desktop reproducible-build story
weakens from "reproducible from source" to **"reproducible given the pinned
artifacts"** — the same posture mobile already takes
(`apps/ios/linphone-sdk-checksums.txt`). Building liblinphone from source in CI
is explicitly rejected (per-OS CMake/yasm/nasm toolchain on three hosted
runners).

Mitigations in the plan: sha256-pinned fetch script that refuses a mismatch,
checksums committed to the repo, pin recorded in the SBOM, and the Tier 2
headless e2e proving the artifact actually works before any UI depends on it.

Please confirm this trade-off is accepted for M1. Blocking: implementation of
#1770 beyond this checkpoint.
```

- [ ] **Step 2: Wait for the answer**

The implementing worker stops here until an operator replies confirming. Record the approval comment URL in the PR body of the first code PR.

- [ ] **Step 3: Commit the gate marker**

Add one line to the top of this plan's PR description (or a follow-up comment on #1770): `Operator checkpoint Task 0: accepted <link>`. No commit to the repo is required for this task.

---

### Task 1: Pin the prebuilt liblinphone desktop artifacts (long-lead spike)

Everything downstream assumes the crate exists; the crate assumes the artifact exists. This task produces and pins the artifact and answers the spec's open questions 1 and 2 (§9): are desktop prebuilts available, current and checksummable for all three targets, and is bindgen over `linphone/core.h` a days-not-months job. **If the answer to the first is no for any target, stop and report on #1770 — that is the spike's honest result, not a failure to route around.**

**Files:**
- Create: `scripts/fetch-linphone-sdk.sh`
- Create: `apps/desktop/linphone-sdk-checksums.txt`
- Create: `.github/workflows/desktop-voice.yml` (artifacts job only; the e2e job arrives in Task 5)

**Interfaces:**
- Produces: `apps/desktop/vendor/linphone-sdk/<target>/` containing `include/linphone/core.h` and `lib/` (gitignored), where `<target>` ∈ `{linux-x86_64, macos-universal, windows-x86_64}`.
- Produces: `LLAMENOS_LINPHONE_SDK_VERSION` — a single version string the fetch script, the checksums file header, and the SBOM entry all quote.
- Consumed by: Task 2's `build.rs`, which hard-fails when the vendored tree for the host target is absent.

- [ ] **Step 1: Survey the upstream release channel and pick the pin**

Linphone publishes desktop SDK builds on its public release server (the same project that publishes the iOS SDK the mobile pin already tracks). On a Linux shell:

```bash
curl -fsSL https://download.linphone.org/releases/linux/sdk/ | grep -oE 'linphone-sdk-[0-9]+\.[0-9]+(\.[0-9]+)?-linux' | sort -uV | tail -5
```

Pick the newest stable release line that publishes all three of: Linux x86_64, macOS (universal or per-arch), Windows x86_64. Record the chosen version as `LLAMENOS_LINPHONE_SDK_VERSION`. The mobile pin is `5.5.23-novideo` (`apps/ios/linphone-sdk-checksums.txt`); prefer a desktop release from the same 5.x line so all three clients speak the same liblinphone dialect. If no desktop artifact set exists for the chosen line, that is the spike result — stop and report.

- [ ] **Step 2: Write the fetch script**

Create `scripts/fetch-linphone-sdk.sh`:

```bash
#!/usr/bin/env bash
# Fetch the pinned prebuilt liblinphone SDK for one desktop target and verify
# it against apps/desktop/linphone-sdk-checksums.txt. Refuses any mismatch:
# the checksums file is a GATE here, not a record (unlike the iOS precedent,
# whose header explains why a record alone was accepted there).
#
# Usage: scripts/fetch-linphone-sdk.sh <linux-x86_64|macos-universal|windows-x86_64>
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
TARGET="${1:?usage: fetch-linphone-sdk.sh <target>}"
CHECKSUMS="$ROOT/apps/desktop/linphone-sdk-checksums.txt"
VENDOR_DIR="$ROOT/apps/desktop/vendor/linphone-sdk/$TARGET"

# Version + URL + expected sha256 come from the checksums file itself, so this
# script carries no second copy of the pin to drift.
line="$(grep -E "^${TARGET}[[:space:]]" "$CHECKSUMS")" || {
  echo "no checksum entry for target '$TARGET' in $CHECKSUMS" >&2; exit 2; }
read -r _ url expected <<<"$line"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp/sdk.zip"
actual="$(sha256sum "$tmp/sdk.zip" | cut -d' ' -f1)"
if [ "$actual" != "$expected" ]; then
  echo "CHECKSUM MISMATCH for $TARGET" >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  echo "  Refusing to install. If the pin is being deliberately bumped," >&2
  echo "  update apps/desktop/linphone-sdk-checksums.txt in its own commit." >&2
  exit 1
fi

rm -rf "$VENDOR_DIR"
mkdir -p "$VENDOR_DIR"
unzip -q "$tmp/sdk.zip" -d "$VENDOR_DIR"
test -f "$VENDOR_DIR/include/linphone/core.h" || {
  echo "artifact does not contain include/linphone/core.h" >&2; exit 1; }
echo "installed liblinphone SDK for $TARGET at $VENDOR_DIR"
```

- [ ] **Step 3: Fetch, hash, and record the pin for all three targets**

Run the download once per target (without the checksum gate — comment the entry in first), hash the artifact, and commit the result:

```bash
# For each target: download, sha256sum, then write the line into
# apps/desktop/linphone-sdk-checksums.txt as:
#   <target>  <url>  <sha256>
```

Header of `apps/desktop/linphone-sdk-checksums.txt`:

```text
# SHA-256 of each pinned prebuilt liblinphone desktop SDK artifact.
#
# Version: <LLAMENOS_LINPHONE_SDK_VERSION>
# Precedent: apps/ios/linphone-sdk-checksums.txt (mobile pin, a record).
# This file is a GATE: scripts/fetch-linphone-sdk.sh refuses a mismatch, and
# the desktop-voice CI job re-verifies on every run. Bump the pin only in a
# dedicated commit that re-hashes all three targets.
#
# Format: <target>  <url>  <sha256>
```

Also add `apps/desktop/vendor/` to `apps/desktop/.gitignore` (or the root `.gitignore` `vendor` rule if one exists — check first: `grep -n vendor .gitignore apps/desktop/.gitignore`).

- [ ] **Step 4: Verify the gate rejects a tampered artifact**

```bash
scripts/fetch-linphone-sdk.sh linux-x86_64          # installs clean
sed -i.bak 's/^\(linux-x86_64.*\)[0-9a-f]\{64\}/\1deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef/' apps/desktop/linphone-sdk-checksums.txt
scripts/fetch-linphone-sdk.sh linux-x86_64; echo "exit=$?"   # must print CHECKSUM MISMATCH, exit=1
mv apps/desktop/linphone-sdk-checksums.txt.bak apps/desktop/linphone-sdk-checksums.txt
```

Expected: the tampered run refuses. This is the guard verified by injecting the defect it claims to catch (spec §8's governing rule).

- [ ] **Step 5: Add the CI artifacts job**

Create `.github/workflows/desktop-voice.yml`:

```yaml
name: desktop-voice
on:
  push:
    paths:
      - 'apps/desktop/voice/**'
      - 'apps/desktop/linphone-sdk-checksums.txt'
      - 'scripts/fetch-linphone-sdk.sh'
      - '.github/workflows/desktop-voice.yml'
  workflow_dispatch:

jobs:
  artifacts:
    strategy:
      matrix:
        include:
          - { os: ubuntu-latest,  target: linux-x86_64 }
          - { os: macos-latest,   target: macos-universal }
          - { os: windows-latest, target: windows-x86_64 }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - name: Fetch pinned liblinphone SDK (checksum-gated)
        run: scripts/fetch-linphone-sdk.sh ${{ matrix.target }}
      # Task 5 appends the build + smoke steps for llamenos-voice-sys here.
```

- [ ] **Step 6: Run the CI job and commit**

Push the branch, confirm the matrix job is green on all three runners, then:

```bash
git add scripts/fetch-linphone-sdk.sh apps/desktop/linphone-sdk-checksums.txt .github/workflows/desktop-voice.yml apps/desktop/.gitignore
git commit -m "feat(desktop): pin prebuilt liblinphone SDK artifacts with checksum-gated fetch (#1770)"
```

---

### Task 2: `llamenos-voice-sys` — bindgen over the pinned SDK

The unsafe layer. Everything liblinphone touches goes through this crate; nothing else in the repo links liblinphone.

**Files:**
- Create: `apps/desktop/voice/sys/Cargo.toml`, `apps/desktop/voice/sys/build.rs`, `apps/desktop/voice/sys/wrapper.h`, `apps/desktop/voice/sys/src/lib.rs`

**Interfaces:**
- Produces: crate `llamenos_voice_sys` re-exporting `linphone_*` bindings under `llamenos_voice_sys::ffi::*`.
- Consumed by: Task 3 (`llamenos-voice` depends on it by path).

- [ ] **Step 1: Write the crate manifest**

`apps/desktop/voice/sys/Cargo.toml`:

```toml
[package]
name = "llamenos-voice-sys"
version = "0.0.0"
edition = "2021"
rust-version = "1.88.0"
license = "AGPL-3.0-or-later"
links = "linphone"
publish = false

[build-dependencies]
bindgen = "0.72"
```

- [ ] **Step 2: Write `wrapper.h` and `build.rs`**

`apps/desktop/voice/sys/wrapper.h`:

```c
/* Narrow bindgen surface (spec §3.1): core creation, account params,
 * auth info, call + registration state callbacks, call control,
 * media-encryption and ICE policy setters. Nothing else is bound. */
#include <linphone/core.h>
#include <linphone/core_utils.h>
```

`apps/desktop/voice/sys/build.rs`:

```rust
use std::path::PathBuf;

fn target_dir() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "linux-x86_64",
        ("macos", _) => "macos-universal",
        ("windows", "x86_64") => "windows-x86_64",
        (os, arch) => panic!("llamenos-voice-sys: unsupported desktop target {os}/{arch}"),
    }
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let sdk = manifest.join("../../vendor/linphone-sdk").join(target_dir());
    let include = sdk.join("include");
    assert!(
        include.join("linphone/core.h").is_file(),
        "liblinphone SDK missing for {} — run scripts/fetch-linphone-sdk.sh {} first",
        target_dir(),
        target_dir(),
    );

    println!("cargo:rustc-link-search=native={}", sdk.join("lib").display());
    println!("cargo:rustc-link-lib=dylib=linphone");
    println!("cargo:rerun-if-changed=wrapper.h");

    let bindings = bindgen::Builder::default()
        .header("wrapper.h")
        .clang_arg(format!("-I{}", include.display()))
        .allowlist_function("linphone_.*")
        .allowlist_type("Linphone.*")
        .allowlist_var("Linphone.*")
        .derive_default(true)
        .generate()
        .expect("bindgen over linphone/core.h failed");
    bindings
        .write_to_file(PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("bindings.rs"))
        .unwrap();
}
```

- [ ] **Step 3: Write `src/lib.rs` and the smoke test**

```rust
#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals)]
//! Raw bindgen output over the pinned liblinphone C API. Unsafe lives here
//! and only here; consumers use the safe `llamenos-voice` wrapper.

pub mod ffi {
    include!(concat!(env!("OUT_DIR"), "/bindings.rs"));
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_linked_library_answers_its_version() {
        // Proves the vendored artifact links and loads, before any wrapper
        // exists — the bindgen half of spec §9 open question 2.
        let v = unsafe { crate::ffi::linphone_core_get_version() };
        assert!(!v.is_null());
        let s = unsafe { std::ffi::CStr::from_ptr(v) }.to_string_lossy();
        assert!(s.chars().next().is_some_and(|c| c.is_ascii_digit()), "version string: {s}");
    }
}
```

- [ ] **Step 4: Build and test**

```bash
scripts/fetch-linphone-sdk.sh linux-x86_64
cargo test --manifest-path apps/desktop/voice/sys/Cargo.toml
```

Expected: `the_linked_library_answers_its_version` passes (on Linux the dynamic loader may need `LD_LIBRARY_PATH=apps/desktop/vendor/linphone-sdk/linux-x86_64/lib` — if so, encode that in the test invocation in the CI workflow, not in code).

- [ ] **Step 5: Extend the CI matrix job and commit**

Append to the `artifacts` job in `.github/workflows/desktop-voice.yml`:

```yaml
      - uses: dtolnay/rust-toolchain@stable
      - name: Build + smoke-test llamenos-voice-sys
        run: cargo test --manifest-path apps/desktop/voice/sys/Cargo.toml
```

```bash
git add apps/desktop/voice/sys/ .github/workflows/desktop-voice.yml
git commit -m "feat(desktop): llamenos-voice-sys bindgen crate over pinned liblinphone (#1770)"
```

---

### Task 3: `llamenos-voice` — core lifecycle on the pump thread

liblinphone is pump-driven: `linphone_core_iterate` on a ~20 ms timer, and ALL Core interaction on that one thread — commands are posted to it, never executed on the IPC thread (spec §3.1's "two properties"). This task builds that spine with no networking yet.

**Files:**
- Create: `apps/desktop/voice/Cargo.toml`, `apps/desktop/voice/src/lib.rs`, `apps/desktop/voice/src/core.rs`, `apps/desktop/voice/src/events.rs`

**Interfaces:**
- Produces (the exact surface Task 4 and Task 8 consume):

```rust
pub struct VoiceConfig {
    /// Directory for the linphone config file; created 0700, file 0600.
    pub config_dir: std::path::PathBuf,
    /// Sink for everything the stack reports. Called on the pump thread;
    /// implementations must not block (the shell forwards to AppHandle::emit).
    pub on_event: std::sync::Arc<dyn Fn(VoiceEvent) + Send + Sync>,
}

pub enum VoiceEvent {
    Registration(RegistrationEvent),
    Call(CallEvent),
    Error(String),
}

pub struct RegistrationEvent { pub state: RegistrationState, pub reason: Option<String> }
pub enum RegistrationState { Registering, Registered, Unregistered, Failed, CredentialRevoked }

pub struct CallEvent {
    pub call_id: String,
    pub state: CallState,
    pub muted: bool,
    pub reason: Option<String>,
}
pub enum CallState { Incoming, Connecting, Active, Ended, Error }

pub enum VoiceCommand {
    Register(crate::SipRegistrationParams),
    UnregisterAll,
    Answer(String),            // call_id as reported in CallEvent
    Decline(String),
    Hangup(String),
    SetMuted { call_id: String, muted: bool },
    SelectAudioDevice { kind: DeviceKind, id: String },
    RefreshIceServers(Vec<IceServer>),
}

pub struct VoiceCore { /* opaque */ }
impl VoiceCore {
    pub fn start(config: VoiceConfig) -> Result<Self, VoiceError>;
    pub fn post(&self, cmd: VoiceCommand);           // non-blocking, any thread
    pub fn list_audio_devices(&self) -> AudioDevices; // posted + answered on channel
    pub fn shutdown(self);                            // unregisters, joins pump, wipes config file
}
```

- [ ] **Step 1: Write the manifest and event types**

`apps/desktop/voice/Cargo.toml`:

```toml
[package]
name = "llamenos-voice"
version = "0.0.0"
edition = "2021"
rust-version = "1.88.0"
license = "AGPL-3.0-or-later"
publish = false

[dependencies]
llamenos-voice-sys = { path = "sys" }
serde = { version = "1", features = ["derive"] }

[dev-dependencies]
tempfile = "3"
```

`src/events.rs`: the `VoiceEvent` / `RegistrationEvent` / `CallEvent` / `RegistrationState` / `CallState` / `DeviceKind` types exactly as in the Interfaces block, all `#[derive(Debug, Clone, serde::Serialize)]`. The serde impls are what `apps/desktop/src/voice.rs` serializes onto `voice:registration` / `voice:call` — event payload shapes are defined HERE, once.

- [ ] **Step 2: Write the pump-thread spine**

`src/core.rs` skeleton (the parts every later step hangs off):

```rust
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::Duration;
use llamenos_voice_sys::ffi;

const ITERATE_INTERVAL: Duration = Duration::from_millis(20);

pub struct VoiceCore {
    cmd_tx: Sender<VoiceCommand>,
    pump: Option<std::thread::JoinHandle<()>>,
    // vtable handle kept alive for the core's lifetime:
    _cbs: *mut ffi::LinphoneCoreCbs,
}

pub fn start(config: VoiceConfig) -> Result<VoiceCore, VoiceError> {
    std::fs::create_dir_all(&config.config_dir).map_err(VoiceError::Io)?;
    set_dir_permissions_0700(&config.config_dir)?; // platform cfg blocks
    let config_path = config.config_dir.join("linphonerc");

    let (cmd_tx, cmd_rx) = channel::<VoiceCommand>();
    let (ready_tx, ready_rx) = channel::<Result<(), VoiceError>>();

    let pump = std::thread::Builder::new()
        .name("llamenos-voice-pump".into())
        .spawn(move || pump_main(config_path, config.on_event, cmd_rx, ready_tx))
        .map_err(VoiceError::Io)?;

    ready_rx.recv().map_err(|_| VoiceError::PumpDied)??;
    Ok(VoiceCore { cmd_tx, pump: Some(pump), _cbs: std::ptr::null_mut() })
}

fn pump_main(
    config_path: std::path::PathBuf,
    on_event: std::sync::Arc<dyn Fn(VoiceEvent) + Send + Sync>,
    cmd_rx: Receiver<VoiceCommand>,
    ready_tx: Sender<Result<(), VoiceError>>,
) {
    unsafe {
        let factory = ffi::linphone_factory_get();
        let cbs = ffi::linphone_factory_create_core_cbs(factory);
        // Callbacks wired in Task 4 (registration) and Task 5/8 (calls).
        let path = std::ffi::CString::new(config_path.to_string_lossy().into_owned()).unwrap();
        let core = ffi::linphone_factory_create_core_with_config_3(
            factory, cbs, path.as_ptr(), std::ptr::null(), std::ptr::null_mut(),
        );
        if core.is_null() {
            let _ = ready_tx.send(Err(VoiceError::CoreCreate));
            return;
        }
        // Hygiene defaults (spec §7.3) — liblinphone violates each by default:
        ffi::linphone_core_enable_call_log_database(core, 0);   // no call history
        ffi::linphone_core_set_max_calls(core, 1);              // one call at a time
        let _ = ready_tx.send(Ok(()));

        // Drain every queued command, then iterate once. Commands execute
        // ONLY here, on the pump thread (spec §3.1). `shutdown()` delivers its
        // UnregisterAll and then DROPS the Sender: `Disconnected` with an empty
        // queue is the exit signal.
        loop {
            let mut disconnected = false;
            loop {
                match cmd_rx.try_recv() {
                    Ok(cmd) => dispatch(core, cmd, &on_event),
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => { disconnected = true; break; }
                }
            }
            if disconnected {
                ffi::linphone_core_stop(core);
                ffi::linphone_core_unref(core);
                let _ = std::fs::remove_file(&config_path); // §7.3 rule 3
                return;
            }
            ffi::linphone_core_iterate(core);
            std::thread::sleep(ITERATE_INTERVAL);
        }
    }
}
```

- [ ] **Step 3: Write the failing lifecycle test**

`apps/desktop/voice/src/lib.rs` (test module):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn core_starts_and_shuts_down_without_a_config_file_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("linphonerc");
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let events = events.clone();
            Arc::new(move |e: VoiceEvent| events.lock().unwrap().push(e))
        };
        let core = VoiceCore::start(VoiceConfig {
            config_dir: dir.path().to_path_buf(),
            on_event: sink,
        })
        .expect("core starts with no network and no sound hardware");
        assert!(config_path.exists(), "linphone wrote its config under the app dir");
        core.shutdown();
        assert!(
            !config_path.exists(),
            "shutdown wipes the config file (spec §7.3 rule 3 — it persists credentials)"
        );
    }

    #[test]
    fn posted_commands_execute_on_the_pump_thread() {
        // post() must be safe to call from any thread and must not execute
        // liblinphone calls inline. Registering with garbage params must reach
        // the pump (observable as a Failed registration event), not panic the
        // caller.
        let dir = tempfile::tempdir().unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = { let e = events.clone(); Arc::new(move |ev: VoiceEvent| e.lock().unwrap().push(ev)) };
        let core = VoiceCore::start(VoiceConfig { config_dir: dir.path().into(), on_event: sink }).unwrap();
        let caller = std::thread::spawn(move || {
            core.post(VoiceCommand::UnregisterAll); // no-op, must not block or panic
            core
        });
        let core = caller.join().unwrap();
        core.shutdown();
    }
}
```

- [ ] **Step 4: Run the tests and make them pass**

```bash
cargo test --manifest-path apps/desktop/voice/Cargo.toml
```

Expected on first run: compile errors around the shutdown/disconnect placeholder and the callback-less core — implement `dispatch` (match arms calling `unreachable!()` for the not-yet-bound commands, `UnregisterAll` implemented), the disconnect-driven exit, and config-file deletion in `shutdown`. Iterate until both tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/voice/
git commit -m "feat(desktop): llamenos-voice pump-thread core with hygiene defaults (#1770)"
```

---

### Task 4: `llamenos-voice` — registration params and state mapping

Turn a `/sip-token` response into a liblinphone account, with every policy from spec §5.1/§7.1 enforced in one function, and map linphone registration callbacks onto `RegistrationEvent`.

**Files:**
- Modify: `apps/desktop/voice/src/lib.rs`
- Create: `apps/desktop/voice/src/register.rs`

**Interfaces:**
- Produces:

```rust
/// Mirror of `sipTokenResponseSchema.sip` (packages/protocol/schemas/webrtc.ts).
/// Deserialized in the shell; never serialized toward the webview.
pub struct SipRegistrationParams {
    pub domain: String,
    pub username: String,            // vol_<pubkey16>
    pub password: String,            // confined: never leaves the Rust process
    pub ice_servers: Vec<IceServer>,
    pub tls_trust_anchor_pem: Option<String>,
    pub requested_expiry_secs: u32,  // caller passes 600; clamped, never raised
}

pub struct IceServer { pub urls: Vec<String>, pub username: Option<String>, pub credential: Option<String> }

pub fn apply_registration(
    core: *mut ffi::LinphoneCore,
    params: &SipRegistrationParams,
) -> Result<(), VoiceError>;
```

- Consumed by: Task 8 (the shell lifecycle manager calls `post(VoiceCommand::Register(params))`), Task 5 (the e2e binary registers directly).

- [ ] **Step 1: Write the failing policy test**

`apps/desktop/voice/src/register.rs` test module (runs against a real local `LinphoneCore` with no network — account params are inspectable without registering):

```rust
#[test]
fn registration_policy_is_enforced_in_the_params() {
    let dir = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = { let e = events.clone(); Arc::new(move |ev: VoiceEvent| e.lock().unwrap().push(ev)) };
    let core = VoiceCore::start(VoiceConfig { config_dir: dir.path().into(), on_event: sink }).unwrap();

    let params = SipRegistrationParams {
        domain: "edge.invalid".into(),
        username: "vol_0123456789abcdef".into(),
        password: "secret".into(),
        ice_servers: vec![IceServer {
            urls: vec!["stun:relay.invalid:3478".into()],
            username: None, credential: None,
        }],
        tls_trust_anchor_pem: Some("-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n".into()),
        requested_expiry_secs: 3600, // above the server cap — must be clamped
    };
    let snapshot = core.with_account_params_for_test(params); // test-only inspector
    assert_eq!(snapshot.transport, "tls");
    assert_eq!(snapshot.expires, 600, "clamped to REGISTRATION_MAX_EXPIRY_SECONDS (registrar.ts:39)");
    assert_eq!(snapshot.media_encryption, "dtls", "mandatory DTLS-SRTP, no cleartext fallback (registrar.ts:425)");
    assert!(snapshot.root_ca_set, "server-published trust anchor installed");
    assert!(snapshot.ice_enabled);
    core.shutdown();
}
```

`with_account_params_for_test` is a `#[cfg(test)]`-only method that posts a closure to the pump thread and reads back the configured `LinphoneAccountParams` getters (`linphone_account_params_get_expires`, `linphone_account_params_get_media_encryption`, transport parsed out of `linphone_account_params_get_server_addr`).

- [ ] **Step 2: Implement `apply_registration`**

In `src/register.rs`:

```rust
pub const REGISTRATION_MAX_EXPIRY_SECONDS: u32 = 600; // registrar.ts:39 — the server caps at this

pub fn apply_registration(
    core: *mut ffi::LinphoneCore,
    params: &SipRegistrationParams,
) -> Result<(), VoiceError> {
    unsafe {
        let factory = ffi::linphone_factory_get();
        let identity = c_string(format!("sip:{}@{}", params.username, params.domain));
        // TLS transport is stated on the server address, and ONLY tls is ever
        // written here — the caller has already rejected tcp/udp (spec §7.1).
        let server = c_string(format!("sip:{};transport=tls", params.domain));

        let account_params = ffi::linphone_core_create_account_params(core);
        let identity_addr = ffi::linphone_factory_create_address(factory, identity.as_ptr());
        ffi::linphone_account_params_set_identity_address(account_params, identity_addr);
        let server_addr = ffi::linphone_factory_create_address(factory, server.as_ptr());
        ffi::linphone_account_params_set_server_address(account_params, server_addr);
        ffi::linphone_account_params_set_register_enabled(account_params, 1);
        ffi::linphone_account_params_set_expires(
            account_params,
            params.requested_expiry_secs.min(REGISTRATION_MAX_EXPIRY_SECONDS) as i32,
        );

        // DTLS-SRTP mandatory (spec §4.2): encryption is set on the params and
        // no code path clears it.
        ffi::linphone_account_params_set_media_encryption(
            account_params,
            ffi::LinphoneMediaEncryption::LinphoneMediaEncryptionDTLS,
        );

        // Server-published trust anchor, never the ambient store when present
        // (spec §5.1 step 3). Absent anchor => system roots, never "no verify".
        if let Some(pem) = &params.tls_trust_anchor_pem {
            let pem_c = c_string(pem.clone());
            ffi::linphone_core_set_root_ca_data(core, pem_c.as_ptr());
        }

        // ICE policy from the issued servers (TURN creds confined with the SIP
        // secret — they exist only inside this struct, only in this process).
        let nat = ffi::linphone_account_params_get_nat_policy(account_params);
        for srv in &params.ice_servers {
            for url in &srv.urls {
                let u = c_string(url.clone());
                ffi::linphone_nat_policy_set_stun_server(nat, u.as_ptr());
                if let (Some(user), Some(pass)) = (&srv.username, &srv.credential) {
                    let (u, p) = (c_string(user.clone()), c_string(pass.clone()));
                    ffi::linphone_nat_policy_set_stun_server_username(nat, u.as_ptr());
                    // TURN credential rides the auth-info DB keyed by realm;
                    // add via linphone_core_add_auth_info on the core.
                    let _ = p; // wired in the auth-info step below
                }
            }
        }
        ffi::linphone_nat_policy_enable_ice(nat, 1);

        let auth = ffi::linphone_factory_create_auth_info(
            factory,
            c_string(params.username.clone()).as_ptr(),
            std::ptr::null(),
            c_string(params.password.clone()).as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            c_string(params.domain.clone()).as_ptr(),
        );
        ffi::linphone_core_add_auth_info(core, auth);
        ffi::linphone_core_add_account(core, account_params);
        ffi::linphone_core_set_default_account(core, account_params);
        Ok(())
    }
}
```

Wire the registration-state callback installed in Task 3's `linphone_factory_create_core_cbs`:

```rust
unsafe extern "C" fn on_registration_state_changed(
    _core: *mut ffi::LinphoneCore,
    _account: *const ffi::LinphoneAccount,
    state: ffi::LinphoneRegistrationState,
    message: *const std::os::raw::c_char,
) {
    let reason = if message.is_null() { None } else {
        Some(std::ffi::CStr::from_ptr(message).to_string_lossy().into_owned())
    };
    let mapped = match state {
        ffi::LinphoneRegistrationState::LinphoneRegistrationProgress => RegistrationState::Registering,
        ffi::LinphoneRegistrationState::LinphoneRegistrationOk => RegistrationState::Registered,
        ffi::LinphoneRegistrationState::LinphoneRegistrationCleared => RegistrationState::Unregistered,
        ffi::LinphoneRegistrationState::LinphoneRegistrationFailed => RegistrationState::Failed,
        _ => return,
    };
    emit(VoiceEvent::Registration(RegistrationEvent { state: mapped, reason }));
}
```

- [ ] **Step 3: Run the policy test**

```bash
cargo test --manifest-path apps/desktop/voice/Cargo.toml
```

Expected: `registration_policy_is_enforced_in_the_params` passes; the pump-thread tests from Task 3 still pass.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/voice/
git commit -m "feat(desktop): SIP registration params with TLS-only, DTLS-SRTP-mandatory policy (#1770)"
```

---

### Task 5: Tier 2 — headless Rust e2e through the TLS edge

The tier that de-risks decision (A) before any UI exists (spec §8 Tier 2). Mirrors `run-android-sip-e2e.sh`: real credential from the API, registration through Kamailio's TLS listener, an answered echo call, and evidence read off **Asterisk's own log** — receiving-end evidence, because the defects this catches all produce a client that believes it is configured correctly.

**Files:**
- Create: `apps/desktop/voice/examples/sip_e2e.rs`
- Create: `deploy/docker/tests/telephony/run-desktop-sip-e2e.sh`
- Modify: `.github/workflows/desktop-voice.yml` (new `desktop-sip-e2e` job)

**Interfaces:**
- Consumes: `llamenos_voice::{VoiceCore, VoiceConfig, VoiceCommand, VoiceEvent}` (Tasks 3–4); `deploy/docker/tests/telephony/android-sip-params.e2e.ts`'s credential-provisioning flow (reused, not duplicated).
- Produces: exit 0 iff registered AND echo call answered AND the PBX log shows `UDP/TLS/RTP/SAVPF` + a fingerprint line + `StreamsRunning` for the call.

- [ ] **Step 1: Write the e2e binary**

`apps/desktop/voice/examples/sip_e2e.rs`:

```rust
//! Headless desktop SIP e2e (spec §8 Tier 2). No Tauri, no display.
//! Args: <domain> <username> <password> <stun-url> [trust-anchor-pem-path]
//! Exits 0 when: registration reached Registered, an INVITE to the echo
//! target was answered, and media reached Active — observed as VoiceEvents.

use llamenos_voice::*;
use std::sync::mpsc::channel;
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 {
        eprintln!("usage: sip_e2e <domain> <user> <pass> <stun> [anchor.pem]");
        std::process::exit(2);
    }
    let (domain, user, pass, stun) = (args[0].clone(), args[1].clone(), args[2].clone(), args[3].clone());
    let anchor = args.get(4).map(|p| std::fs::read_to_string(p).unwrap());

    let (tx, rx) = channel::<VoiceEvent>();
    let core = VoiceCore::start(VoiceConfig {
        config_dir: std::env::temp_dir().join(format!("sip-e2e-{}", std::process::id())),
        on_event: std::sync::Arc::new(move |e| { let _ = tx.send(e); }),
    })
    .expect("core starts");

    core.post(VoiceCommand::Register(SipRegistrationParams {
        domain: domain.clone(), username: user, password: pass,
        ice_servers: vec![IceServer { urls: vec![stun], username: None, credential: None }],
        tls_trust_anchor_pem: anchor,
        requested_expiry_secs: 600,
    }));

    let deadline = Instant::now() + Duration::from_secs(30);
    let mut registered = false;
    let mut call_active = false;
    let mut call_id: Option<String> = None;
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(VoiceEvent::Registration(ev)) => match ev.state {
                RegistrationState::Registered => {
                    registered = true;
                    // Place the echo call: the harness dialplan target the
                    // android harness already uses (run-android-sip-e2e.sh).
                    core.post(VoiceCommand::PlaceTestCall { uri: format!("sip:echo@{domain}") });
                }
                RegistrationState::Failed => {
                    eprintln!("registration FAILED: {:?}", ev.reason);
                    core.shutdown();
                    std::process::exit(1);
                }
                _ => {}
            },
            Ok(VoiceEvent::Call(ev)) => {
                call_id = Some(ev.call_id.clone());
                if matches!(ev.state, CallState::Active) { call_active = true; break; }
                if matches!(ev.state, CallState::Error) {
                    eprintln!("call FAILED: {:?}", ev.reason);
                    core.shutdown();
                    std::process::exit(1);
                }
            }
            Ok(VoiceEvent::Error(msg)) => eprintln!("voice error: {msg}"),
            Err(_) => {}
        }
    }
    core.shutdown();
    if registered && call_active {
        println!("SIP_E2E_OK registered call={}", call_id.unwrap_or_default());
    } else {
        eprintln!("SIP_E2E_FAIL registered={registered} call_active={call_active}");
        std::process::exit(1);
    }
}
```

`VoiceCommand::PlaceTestCall { uri }` is a `#[cfg(feature = "e2e")]`-gated command added to the crate (`[features] e2e = []` in `apps/desktop/voice/Cargo.toml`) that originates an outgoing call to the harness's echo target. It exists only for this harness; the product has no outbound calling (spec §2).

- [ ] **Step 2: Write the runner script**

`deploy/docker/tests/telephony/run-desktop-sip-e2e.sh` — copy `run-android-sip-e2e.sh` and cut it down: same stack boot (its compose services come from `docker-compose.android-sip.yml`; reuse that file — the TLS-edge + Asterisk + CoTURN + carrier topology is client-agnostic), same credential provisioning step (the `android-sip-params.e2e.ts` flow, which enrols a volunteer through the API and fetches a real `/api/telephony/sip-token`), then instead of the emulator section:

```bash
# --- Desktop harness: build and run the headless client -------------------
scripts/fetch-linphone-sdk.sh linux-x86_64
cargo build --manifest-path apps/desktop/voice/Cargo.toml --features e2e --example sip_e2e
export LD_LIBRARY_PATH="$ROOT/apps/desktop/vendor/linphone-sdk/linux-x86_64/lib:${LD_LIBRARY_PATH:-}"

./apps/desktop/voice/target/debug/examples/sip_e2e \
  "$SIP_DOMAIN" "$SIP_USERNAME" "$SIP_PASSWORD" "stun:$COTURN_HOST:3478" \
  ${ANCHOR_FILE:+"$ANCHOR_FILE"}

# --- Receiving-end evidence off Asterisk's own log -------------------------
# The client believes what it believes; the PBX is the witness (spec §8 Tier 2).
docker compose -p "$PROJECT" logs asterisk > "$EVIDENCE_DIR/asterisk.log"
grep -q "UDP/TLS/RTP/SAVPF" "$EVIDENCE_DIR/asterisk.log" \
  || { echo "FAIL: SDP answer did not negotiate DTLS-SRTP" >&2; exit 1; }
grep -qE "a=fingerprint:sha-256" "$EVIDENCE_DIR/asterisk.log" \
  || { echo "FAIL: no DTLS fingerprint in SDP" >&2; exit 1; }
grep -q "StreamsRunning" "$EVIDENCE_DIR/asterisk.log" \
  || { echo "FAIL: media streams never ran" >&2; exit 1; }
grep -qE "candidate.* (srflx|relay)" "$EVIDENCE_DIR/asterisk.log" \
  || { echo "FAIL: ICE produced only host candidates" >&2; exit 1; }
echo "desktop SIP e2e: OK"
```

(Exact log patterns come from the android runner's assertion block — copy them verbatim from `run-android-sip-e2e.sh` rather than re-deriving.)

- [ ] **Step 3: Run it locally against the stack**

```bash
deploy/docker/tests/telephony/run-desktop-sip-e2e.sh
```

Expected: `desktop SIP e2e: OK`. If registration fails with `tlsv1 alert unknown ca`, the trust-anchor path in Task 4 is wrong — the android harness hit exactly this (the runner script's header comment lists it); do not disable verification, fix the anchor plumbing.

- [ ] **Step 4: Add the CI job**

Append to `.github/workflows/desktop-voice.yml`:

```yaml
  desktop-sip-e2e:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: dtolnay/rust-toolchain@stable
      - name: Headless desktop SIP e2e through the TLS edge
        run: deploy/docker/tests/telephony/run-desktop-sip-e2e.sh
```

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/voice/ deploy/docker/tests/telephony/run-desktop-sip-e2e.sh .github/workflows/desktop-voice.yml
git commit -m "test(desktop): headless SIP e2e — register + echo call through the TLS edge (#1770)"
```

---

### Task 6: Shell credential fetch — `/sip-token` from Rust, over the pinned stack

The webview never sees the credential (spec §1.2): the shell mints the auth token from `CryptoState` and fetches through the same pinned-TLS machinery `net.rs` already uses. 400/403/503 map to `unavailable` states, never retry loops (spec §7.1).

**Files:**
- Create: `apps/desktop/src/voice.rs` (this task writes the fetch half; Task 7 adds the IPC half; Task 8 adds lifecycle)
- Modify: `apps/desktop/src/lib.rs` (module declaration only)

**Interfaces:**
- Produces:

```rust
/// What the shell fetches and holds. `serde::Deserialize` only — this type is
/// never serialized, never crosses IPC (spec §1.4).
#[derive(Debug, serde::Deserialize)]
pub struct SipTokenResponseWire {
    pub provider: String,
    pub sip: SipWire,
}
#[derive(Debug, serde::Deserialize)]
pub struct SipWire {
    pub domain: String,
    pub transport: String,                 // validated == "tls" below
    pub username: String,
    pub password: String,
    #[serde(rename = "iceServers")] pub ice_servers: Vec<IceServerWire>,
    #[serde(rename = "mediaEncryption")] pub media_encryption: String, // validated == "dtls-srtp"
    #[serde(rename = "tlsTrustAnchorPem")] pub tls_trust_anchor_pem: Option<String>,
}

pub enum SipTokenFetchError {
    Unavailable(String),   // 400/403/503 — fail closed, show reason, no retry loop
    Transport(String),     // network/TLS failure — retry on next shift sync
}

pub async fn fetch_sip_token(app: &tauri::AppHandle) -> Result<SipTokenResponseWire, SipTokenFetchError>;
```

- Consumed by: Task 8's lifecycle manager.

- [ ] **Step 1: Read the net.rs client construction you must reuse**

```bash
grep -n "reqwest::Client\|cert_pin\|fn pinned_client\|ClientBuilder" apps/desktop/src/net.rs | head -20
grep -n "pub fn create_auth_token_from_state" -A 15 apps/desktop/src/crypto.rs
```

The fetch must go through the same rustls client builder with the SPKI pin verifier (`cert_pin.rs`) and the same single-origin check as `net_fetch` — the SIP edge's trust anchor arrives INSIDE this authenticated response, so this fetch itself is pinned against the API origin's captured pins, not the anchor.

- [ ] **Step 2: Write the fetch function**

In `apps/desktop/src/voice.rs`:

```rust
pub async fn fetch_sip_token(app: &tauri::AppHandle) -> Result<SipTokenResponseWire, SipTokenFetchError> {
    // 1. Auth token minted in-process (crypto.rs) — the webview is not involved.
    let token = crate::crypto::create_auth_token_from_state(app.state())
        .map_err(|e| SipTokenFetchError::Transport(format!("auth token: {e}")))?;
    // 2. Same pinned client + configured single origin as net.rs.
    let origin = crate::api_config::get_origin(app)
        .map_err(|e| SipTokenFetchError::Transport(e))?;
    let client = crate::net::pinned_client_for(app, &origin)
        .map_err(SipTokenFetchError::Transport)?;
    let resp = client
        .get(format!("{origin}/api/telephony/sip-token"))
        .header("authorization", format!("Bearer {token}"))
        .send().await
        .map_err(|e| SipTokenFetchError::Transport(e.to_string()))?;

    match resp.status().as_u16() {
        200 => {}
        // Fail closed with the reason (spec §7.1 rows 1–2): never a retry loop.
        s @ (400 | 403 | 503) => {
            let body = resp.text().await.unwrap_or_default();
            return Err(SipTokenFetchError::Unavailable(format!("{s}: {body}")));
        }
        s => return Err(SipTokenFetchError::Transport(format!("unexpected {s}"))),
    }

    let wire: SipTokenResponseWire = resp.json().await
        .map_err(|e| SipTokenFetchError::Transport(format!("decode: {e}")))?;

    // Policy at the boundary (spec §7.1): only tls, only dtls-srtp. Anything
    // else is a server misconfiguration to SURFACE, never to follow.
    if wire.sip.transport != "tls" {
        return Err(SipTokenFetchError::Unavailable(format!(
            "server offered transport '{}' — desktop honours only tls", wire.sip.transport)));
    }
    if wire.sip.media_encryption != "dtls-srtp" {
        return Err(SipTokenFetchError::Unavailable(format!(
            "server offered mediaEncryption '{}' — desktop requires dtls-srtp", wire.sip.media_encryption)));
    }
    Ok(wire)
}
```

If `net.rs` does not currently expose a reusable pinned-client constructor, extract one: `pub(crate) fn pinned_client_for(app: &AppHandle, origin: &str) -> Result<reqwest::Client, String>` — move the existing builder out of `net_fetch` without changing its behaviour. Check `api_config.rs` for the actual origin getter name and use it as-is.

- [ ] **Step 3: Write the failure-mapping test**

Follow `net.rs`'s existing test pattern (it already spins a local TLS server with `rcgen` + `tokio-rustls` — see `apps/desktop/Cargo.toml` dev-dependencies and the tests at `net.rs:605+`). `apps/desktop/src/voice.rs` test module:

```rust
#[tokio::test]
async fn sip_token_failures_map_to_unavailable_not_retry() {
    // 403 (revoked / no hub role) and 503 (registrar unreachable) must come
    // back as Unavailable — the lifecycle manager (Task 8) stops on these.
    for status in [400u16, 403, 503] {
        let server = TestTlsServer::responding(status, "{}").await; // net.rs test helper pattern
        let err = fetch_sip_token_from(&server.client(), &server.origin()).await.unwrap_err();
        assert!(matches!(err, SipTokenFetchError::Unavailable(_)), "status {status}");
    }
}

#[tokio::test]
async fn non_tls_transport_is_rejected_as_misconfiguration() {
    let server = TestTlsServer::responding(200, r#"{"provider":"asterisk","sip":{
        "domain":"edge.test","transport":"udp","username":"vol_x","password":"p",
        "iceServers":[],"mediaEncryption":"dtls-srtp"}}"#).await;
    let err = fetch_sip_token_from(&server.client(), &server.origin()).await.unwrap_err();
    assert!(matches!(err, SipTokenFetchError::Unavailable(_)));
}
```

(`fetch_sip_token_from(client, origin)` is the testable inner function; `fetch_sip_token` is the AppHandle wrapper.)

- [ ] **Step 4: Run the desktop crate tests**

```bash
cargo test --manifest-path apps/desktop/Cargo.toml voice
```

Expected: new tests pass; existing `net`/`cert_pin` tests untouched and passing.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/voice.rs apps/desktop/src/lib.rs apps/desktop/src/net.rs apps/desktop/src/api_config.rs
git commit -m "feat(desktop): shell-side /sip-token fetch over the pinned TLS stack (#1770)"
```

---

### Task 7: The IPC surface across all four layers

The boundary contract (spec §1.4) lands in the four places the boundary test parses. After this task the mock can drive every UI behaviour, so Tier 3 (Task 11) needs no Rust at all.

**Files:**
- Modify: `apps/desktop/src/voice.rs` (command handlers + emit)
- Modify: `apps/desktop/src/lib.rs` (`generate_handler!`)
- Modify: `apps/desktop/isolation/index.html` (`ALLOWED_COMMANDS`)
- Modify: `src/client/lib/platform.ts` (union + wrappers + listeners)
- Modify: `tests/mocks/tauri-core.ts` (mock handlers + `emitVoiceEvent`)

**Interfaces:**
- Produces — commands (webview → shell), exactly:

```ts
export type VoiceIpcCommand =
  | 'voice_sync_registrations'   // desired state changed; shell owns the fetch
  | 'voice_unregister_all'
  | 'voice_answer'               // { callId }
  | 'voice_decline'              // { callId }
  | 'voice_hangup'               // { callId }
  | 'voice_set_muted'            // { callId, muted }
  | 'voice_list_audio_devices'   // → { input: VoiceAudioDevice[], output: VoiceAudioDevice[] }
  | 'voice_select_audio_device'  // { kind: 'input' | 'output', id }
```

- Produces — events (shell → webview), emitted with `AppHandle::emit`:

```ts
export interface VoiceRegistrationPayload {
  state: 'registering' | 'registered' | 'unregistered' | 'failed' | 'unavailable' | 'credential-revoked'
  reason?: string            // never the credential, never the secret (spec §1.4)
}
export interface VoiceCallPayload {
  callId: string
  state: 'incoming' | 'connecting' | 'active' | 'ended' | 'error'
  muted: boolean
  reason?: string
}
// channels: 'voice:registration', 'voice:call', 'voice:error'
```

- Produces — webview API (consumed by Task 9's store):

```ts
export async function voiceSyncRegistrations(): Promise<void>
export async function voiceUnregisterAll(): Promise<void>
export async function voiceAnswer(callId: string): Promise<void>
export async function voiceDecline(callId: string): Promise<void>
export async function voiceHangup(callId: string): Promise<void>
export async function voiceSetMuted(callId: string, muted: boolean): Promise<void>
export async function voiceListAudioDevices(): Promise<VoiceAudioDevices>
export async function voiceSelectAudioDevice(kind: 'input' | 'output', id: string): Promise<void>
export async function listenVoiceRegistration(h: (p: VoiceRegistrationPayload) => void): Promise<() => void>
export async function listenVoiceCall(h: (p: VoiceCallPayload) => void): Promise<() => void>
export async function listenVoiceError(h: (p: { message: string }) => void): Promise<() => void>
```

- [ ] **Step 1: Write the Rust command handlers**

In `apps/desktop/src/voice.rs`:

```rust
use tauri::{AppHandle, State};

pub struct VoiceState(pub std::sync::Mutex<Option<crate::voice::VoiceManager>>);

fn emit_registration(app: &AppHandle, p: &VoiceRegistrationPayload) {
    // Fire-and-forget with last-state retained webview-side; the webview
    // reduces events into a synchronous store (spec §1.4, Tauri async-listener
    // ordering warning).
    let _ = app.emit("voice:registration", p);
}

#[tauri::command]
pub async fn voice_sync_registrations(
    state: State<'_, VoiceState>, app: AppHandle,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "voice state poisoned")?;
    let manager = guard.get_or_insert_with(|| VoiceManager::new(app.clone()));
    manager.request_sync(); // non-blocking; the manager fetches + registers off-thread
    Ok(())
}

#[tauri::command]
pub async fn voice_answer(state: State<'_, VoiceState>, call_id: String) -> Result<(), String> {
    let guard = state.0.lock().map_err(|_| "voice state poisoned")?;
    if let Some(m) = guard.as_ref() { m.post(VoiceCommand::Answer(call_id)); }
    Ok(()) // command accepted; outcome arrives as a voice:call event
}

// voice_decline, voice_hangup, voice_set_muted, voice_select_audio_device:
//   same shape — lock, post the matching VoiceCommand, return Ok(()).
// voice_list_audio_devices: posts ListAudioDevices and awaits the pump's
//   answer on a oneshot channel with a 2 s timeout (device enumeration is the
//   only synchronous query in the surface).
```

Register in `apps/desktop/src/lib.rs` inside `generate_handler![...]`, grouped under a `// Voice (SIP/WebRTC — credential confined to the shell, #1770)` comment:

```rust
            // Voice (SIP/WebRTC — credential confined to the shell, #1770)
            voice::voice_sync_registrations,
            voice::voice_unregister_all,
            voice::voice_answer,
            voice::voice_decline,
            voice::voice_hangup,
            voice::voice_set_muted,
            voice::voice_list_audio_devices,
            voice::voice_select_audio_device,
```

and `app.manage(VoiceState(std::sync::Mutex::new(None)))` next to the other state construction.

- [ ] **Step 2: Update the isolation allowlist**

In `apps/desktop/isolation/index.html`, add to `ALLOWED_COMMANDS` (alphabetical position, matching the file's existing grouping style):

```js
    'voice_sync_registrations',
    'voice_unregister_all',
    'voice_answer',
    'voice_decline',
    'voice_hangup',
    'voice_set_muted',
    'voice_list_audio_devices',
    'voice_select_audio_device',
```

- [ ] **Step 3: Extend `platform.ts`**

Append the eight command names to the `TauriIpcCommand` union (after `'net_ws_close'`), then the wrappers and listeners:

```ts
export async function voiceAnswer(callId: string): Promise<void> {
  if (useTauri) return tauriInvoke('voice_answer', { callId })
  throw new Error('voiceAnswer: not in Tauri context')
}
```

The listeners mirror `listenNetWs` exactly, including the Playwright branch:

```ts
export async function listenVoiceCall(
  handler: (p: VoiceCallPayload) => void,
): Promise<() => void> {
  const channel = 'voice:call'
  if (import.meta.env.PLAYWRIGHT_TEST) {
    const win = window as unknown as Record<string, unknown>
    if (!win.__VOICE_LISTENERS__) win.__VOICE_LISTENERS__ = {}
    const map = win.__VOICE_LISTENERS__ as Record<string, Array<(p: unknown) => void>>
    ;(map[channel] ??= []).push(handler as (p: unknown) => void)
    return () => { map[channel] = (map[channel] ?? []).filter(h => h !== handler) }
  }
  if (useTauri) {
    const { listen } = await import('@tauri-apps/api/event')
    return listen<VoiceCallPayload>(channel, e => handler(e.payload))
  }
  throw new Error('listenVoiceCall: not in Tauri context')
}
```

(`listenVoiceRegistration` / `listenVoiceError` identical with their channels.)

- [ ] **Step 4: Extend the IPC mock**

In `tests/mocks/tauri-core.ts`, next to `emitNetWsEvent`:

```ts
/** Emits a `voice:*` payload to listeners registered via platform.ts's listenVoice* (PLAYWRIGHT_TEST branch). */
function emitVoiceEvent(channel: 'voice:registration' | 'voice:call' | 'voice:error', payload: unknown): void {
  const win = window as unknown as Record<string, unknown>
  const map = (win.__VOICE_LISTENERS__ ?? {}) as Record<string, Array<(p: unknown) => void>>
  for (const handler of map[channel] ?? []) handler(payload)
}

/** In-memory voice state machine — the shell's stand-in for Tier 3. */
const mockVoice = {
  registration: 'unregistered' as 'unregistered' | 'registering' | 'registered' | 'failed' | 'unavailable' | 'credential-revoked',
  calls: new Map<string, { state: string; muted: boolean }>(),
}
```

Add the eight handlers to `commands` — each mutates `mockVoice` and emits the resulting event, e.g.:

```ts
  voice_sync_registrations: async () => {
    mockVoice.registration = 'registering'
    emitVoiceEvent('voice:registration', { state: 'registering' })
    mockVoice.registration = 'registered'
    emitVoiceEvent('voice:registration', { state: 'registered' })
  },
  voice_answer: async (a) => {
    const id = a.callId as string
    const call = mockVoice.calls.get(id)
    if (!call || call.state !== 'incoming') throw new Error(`no ringing call ${id}`)
    call.state = 'connecting'
    emitVoiceEvent('voice:call', { callId: id, state: 'connecting', muted: call.muted })
    call.state = 'active'
    emitVoiceEvent('voice:call', { callId: id, state: 'active', muted: call.muted })
  },
```

and two mock-only injection commands on the `MockOnlyCommand` union (they have no Rust counterpart and must NOT appear in the other three layers):

```ts
  | 'voice_test_ring'          // { callId } — inject an inbound ring
  | 'voice_test_registration'  // { state, reason? } — inject a registration outcome
```

with handlers that push state and call `emitVoiceEvent`. Tests invoke them through `window[Symbol.for('llamenos_test_invoke')]` exactly as `pin-lockout-steps.ts` does.

- [ ] **Step 5: Run the boundary test and typecheck**

```bash
bunx vitest run src/client/lib/desktop-ipc-boundary.test.ts
bun run typecheck
```

Expected: boundary test passes with all eight commands in all four layers; typecheck clean. If the boundary test fails on an event-channel disagreement, extend it to parse `voice:*` emit/listen pairs the same way it parses commands — that extension is part of this task (spec §1.4: "the four-layer boundary test extended to every `voice_*` command and event").

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/voice.rs apps/desktop/src/lib.rs apps/desktop/isolation/index.html src/client/lib/platform.ts tests/mocks/tauri-core.ts src/client/lib/desktop-ipc-boundary.test.ts
git commit -m "feat(desktop): voice IPC surface across all four layers (#1770)"
```

---

### Task 8: Registration lifecycle — clock-in driven, TURN refresh, lock/quit

Spec §5.3, implemented in `VoiceManager`. One registration per device; re-registration rides liblinphone's refresher (no competing app timer); the binding constraint is the 3600 s TURN credential TTL.

**Files:**
- Modify: `apps/desktop/src/voice.rs` (the `VoiceManager`)
- Modify: `apps/desktop/src/lib.rs` (crypto-lock hook; quit hook in the `RunEvent` handler)

**Interfaces:**
- Produces:

```rust
pub struct VoiceManager { /* core: VoiceCore, credential: Option<SipTokenResponseWire>, refresh: JoinHandle */ }
impl VoiceManager {
    pub fn new(app: AppHandle) -> Self;
    /// Idempotent desired-state signal. Safe to call on every clock-in,
    /// shift-status sync, and app start (spec §5.1 step 1).
    pub fn request_sync(&mut self);
    /// Lock/quit path: unregister, zeroize the credential, stop the refresh task.
    pub fn unregister_and_zeroize(&mut self);
}
```

- Consumed by: `lib.rs` hooks and Task 9's webview triggers.

- [ ] **Step 1: Write the failing lifecycle unit tests**

`VoiceManager`'s decision logic is separated from I/O for testability — a `LifecyclePolicy` pure struct:

```rust
#[cfg(test)]
mod lifecycle_tests {
    #[test]
    fn turn_refresh_fires_at_eighty_percent_of_ttl() {
        // TURN_CREDENTIAL_TTL_SECONDS = 3600; refresh at 2880 s (spec §5.3).
        assert_eq!(TURN_REFRESH_AFTER, Duration::from_secs(2880));
    }

    #[test]
    fn revoked_credential_stops_all_retries() {
        let mut policy = LifecyclePolicy::new();
        policy.on_fetch_result(Err(SipTokenFetchError::Unavailable("403".into())));
        assert_eq!(policy.state(), LifecycleState::CredentialRevoked);
        assert!(policy.next_action().is_none(), "a revoked endpoint never hammers the registrar (spec §5.3)");
    }

    #[test]
    fn transport_failure_retries_on_next_sync_not_a_tight_loop() {
        let mut policy = LifecyclePolicy::new();
        policy.on_fetch_result(Err(SipTokenFetchError::Transport("timeout".into())));
        assert_eq!(policy.state(), LifecycleState::Unavailable);
        assert!(matches!(policy.next_action(), Some(NextAction::WaitForSyncSignal)));
    }

    #[test]
    fn register_rejected_after_issuance_is_revocation() {
        // REGISTER 401 after a successful fetch: one credential refresh is
        // allowed to resolve it; a second failure is revocation (spec §7.1).
        let mut policy = LifecyclePolicy::new();
        policy.on_registration_failed();
        assert!(matches!(policy.next_action(), Some(NextAction::RefreshCredential)));
        policy.on_registration_failed();
        assert_eq!(policy.state(), LifecycleState::CredentialRevoked);
    }
}
```

- [ ] **Step 2: Implement `LifecyclePolicy` and `VoiceManager`**

The policy struct holds `state`, a `refresh_attempts` counter, and `next_action()`. `VoiceManager` drives it:

```rust
impl VoiceManager {
    pub fn request_sync(&mut self) {
        if self.policy.state() == LifecycleState::CredentialRevoked { return; }
        let app = self.app.clone();
        tokio::spawn(async move {
            match fetch_sip_token(&app).await {
                Ok(wire) => { /* post VoiceCommand::Register(convert(wire)); arm the 2880 s TURN-refresh timer */ }
                Err(e) => { /* policy.on_fetch_result(e); emit voice:registration unavailable/credential-revoked */ }
            }
        });
    }

    pub fn unregister_and_zeroize(&mut self) {
        self.refresh.abort();
        self.core.post(VoiceCommand::UnregisterAll);
        if let Some(mut cred) = self.credential.take() {
            // zeroize every secret field before drop — the credential is a
            // live receive-calls capability (spec §1.2).
            unsafe { cred.sip.password.as_bytes_mut().fill(0) };
            for s in &mut cred.sip.ice_servers {
                if let Some(c) = &mut s.credential { unsafe { c.as_bytes_mut().fill(0) } }
            }
        }
        let _ = self.app.emit("voice:registration", VoiceRegistrationPayload {
            state: "unregistered", reason: None,
        });
    }
}
```

The TURN refresh task: `tokio::time::sleep(TURN_REFRESH_AFTER)` then `request_sync()`; on success the shell re-applies ICE servers via `VoiceCommand::RefreshIceServers` without tearing down the registration.

- [ ] **Step 3: Hook lock and quit in `lib.rs`**

Crypto lock: find where `lock_crypto` succeeds (`apps/desktop/src/crypto.rs` command) and, after it, call `voice_unregister_and_zeroize` via the managed `VoiceState` — a locked desktop cannot render the call workspace, and server-side reachability excludes the endpoint so the caller is unaffected (spec §5.3). Process quit: in the `RunEvent::ExitRequested` handler (or the existing single-instance/exit path), call `unregister_and_zeroize` best-effort with a short timeout; the residual binding dies by the ≤600 s expiry plus the PBX's 60 s qualify either way.

- [ ] **Step 4: Run tests**

```bash
cargo test --manifest-path apps/desktop/Cargo.toml voice
```

Expected: the four lifecycle tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/voice.rs apps/desktop/src/lib.rs
git commit -m "feat(desktop): clock-in-driven SIP lifecycle with TURN refresh and revocation stop (#1770)"
```

---

### Task 9: Webview voice store and lifecycle triggers

The webview half of §5.1/§5.3: fire `voiceSyncRegistrations()` when the desired state changes, reduce `voice:*` events into a synchronous store the UI subscribes to.

**Files:**
- Create: `src/client/lib/voice.ts`
- Modify: `src/client/lib/queries/shifts.ts`
- Create: `src/client/lib/voice.test.ts`

**Interfaces:**
- Produces:

```ts
export type VoiceRegistrationState =
  | 'unregistered' | 'registering' | 'registered' | 'failed' | 'unavailable' | 'credential-revoked'

export interface VoiceStoreSnapshot {
  registration: VoiceRegistrationState
  registrationReason?: string
  calls: ReadonlyMap<string, VoiceCallPayload>
}

export function useVoiceStore(): VoiceStoreSnapshot            // useSyncExternalStore
export function isInAppCallAnswerable(callId: string): boolean // registration registered && shell has the ring
export function triggerVoiceSync(): void                       // fire-and-forget, never throws
```

- Consumed by: Task 10's UI wiring.

- [ ] **Step 1: Write the failing store test**

`src/client/lib/voice.test.ts` (vitest, jsdom — same pattern as other `src/client/lib` tests):

```ts
import { describe, expect, it, beforeEach } from 'vitest'

describe('voice store', () => {
  beforeEach(() => { /* reset module store between tests */ })

  it('reduces registration events into state', async () => {
    emit('voice:registration', { state: 'registering' })
    expect(useVoiceStore.getState().registration).toBe('registering')
    emit('voice:registration', { state: 'registered' })
    expect(useVoiceStore.getState().registration).toBe('registered')
  })

  it('keeps per-call state keyed by callId — a ring from any hub lands', () => {
    emit('voice:call', { callId: 'c1', state: 'incoming', muted: false })
    emit('voice:call', { callId: 'c2', state: 'incoming', muted: false })
    expect(useVoiceStore.getState().calls.size).toBe(2)
    emit('voice:call', { callId: 'c1', state: 'ended', muted: false })
    expect(useVoiceStore.getState().calls.has('c1')).toBe(false)
    expect(useVoiceStore.getState().calls.has('c2')).toBe(true)
  })

  it('failure states carry the reason and never clear notes state', () => {
    emit('voice:registration', { state: 'failed', reason: 'tls handshake' })
    const s = useVoiceStore.getState()
    expect(s.registration).toBe('failed')
    expect(s.registrationReason).toBe('tls handshake')
  })
})
```

(`emit` is the test's handle on the registered listeners — import the same `__VOICE_LISTENERS__` registry the mock uses.)

- [ ] **Step 2: Implement `src/client/lib/voice.ts`**

A module-level store with `useSyncExternalStore`, subscribing to the three `listenVoice*` channels at module init, mirroring the reduction style `hooks.ts` uses for relay events. `triggerVoiceSync()`:

```ts
export function triggerVoiceSync(): void {
  // Fire-and-forget (spec §7.1 IPC row): the webview never blocks note-taking
  // on a shell response. State arrives by event.
  voiceSyncRegistrations().catch(() => { /* last known state stays rendered */ })
}
```

- [ ] **Step 3: Wire the lifecycle triggers in `queries/shifts.ts`**

The mutations are already there (`useMutation({ mutationFn: clockIn })` at ~line 260, `clockOut` alongside). Add `onSettled` triggers:

```ts
// Clock-in on the first on-shift hub registers; clocking into additional
// hubs changes nothing at the SIP layer; clock-out of the LAST on-shift hub
// unregisters. The shell reconciles desired state — the webview only signals.
onSettled: () => { triggerVoiceSync() },
```

Also fire `triggerVoiceSync()` where shift-status data loads (the query's `onSuccess`/a `useEffect` in the existing shift-status consumer) so app-start-while-on-shift reconciles — same semantics as Android's `SipRegistrar.syncWithShift`.

- [ ] **Step 4: Run tests and typecheck**

```bash
bunx vitest run src/client/lib/voice.test.ts
bun run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/client/lib/voice.ts src/client/lib/voice.test.ts src/client/lib/queries/shifts.ts
git commit -m "feat(desktop): webview voice store + clock-in lifecycle triggers (#1770)"
```

---

### Task 10: Call UI — answer/decline/mute/device selection + `softphone.*` strings

Wire the existing ringing/active-call UI (`src/client/routes/index.tsx`, fed by `useCalls()`) to the voice layer for in-app legs, leaving the phone-leg POST path untouched (spec §5.2 step 3: no `POST /calls/:id/answer` for the in-app leg — the SIP answer IS the answer).

**Files:**
- Modify: `src/client/routes/index.tsx`
- Create: `src/client/components/voice-controls.tsx`
- Modify: `packages/i18n/locales/en.json` (+ other locales per the i18n workflow)

**Interfaces:**
- Consumes: `useVoiceStore`, `voiceAnswer/Decline/Hangup/SetMuted/ListAudioDevices/SelectAudioDevice` (Tasks 7, 9).
- Produces: testids `voice-registration-badge`, `voice-answer-button`, `voice-decline-button`, `voice-mute-toggle`, `voice-hangup-button`, `voice-device-picker-{input,output}` (register them in `tests/test-ids.ts` if that file is the canonical list — check first).

- [ ] **Step 1: Add the i18n keys**

In `packages/i18n/locales/en.json`, a new top-level `softphone` namespace (verify no existing `softphone` key first: `grep -c '"softphone' packages/i18n/locales/en.json` must print 0):

```json
  "softphone": {
    "registered": "In-app calls active",
    "registering": "Connecting in-app calls…",
    "unavailable": "In-app audio unavailable",
    "failed": "In-app audio failed: {{reason}}",
    "credentialRevoked": "In-app audio access was revoked. Calls will ring your phone.",
    "answer": "Answer",
    "decline": "Decline",
    "hangup": "Hang up",
    "mute": "Mute",
    "unmute": "Unmute",
    "inputDevice": "Microphone",
    "outputDevice": "Speaker",
    "mediaFailed": "The call could not carry audio: {{reason}}",
    "reconnecting": "Reconnecting audio…"
  }
```

Then:

```bash
bun run i18n:codegen && bun run i18n:validate:all
```

`i18n:validate` reports any locale missing the new keys; add the English source as the placeholder in each reported locale file, matching how previous key additions were propagated (check `git log --oneline -3 -- packages/i18n/locales/` for the last additive change and mirror its shape).

- [ ] **Step 2: Build `voice-controls.tsx`**

```tsx
export function VoiceControls({ callId }: { callId: string }) {
  const voice = useVoiceStore()
  const call = voice.calls.get(callId)
  if (!call || call.state === 'ended') return null
  return (
    <div data-testid="voice-controls" data-call-id={callId}>
      <button
        data-testid="voice-mute-toggle"
        aria-pressed={call.muted}
        onClick={() => void voiceSetMuted(callId, !call.muted).catch(() => {})}
      >
        {call.muted ? t('softphone.unmute') : t('softphone.mute')}
      </button>
      <button data-testid="voice-hangup-button" onClick={() => void voiceHangup(callId).catch(() => {})}>
        {t('softphone.hangup')}
      </button>
      <VoiceDevicePicker kind="input" />
      <VoiceDevicePicker kind="output" />
    </div>
  )
}
```

`VoiceDevicePicker` loads devices via `voiceListAudioDevices()` on open and renders a `<select data-testid={\`voice-device-picker-${kind}\`}>` whose change calls `voiceSelectAudioDevice(kind, id)`.

- [ ] **Step 3: Wire answer/decline in `routes/index.tsx`**

The ringing card currently calls `answerCall(call.id)` (the POST path). Change the dispatch — not the POST path itself:

```tsx
const voice = useVoiceStore()
const answerInApp = voice.registration === 'registered' && voice.calls.get(call.id)?.state === 'incoming'

<button
  data-testid={answerInApp ? 'voice-answer-button' : 'answer-call-button'}
  onClick={() => answerInApp ? void voiceAnswer(call.id).catch(() => {}) : answerCall(call.id)}
>
```

Decline mirrors: `voiceDecline(call.id)` when the shell has the ring; otherwise the existing dismiss. **The `setActiveHub` rule is load-bearing here (spec §5.3):** hub switching happens only on the answered path — keep the existing answered-path hub logic exactly as-is and add nothing to the ring render. A ring from a non-active hub must render with its own hub attribution (the relay `call:ring` already carries `hubId`; `useCalls()` already stores it per call).

Render the registration badge near the shift status:

```tsx
{voice.registration !== 'registered' && voice.registration !== 'unregistered' && (
  <div data-testid="voice-registration-badge" data-state={voice.registration}>
    {t(`softphone.${voice.registration === 'credential-revoked' ? 'credentialRevoked' : voice.registration}`,
       { reason: voice.registrationReason })}
  </div>
)}
```

No Answer button is rendered into a registration-failure state for an in-app-only path — that is the #1147/#1741 regression guard, and Task 11 tests it.

- [ ] **Step 4: Typecheck, lint, validate i18n**

```bash
bun run typecheck && bun run lint && bun run i18n:validate:all
```

- [ ] **Step 5: Commit**

```bash
git add src/client/routes/index.tsx src/client/components/voice-controls.tsx packages/i18n/locales/
git commit -m "feat(desktop): in-app answer/decline/mute/device UI with softphone.* strings (#1770)"
```

---

### Task 11: Tier 3 — Playwright through the mock voice layer

Spec §8 Tier 3, driving the mock's `voice_test_*` injection commands through the `Symbol.for('llamenos_test_invoke')` bridge. No Rust process exists in Playwright — that is the point.

**Files:**
- Create: `tests/voice-desktop.spec.ts`

**Interfaces:**
- Consumes: the mock's `voice_test_ring` / `voice_test_registration` mock-only commands (Task 7), the testids from Task 10.

- [ ] **Step 1: Write the multi-hub ring spec**

```ts
import { test, expect, type Page } from '@playwright/test'
import { loginAsAdmin, Timeouts } from './helpers'

async function voiceTest(page: Page, cmd: string, args: Record<string, unknown>) {
  await page.evaluate(
    ([c, a]) => (window as never)[Symbol.for('llamenos_test_invoke')](c, a),
    [cmd, args] as const,
  )
}

test.describe('desktop in-app voice (mock IPC)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  test('a ring from a non-active hub renders with its hub and does not switch hubs', async ({ page }) => {
    // Seed two hub memberships and land on hub A (existing multi-hub helpers —
    // mirror tests/multi-hub-active-hub.spec.ts's setup, which already proves
    // relay-driven multi-hub ring).
    await voiceTest(page, 'voice_test_registration', { state: 'registered' })
    await voiceTest(page, 'voice_test_ring', { callId: 'call-from-hub-b' })
    const card = page.getByTestId('voice-answer-button')
    await expect(card).toBeVisible({ timeout: Timeouts.ELEMENT })
    // Active hub unchanged until the answered path — read the hub switcher's
    // current value the same way tests/multi-hub-active-hub.spec.ts does.
    await expect(page.getByTestId('hub-switcher-current')).toHaveAttribute('data-hub-name', /Hub A/)
  })

  test('answer → connecting → active → ended renders each state; mute toggles', async ({ page }) => {
    await voiceTest(page, 'voice_test_registration', { state: 'registered' })
    await voiceTest(page, 'voice_test_ring', { callId: 'c1' })
    await page.getByTestId('voice-answer-button').click()
    await expect(page.getByTestId('voice-controls')).toBeVisible()
    await page.getByTestId('voice-mute-toggle').click()
    await expect(page.getByTestId('voice-mute-toggle')).toHaveAttribute('aria-pressed', 'true')
    await page.getByTestId('voice-hangup-button').click()
    await expect(page.getByTestId('voice-controls')).toHaveCount(0)
  })

  test('registration failure renders the reason and no Answer path into silence (#1147/#1741)', async ({ page }) => {
    await voiceTest(page, 'voice_test_registration', { state: 'failed', reason: 'tls handshake' })
    await expect(page.getByTestId('voice-registration-badge')).toHaveAttribute('data-state', 'failed')
    await expect(page.getByTestId('voice-registration-badge')).toContainText('tls handshake')
    await voiceTest(page, 'voice_test_ring', { callId: 'c2' })
    await expect(page.getByTestId('voice-answer-button')).toHaveCount(0)
  })

  test('the call workspace survives call-state churn', async ({ page }) => {
    await voiceTest(page, 'voice_test_registration', { state: 'registered' })
    await voiceTest(page, 'voice_test_ring', { callId: 'c3' })
    await page.getByTestId('voice-answer-button').click()
    // Begin a note edit mid-call (existing note-sheet testids).
    await page.getByTestId('note-sheet-open').click()
    await page.getByTestId('note-body-input').fill('mid-call edit')
    await page.getByTestId('voice-hangup-button').click()
    await expect(page.getByTestId('note-body-input')).toHaveValue('mid-call edit')
  })
})
```

Verify the exact setup helpers and testids against `tests/multi-hub-active-hub.spec.ts` and the components written in Task 10 before finalizing — adjust names to what exists, never invent a testid the UI doesn't render.

- [ ] **Step 2: Run the spec**

```bash
PLAYWRIGHT_TEST=true bunx playwright test tests/voice-desktop.spec.ts --workers=1
```

Expected: 4/4 pass. If the registration badge assertions flap, the store subscription is mounted too late — subscribe at module init in `voice.ts`, not in a component effect.

- [ ] **Step 3: Commit**

```bash
git add tests/voice-desktop.spec.ts
git commit -m "test(desktop): Tier 3 voice specs through mock IPC events (#1770)"
```

---

### Task 12: Tier 1 extension — REGISTER expiry cap at the edge

The one client-visible edge behaviour the current socket tests don't pin (spec §8 Tier 1): the granted expiry respects the server's 600 s cap when the desktop shell requests it.

**Files:**
- Modify: `deploy/docker/tests/telephony/kamailio-edge.e2e.ts`

**Interfaces:**
- Consumes: the file's existing SIP REGISTER helper (it already performs a real REGISTER with a real credential — the `sip-register.ts`/`sip-ua.ts` helpers in the same directory).

- [ ] **Step 1: Read the existing REGISTER flow**

```bash
sed -n '101,160p' deploy/docker/tests/telephony/kamailio-edge.e2e.ts
grep -n "expires\|Expires\|Contact" deploy/docker/tests/telephony/sip-register.ts deploy/docker/tests/telephony/sip-ua.ts | head
```

- [ ] **Step 2: Add the expiry test**

In `kamailio-edge.e2e.ts`, after the existing register/refuse test:

```ts
test('the granted registration expiry respects the server cap', async () => {
  // The desktop shell requests 600 s (clamped from any larger value client-
  // side; registrar.ts:39 caps server-side at REGISTRATION_MAX_EXPIRY_SECONDS).
  // Request a deliberately larger expiry and assert the granted Contact
  // expires parameter never exceeds 600 — and that a 600 request grants 600.
  const over = await registerThroughEdge({ requestedExpiry: 3600 })
  expect(over.grantedExpiry).toBeLessThanOrEqual(600)
  const at = await registerThroughEdge({ requestedExpiry: 600 })
  expect(at.grantedExpiry).toBe(600)
})
```

`registerThroughEdge` is the existing helper — extend it to accept `requestedExpiry` and to parse the granted expiry off the 200 OK's Contact header rather than asserting only the status code.

- [ ] **Step 3: Run the socket suite**

```bash
deploy/docker/tests/telephony/run-register-e2e.sh
```

Expected: all tests pass, including the two new expiry assertions. If the granted expiry is NOT capped, that is a server finding — report it on the PR; do not weaken the assertion.

- [ ] **Step 4: Commit**

```bash
git add deploy/docker/tests/telephony/kamailio-edge.e2e.ts deploy/docker/tests/telephony/sip-register.ts
git commit -m "test(telephony): assert the edge caps granted REGISTER expiry at 600s (#1770)"
```

---

### Task 13: Docs — PROTOCOL.md sip-token section + Tier 4 release checklist

Spec §10 requires the credential endpoint every platform depends on to stop being undocumented; spec §8 Tier 4 needs its checklist to exist before the first release that ships desktop audio.

**Files:**
- Modify: `docs/protocol/PROTOCOL.md`
- Create: `docs/release/desktop-voice-tier4.md`

- [ ] **Step 1: Document `/api/telephony/sip-token`**

Add a section to `docs/protocol/PROTOCOL.md` (place it with the other telephony endpoints; match the file's existing endpoint-section format):

```markdown
### GET /api/telephony/sip-token

Issues the per-volunteer SIP identity for in-app calling (self-hosted Asterisk
provider only — every other vendor is refused). Auth: device session token.

Response 200 (`sipTokenResponseSchema`, packages/protocol/schemas/webrtc.ts):

    {
      "provider": "asterisk",
      "sip": {
        "domain": "<sip edge domain>",
        "transport": "tls",
        "username": "vol_<pubkey16>",
        "password": "<per-endpoint HMAC-derived secret>",
        "iceServers": [{ "urls": ["stun:…","turn:…"], "username": "…", "credential": "…" }],
        "mediaEncryption": "dtls-srtp",
        "tlsTrustAnchorPem": "-----BEGIN CERTIFICATE-----…" // optional
      }
    }

Semantics:
- The identity is per-volunteer, not per-hub; one registration carries calls
  for every hub the volunteer is on shift for.
- TURN credentials are RFC 8489 time-limited (TTL 3600 s); clients re-fetch at
  ~80% of TTL. Re-fetch is idempotent within a revocation epoch.
- Errors: 400 phone-only preference; 403 no hub membership / revoked;
  503 registrar unreachable (the server refuses to issue a dead credential).
- Clients must honour only `transport: tls` and `mediaEncryption: dtls-srtp`;
  anything else is a server misconfiguration to surface, not follow.
- `tlsTrustAnchorPem` absent means "verify against the device trust store";
  it never means "do not verify".
```

No operator detail — no real hosts, IPs, or provider names beyond what the repo already publishes.

- [ ] **Step 2: Write the Tier 4 checklist**

`docs/release/desktop-voice-tier4.md`:

```markdown
# Desktop voice — Tier 4 release checklist

Tier 4 is not automatable in CI (spec §8): NAT behaviour from real residential
routers, audio quality under load, and OS audio hot-plug quirks exist only on
deployed targets. Complete this checklist per release that ships desktop
audio; sign and date each line.

For EACH of Linux, macOS, Windows, on the release candidate build:

- [ ] Clock in on a hub; registration badge shows active within 10 s.
- [ ] One answered five-minute two-way call on residential broadband — both
      directions audible throughout.
- [ ] One answered call on a UDP-blocked network (relay path) — call connects
      and stays up for five minutes (proves coturn relay end-to-end).
- [ ] Unplug/replug the audio device mid-call; recovery or a visible error —
      never silent audio.
- [ ] Lock the app mid-shift; registration drops; the phone leg still rings
      (routing fails open).
- [ ] Clock out of the last hub; the PBX shows the contact gone within one
      registration window (≤600 s + 60 s qualify).

Signed: ____________  Date: ____  Build: ____
```

- [ ] **Step 3: Commit**

```bash
git add docs/protocol/PROTOCOL.md docs/release/desktop-voice-tier4.md
git commit -m "docs: document /api/telephony/sip-token; Tier 4 desktop voice checklist (#1770)"
```

---

## What remains unproven at M1 (spec §8, carried verbatim)

- **SFrame** — unbound by decision (spec §4); nothing to prove.
- **Relay demand and quality on real networks** — measurable only in production; ICE candidate-type telemetry is capacity work, not this plan.
- **Transcoding CPU at concurrency** on the target PBX hardware — assumed, not measured.
- **Multi-device behaviour** — `max_contacts=1` means two devices evict each other's binding; deferred deliberately for the single-device pilot (spec §9.3), not silently shipped as correct.
- **Interop with hub providers other than our own Asterisk** — the #1203 gate is inherited, neither widened nor narrowed.

## Follow-ups explicitly NOT in this plan

- Removal of the `initWebRtc` honest-`unsupported` shim and the `webrtc-token` route (spec §9.6) — touches code owned outside this feature.
- The `sipTokenResponseSchema`'s continued admission of `tcp`/`udp` transports — desktop rejects them client-side; tightening the schema is a protocol change with mobile blast radius.
