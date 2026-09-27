# Installing the mobile clients from a local checkout

How a developer or tester gets the Android and iOS apps onto a device or emulator
without any store, server-side pipeline, or new credential.

Every command below was checked against `package.json`, `scripts/`,
`apps/*/README.md`, the build files, and `.github/workflows/mobile-release.yml`.
Where something could **not** be verified (no attached device, host issue, no
secret) it is labelled **Unverified** instead of guessed. Names that look like
plausible scripts but do not exist are called out in [Corrections](#corrections-to-existing-docs).

For *which iOS build can be handed to testers at all*, read
[`ios-distribution.md`](./ios-distribution.md) first — a locally built iOS app is a
developer path, not a distribution path.

---

## What both clients need

### A backend to point at

Neither app has a baked-in server. On first launch the user types a **hub URL**
(`LoginView`, `login_hub_url_label` on iOS; `LoginScreen` on Android).

- **HTTPS is enforced.** iOS `APIService.configure(hubURLString:)` rejects
  `http://` unless the string contains `localhost` or `127.0.0.1`, and prepends
  `https://` if no scheme is given. `NSAllowsArbitraryLoads` is `false`. Android's
  release `network_security_config.xml` is HTTPS-only (`cleartextTrafficPermitted="false"`).
- **Android debug builds only** additionally permit cleartext to `localhost`,
  `10.0.2.2` (emulator host loopback) and one hard-coded LAN address
  (`192.168.50.95`) — `apps/android/app/src/debug/res/xml/network_security_config.xml`.
  The published release APK cannot talk to a plain-HTTP backend at all.
- **Local backend** (for a developer on the same machine): from the repo root,
  `docker compose -f deploy/docker/docker-compose.dev.yml up -d` then
  `bun run dev:server`; check `curl -sf http://localhost:3000/api/health/ready`.
  Reachable only from an Android **emulator** (as `http://10.0.2.2:3000`) or an iOS
  **simulator** (`http://localhost:3000`); a physical phone cannot reach your
  `localhost`, and the iOS/Android release configs refuse plain HTTP to anything else.
- **A real device needs an HTTPS backend.** The staging/demo deployment is described
  in `docs/deploy/staging.md`. **Unverified:** this document did not confirm a
  staging host is currently up; the operator must supply the URL.
- Android certificate pins in the release config cover `llamenos.org` (ISRG Root
  X1/X2, `pin-set expiration="2027-01-01"`); self-hosters must edit the domain and
  pins (see the comment in `network_security_config.xml`).

### Codegen (gitignored output)

Generated protocol types and i18n strings are not committed. After a fresh clone
(and after schema/locale changes):

```bash
bun install
bun run codegen          # Zod → Swift/Kotlin/TS types (packages/protocol/generated/)
bun run i18n:codegen     # iOS .strings + Android strings.xml
```

### Android push needs the ntfy relay — otherwise the app installs but never rings

Android incoming-call wake-ups go over **UnifiedPush through a self-hosted ntfy
relay**; there is deliberately no FCM (`deploy/PUSH_NOTIFICATIONS.md`). Consequences
for anyone installing the app:

1. **The backend must run the relay and have it configured.** The worker only logs
   "Android push notifications disabled" and silently skips push if `NTFY_URL` is
   absent (`apps/worker/lib/config.ts`); when `NTFY_URL` is an internal address
   (e.g. `http://ntfy:80`), **`NTFY_PUBLIC_URL` must also be set** to the
   device-facing address, or the backend will reject the device's UnifiedPush endpoint
   (`apps/worker/lib/ntfy-origin.ts`, #960/#963). The relay is off by default in the
   deploy paths (#964 — open at time of writing) and the staging playbook refuses to
   deploy without `llamenos_ntfy_enabled` and an `ntfy_domain`
   (`deploy/PUSH_NOTIFICATIONS.md`, #959).
2. **The phone needs the ntfy app** as the UnifiedPush distributor, with its default
   server set to *our* relay (not `ntfy.sh`). Steps are in `deploy/PUSH_NOTIFICATIONS.md`
   → "Tester setup".
3. **Client registration is not implemented yet.** #955 (open at time of writing)
   records that nothing in the Android app registers with a UnifiedPush distributor —
   `PushService` only receives callbacks that are never triggered — and a search of
   `apps/android/app/src/main` finds no registration call. So even with a correct
   backend and relay, **do not expect incoming-call push on Android until #955 lands.**
   State this to testers rather than have them file "app never rings" as a new bug.

Push on **iOS** uses APNs: the worker warns "iOS push notifications disabled" without
`APNS_KEY_P8`, `APNS_KEY_ID`, `APNS_TEAM_ID` (`apps/worker/lib/config.ts`). A
development-signed local iOS build receives push only via the `development` APNs
environment (`Llamenos.Debug.entitlements`); whether the backend's APNs key targets
that environment was **not verified**.

---

## Android

### Zero-build path: the published, signed APK

`mobile-release.yml` publishes a signed APK to the dedicated `android-v<version>`
release (for example `android-v0.19.16`; assets `app-release.apk`,
`app-release.apk.sha256`, `android-build-meta.json` — verified with
`gh release view android-v0.19.16`).

```bash
gh release download android-v0.19.16 --repo Llamenos-Hotline/llamenos-platform \
  --pattern 'app-release.apk*'
sha256sum -c app-release.apk.sha256       # the .sha256 records the bare file name
adb install app-release.apk               # or open the file on the phone
```

- The release workflow verifies the APK is signed and contains **only** the production
  native libs (arm64-v8a + armeabi-v7a; fails if any x86/x86_64 lib is present), so
  this is the safe artifact to hand to a tester. It needs an ARM device — it will not
  run on an x86_64 emulator.
- It is HTTPS-only (see above) and needs a backend with a valid certificate.
- `adb install` requires developer mode + USB debugging on the phone; sideloading by
  opening the file requires allowing installs from that source. Both are standard
  Android settings, not repo behaviour.

### Building from source

**Prerequisites:** JDK 17, Android SDK, Rust + `cargo`, **`cargo-ndk`**
(`cargo install cargo-ndk --locked` — `build-mobile.sh android` exits with an error
telling you so if it is missing), and an Android NDK (auto-detected from
`ANDROID_NDK_HOME`, `~/Android/Sdk/ndk`, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, …).
SDK bootstrap script: `bun run android:sdk:setup`.

**1. Build the native crypto libraries** (the jniLibs prerequisite):

```bash
cd packages/crypto
./scripts/build-mobile.sh android
```

This produces two variants:

| Variant | Location | Crypto params | ABIs |
|---|---|---|---|
| debug | `dist/android/jniLibs-debug/` | **test-kdf** (1 MB / 1 iter / 1 lane — deliberately weak, for emulator tests) | `x86_64` only |
| release | `dist/android/jniLibs-release/` | production Argon2id (64 MB / 3 iter / 4 lanes) | `arm64-v8a`, `armeabi-v7a` |

**2. Copy into the Gradle build-type source sets** (both dirs are gitignored, so create them):

```bash
mkdir -p ../../apps/android/app/src/debug/jniLibs ../../apps/android/app/src/release/jniLibs
cp -r dist/android/jniLibs-debug/*   ../../apps/android/app/src/debug/jniLibs/
cp -r dist/android/jniLibs-release/* ../../apps/android/app/src/release/jniLibs/
```

(This is the layout `apps/android/README.md` documents. CI copies **only** the release
variant into a release build and fails if a `src/debug/jniLibs` exists.)

**3. Build and install** (from `apps/android/`):

```bash
./gradlew assembleDebug      # → debug APK, applicationId org.llamenos.hotline.debug
./gradlew assembleRelease    # → release APK, applicationId org.llamenos.hotline
adb devices                  # confirm the target is listed
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`assembleDebug` and `assembleRelease` are the Gradle tasks the README and
`mobile-release.yml` use. **Output path caveat:** on **Linux**, `app/build.gradle.kts`
moves the Gradle build directory out of the checkout — to
`$RUNNER_TEMP/llamenos-android-build-<hash>/app` or, without `RUNNER_TEMP`,
`/tmp/llamenos-android-build-<hash>/app` (`<hash>` is derived from the checkout path) —
unless `ANDROID_BUILD_DIR` is set. So on Linux the APK is **not** under
`apps/android/app/build/outputs/`. Either look under that `/tmp` directory
(`find /tmp/llamenos-android-build-* -name '*.apk'`) or pin the location:
`ANDROID_BUILD_DIR="$PWD/app/build" ./gradlew assembleRelease` (what CI does). On macOS
the default `app/build/` is used.

### Do not put a tester on the test-kdf build

The debug variant exists to make emulator tests fast, at the cost of a KDF that is
**intentionally weak**. Facts from the build files:

- Debug native libs are **x86_64 only** and the debug build type filters ABIs to
  `x86_64`, so a debug APK does not run on an ARM phone; it is an emulator artifact.
- The debug application id is `org.llamenos.hotline.debug` (the release id is
  `org.llamenos.hotline`); the two install side by side. The `.debug` suffix is the
  quickest way to tell which one is on a device.
- The Rust build refuses to compile the `test-kdf` feature into a non-`debug_assertions`
  profile (`--release`), which is why the debug libs use the `emulator` Cargo profile.
- **Rule of thumb:** anything handed to a person who will enter a real PIN or real hub
  data is `assembleRelease` (or the published `app-release.apk`), never `assembleDebug`.
  If `adb shell pm list packages | grep llamenos` shows `org.llamenos.hotline.debug`,
  that device is on the test build.

### Local release signing

`assembleRelease` signs only if credentials resolve from
`apps/android/keystore.properties` (copy `keystore.properties.example`) or the
`KEYSTORE_PATH` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD` environment
variables. **Without them Gradle silently produces an *unsigned* release APK, which
Android will not install** (the CI step "Require signing credentials" exists for
exactly this reason; the comment in `build.gradle.kts` claiming a fallback to debug
signing does not match the code, which sets no `signingConfig` in that case). Local
testers therefore either use the published signed APK, or a keystore they created —
this document does not, and must not, distribute the upload keystore.

---

## iOS

iOS builds run on a Mac. The repo's scripts wrap `ssh mac` (Mac mini M4,
`192.168.50.243`, user `rhonda`).

### How the scripts reach the Mac

`bun run ios:*` (`scripts/ios-build.sh`) and `bun run mac:run "<cmd>"`
(`scripts/mac-run.sh`) `ssh` to `MAC_SSH_HOST` (default `mac`) and `cd`
`MAC_PROJECT` (default `~/projects/llamenos`) **on the Mac**, then run there. Nothing
syncs your working tree to the Mac — the checkout on the Mac must already contain
the code you want built (the fleet uses `~/.worktrees/<branch>` on the Mac; set
`MAC_PROJECT` accordingly). Non-login SSH shells need the toolchain on `PATH`; both
scripts do this for you:

```bash
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null
export PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH"
```

### Prerequisites on the Mac

```bash
bun run ios:status        # Xcode, Rust, xcodegen, simulators
bun run ios:setup         # first time: Rust iOS targets, xcodegen, xcbeautify
bun run codegen && bun run i18n:codegen
bun run ios:xcframework   # builds LlamenosCoreFFI.xcframework and copies
                          # LlamenosCore.swift into apps/ios/Sources/Generated/
```

The XCFramework and the generated `LlamenosCore.swift` **must come from the same
build** or the app crashes at launch with a UniFFI checksum mismatch — always rebuild
both with `ios:xcframework`, never one by hand. `xcodegen generate` (run inside
`apps/ios`) is required after adding Swift files; `ios:build` runs it if no
`.xcodeproj` exists.

### Simulator (for developers)

```bash
bun run ios:build         # simulator build (auto-detects an available iPhone)
bun run ios:test          # unit tests
bun run ios:uitest        # XCUITests
```

`swift build` does **not** work for this project (UIKit); use `xcodebuild`, which the
scripts do. Set `IOS_SIMULATOR="iPhone 17"` to pin a device.

### Build to a physical device (Apple Development identity)

This is the only iOS install path that needs no secret, no App Store Connect
record, and no UDID registration beyond your own device. The project already sets
`DEVELOPMENT_TEAM: KN6NH935ZU` with `CODE_SIGN_STYLE: Automatic` (`apps/ios/project.yml`),
and the Mac has `Apple Development: Richard Schulte (6SAFC2RF3X)` (verified with
`security find-identity -v -p codesigning`).

**Unverified end to end.** No device was attached when this was written, so the
commands below are the standard `xcodebuild`/`devicectl` invocations for this project
layout, not a recorded successful install. See the host hazards below before
trusting the Mac mini for this.

```bash
cd apps/ios
xcodegen generate
xcodebuild build \
  -project Llamenos.xcodeproj -scheme Llamenos \
  -configuration Debug \
  -destination 'platform=iOS,id=<DEVICE_UDID>' \
  -derivedDataPath build/device \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration
xcrun devicectl list devices                       # find the id / confirm it is connected
xcrun devicectl device install app --device <DEVICE_UDID> \
  build/device/Build/Products/Debug-iphoneos/Llamenos.app
```

Notes:

- The device must be **physically connected to the Mac doing the build** (or paired
  over the network from it). A phone on your desk does not help if you `ssh mac` into
  a machine in another room.
- `-allowProvisioningUpdates -allowProvisioningDeviceRegistration` lets Xcode create a
  development profile and register the device to the team; the Mac needs to be signed
  into the team's Apple account in Xcode.
- Over SSH, the login keychain is locked by default, which commonly surfaces as a
  `codesign`/`errSecInternalComponent` failure; unlocking it
  (`security unlock-keychain ~/Library/Keychains/login.keychain-db`) first is the usual
  remedy. **Unverified here.**
- **Which configuration.** `Debug` matches `Llamenos.Debug.entitlements`
  (`aps-environment = development`, which a development profile permits). **Debug
  compiles in test-injection code** (`#if DEBUG` blocks in `WebSocketService`
  (`decryptionHandler` injection), `CryptoService`, `AppState`, …) — fine for your own
  device, **not something to give to a tester.** `Release` uses
  `Llamenos.Release.entitlements` with `aps-environment = production`, which a
  development profile normally does not authorise; whether Xcode's automatic signing
  rewrites it for a dev-signed build was **not verified**. Hardening for testers is
  the job of a TestFlight/Ad Hoc build, not this path.
- The app expires with the development profile (1 year for a paid team, Apple-published).
- The UITesting configuration (`ios:uitest`) compiles `UI_TESTING` mock-identity hooks
  and is for the simulator only; never install it on a device someone will really use.

### Known Mac-mini environment hazards

Recorded by previous workers on this fleet. The first two were corroborated by a probe
on 2026-09-25 as noted.

1. **`github.com` can be unresolvable from the Mac's default resolver.** Symptoms:
   `swift package resolve` / `git clone` / `xcodebuild -resolvePackageDependencies` fail
   to reach GitHub. A **session-scoped** `GIT_SSH_COMMAND` override worked for the
   previous worker. The exact override that worked was not recorded, so none is
   pasted here — do not invent one; scope any override to the shell/session, do
   not write it into global git config, and note what you used. (Not independently reproduced in this write-up: a combined probe that included a
   name-resolution check timed out, but the resolver was not isolated as the cause.)
2. **CoreSimulator / Xcode 26.6 mismatch blocks local simulator builds, and there is no
   `sudo`.** Corroborated: every `xcrun simctl …` call on the Mac prints
   `Install Started` / `Install Failed: Authorization is required to install the
   packages.` before its normal output, and an `iOS 26.2` runtime is listed under
   Xcode 26.6 (`17F113`). `xcrun devicectl list devices` additionally returned
   `Timed out waiting for CoreDeviceService to fully initialize`. Fixing it needs an
   administrator on the Mac (the package install is what asked for authorization).
   **Consequence for this guide:** simulator *and* device installs driven from
   `ssh mac` may be blocked until that is fixed; a developer's own Mac with Xcode is
   the reliable alternative.
3. **No CI substitute.** The `ios-v<version>` release is metadata-only and the
   iOS release job cannot run without the signing secrets — see
   [`ios-distribution.md`](./ios-distribution.md). There is no downloadable iOS artifact
   to fall back to, unlike Android.

---

## Corrections to existing docs

Found while verifying commands; **not** fixed in this PR (the Android files are outside this
PR's owned paths, and the iOS README point is cosmetic):

- `apps/android/README.md` says `bun run setup:android`. **No such script exists** in
  `package.json`; the real one is `bun run android:sdk:setup`
  (`scripts/setup-android-sdk.sh`).
- `apps/ios/README.md` says iOS commands run "via `bun run mac:run`"; the `ios:*`
  scripts actually `ssh` directly (`scripts/ios-build.sh`); `mac:run` is the
  generic wrapper. The commands listed are correct.
- The comment in `apps/android/app/build.gradle.kts` says a release build "falls back to
  debug signing"; the code leaves it unsigned. See [Local release signing](#local-release-signing).

## Quick reference

| I want to… | Do this |
|---|---|
| Try Android with no build | `gh release download android-v<ver> --pattern 'app-release.apk*'`, verify sha256, `adb install` |
| Build Android for an ARM phone | jniLibs (both variants) → `./gradlew assembleRelease` with a keystore |
| Build Android for the emulator | jniLibs (debug) → `./gradlew assembleDebug` → `adb install` (never for testers) |
| Run the iOS simulator build | `bun run ios:xcframework && bun run ios:build` |
| Put iOS on my own iPhone | Debug `xcodebuild` to `platform=iOS,id=<UDID>` (see above; unverified end to end) |
| Get iOS to a tester | Not possible from this repo today — see `ios-distribution.md` |
| Get Android push working | Backend `NTFY_URL` + `NTFY_PUBLIC_URL`, ntfy app on the phone, and #955 (client registration) |
