# iOS distribution: what can actually be installed

**Status: TestFlight is the decided distribution path** (operator decision). This
document states what this repo is configured to do, what that means for a person
holding a downloaded iOS build, and the alternatives that were considered. CI never
submits to a store: it produces a local IPA and the operator uploads it with fastlane
from the Mac.

Every claim is tagged where it matters:

- **Verified (repo)** — read from a file in this repository at the commit this
  document was written against.
- **Verified (Mac)** — observed on the Mac mini (`ssh mac`) on 2026-09-25.
- **Apple-published** — a limit Apple documents; not something this repo can
  demonstrate. Re-check it in App Store Connect / the developer portal before
  relying on it, because Apple changes these numbers.
- **Unverified** — could not be checked without secrets, a device, or a network
  path that was not available. Called out so nobody mistakes it for a fact.

---

## The short answer

> **Can a user download the iOS build and install it?**
> **No — not the build this repo is configured to produce.**

`apps/ios/ExportOptions.plist` sets `method = app-store-connect`. An IPA exported
with that method is signed with an **App Store distribution** profile. iOS will
only run such a binary if it arrived through the App Store or TestFlight. There is
no APK-style sideloading on iOS: double-clicking, AirDropping, or "Open in" an
`app-store-connect` IPA does not install it. The provisioning profile that
authorises it carries no device list at all (see below), so no device is entitled
to run it outside Apple's distribution channels.

**A published `v<version>-ios` release asset does not by itself mean a user can install it.**
The release exists so the exported IPA is a verifiable, downloadable *artifact*
(release-artifacts-only policy) — not because that IPA is installable:

- **Verified (repo):** `mobile-release.yml` now publishes `v<version>-ios` (titled
  `<version> iOS`; tags were `ios-v<version>` before the version-first scheme) containing
  the exported IPA, its `.sha256` and `ios-build-meta.json`, created as a draft and
  published only after the asset set is verified (same flow as `v<version>-android`).
  The dSYMs remain a 30-day *workflow artifact* (`ios-release`) for symbolication.
  This is **not yet exercised**: the iOS job cannot run until the signing secrets exist.
- **Verified (repo, `gh release list`, as of v0.19.16, before this change):** the
  releases were `v0.19.16`, `android-v0.19.16` and `desktop-v0.19.16` — **no `ios-v*`
  release** had ever been published. `android-v0.19.16` carries `app-release.apk`,
  `app-release.apk.sha256`, `android-build-meta.json` — Android is installable from a
  download; iOS is not.
- **With `method = app-store-connect`** (the current setting) the IPA in that release is
  only *submittable* to App Store Connect (locally, with fastlane). Attaching it to a
  GitHub release does not make it installable. Whether *any* downloaded IPA is
  installable is the pending method decision below — not settled by this change.
- **Verified (repo):** the iOS job cannot currently succeed. It stops at
  "Require iOS signing credentials" unless the secrets below exist, and none of them do.

Contrast with Android, where a signed `app-release.apk` on the `v<version>-android`
release installs on any device that allows unknown-source installs.

---

## What the repo is configured to do today

### Signing configuration (Verified)

| Item | Value | Source |
|---|---|---|
| Bundle ID | `org.llamenos.hotline` | `apps/ios/project.yml` |
| Team ID | `KN6NH935ZU` | `project.yml`, `ExportOptions.plist`, `fastlane/Appfile`, `fastlane/Matchfile` |
| Export method | `app-store-connect` | `apps/ios/ExportOptions.plist` |
| Export destination | `export` (local IPA; was `upload`) | `apps/ios/ExportOptions.plist` |
| Signing style at export | `manual` | `apps/ios/ExportOptions.plist` |
| Profile name the export asks for | `org.llamenos.hotline AppStore` (the profile's internal `Name`) | `ExportOptions.plist`, `fastlane/Fastfile` |
| Push entitlement | Debug `development`, Release `production` | `Sources/App/Llamenos.{Debug,Release}.entitlements` |

### The Apple account is active (Verified, Mac)

`security find-identity -v -p codesigning` on the Mac shows two valid identities:

```
Apple Development: Richard Schulte (6SAFC2RF3X)
Apple Distribution: Richard Schulte (KN6NH935ZU)
```

A `KN6NH935ZU` distribution certificate is present, i.e. the developer-program
membership exists and works. **Issue #745's claim that the account is not active is
stale**; #745 is really about getting this existing material into CI secrets.

The Mac also holds `~/Library/MobileDevice/Provisioning Profiles/match AppStore
org.llamenos.hotline.mobileprovision`, which expires **2027-05-02**. It is an
**App Store** profile: no `ProvisionedDevices` key, `get-task-allow = false`,
`aps-environment = production`, application identifier
`KN6NH935ZU.org.llamenos.hotline`. It therefore cannot install on any device
directly — consistent with the short answer above.

### Known defects in the current iOS export path

Two defects are now fixed. The rest are recorded; the operator has chosen
**TestFlight**, so `method = app-store-connect` stays.

**Fixed**

1. ~~**Profile name mismatch**~~ — **Fixed (unexercised).** The profile *file* is named
   `match AppStore org.llamenos.hotline.mobileprovision` but its **internal `Name`** is
   `org.llamenos.hotline AppStore` (Verified, Mac), and `xcodebuild -exportArchive`
   resolves `provisioningProfiles` by internal `Name`. `ExportOptions.plist` and
   `fastlane/Fastfile` now both reference `org.llamenos.hotline AppStore`. Chosen over
   regenerating via `fastlane match` (which names profiles `match AppStore <id>`)
   because regenerating needs Apple portal access and rotates a profile in use.
   Caveat: if the profile is ever regenerated by `match`, these two references must
   change back. Not yet run — needs the Mac with the profile installed.
2. ~~**`destination = upload` conflicted with the "CI never submits" policy**~~ —
   **Fixed.** Per #969 CI builds and publishes artifacts and never uploads to a store.
   With `method = app-store-connect`, `destination = upload` makes
   `xcodebuild -exportArchive` upload straight to App Store Connect and, as Apple
   documents it, leave no `.ipa` in the export path. `ExportOptions.plist` now sets
   `destination = export` (correct under `app-store-connect`, `ad-hoc` and `enterprise`
   alike). The export step also fails if it does not produce exactly one `.ipa`.
   *Not exercised end to end* — it needs the signing secrets.
3. ~~**No `ios-v*` release / IPA only in a 30-day artifact**~~ — **Fixed.** The IPA and
   its SHA-256 are attached to a draft-first `v<version>-ios` release alongside
   `ios-build-meta.json`. `mobile-release.yml` no longer contains `xcrun altool` or any
   `APPLE_API_KEY*` wiring.

**Still open**

1. **Archive step has no explicit profile/identity (Unverified).** The archive step
   passes `CODE_SIGN_STYLE=Manual` and `DEVELOPMENT_TEAM` but no
   `PROVISIONING_PROFILE_SPECIFIER` or `CODE_SIGN_IDENTITY`. Whether Xcode resolves
   these from the installed profile is not something that can be confirmed without
   running it with the secrets.
3. **`APPLE_API_KEY_*` secrets are not used by the build.** (Verified, repo.)
   `mobile-release.yml` does not read them. They are read by
   `verify-release-live.yml`, which compares the recorded build number against the
   **live TestFlight** build number. That verifier only makes sense if the chosen
   path is TestFlight (see recommendation).
4. **The IPA is not installable from the release page.** See the short answer: with
   `method = app-store-connect` it is only submittable. This is the method decision.

### Missing secrets (Verified per the task brief; not re-checked with `gh secret list`)

`IOS_CERTIFICATE_BASE64`, `IOS_CERTIFICATE_PASSWORD`,
`IOS_PROVISIONING_PROFILE_BASE64`, `APPLE_TEAM_ID`, `APPLE_API_KEY_BASE64`,
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`.

`mobile-release.yml` **fails honestly** without them: the `| xcpretty || true` that
used to turn `** ARCHIVE FAILED **` into a green job was removed, the job checks the
four signing secrets up front, and it only writes `v<version>-ios` after archive and
export both succeeded.

---

## The options

Three ways to get a build onto an iOS device. They differ in *who can install*,
*what Apple review is involved*, and *which secrets/profile the pipeline needs*.

### Option A — TestFlight

Distribution goes through Apple's TestFlight app; nobody handles an IPA directly.

**Requirements**

- An **App Store Connect app record** for `org.llamenos.hotline`. *Unverified* —
  whether one exists cannot be seen from this repo. Check App Store Connect.
- The IPA exported with `method = app-store-connect` (what the repo already has),
  fixed per open defect 1 above, and uploaded to App Store Connect. Per #969 that
  upload is done **locally**, with the existing `fastlane beta` lane
  (`apps/ios/fastlane/Fastfile`; needs `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY`, plus
  `MATCH_GIT_URL` for the `match` certificates step), not by CI.
- The App Store Connect API key (`APPLE_API_KEY_BASE64` / `_ID` / `APPLE_API_ISSUER_ID`)
  if the CI verifier `verify-release-live.yml` is to keep checking the live
  TestFlight build number.
- Testers install the **TestFlight** app from the App Store and accept an invite.

**Limits (Apple-published)**

| | Internal testing | External testing |
|---|---|---|
| Testers | up to 100 | up to 10,000 |
| Who | people **added to the App Store Connect team** (a role each) | anyone with an email / public link |
| Apple review | none | Beta App Review for the first build of each version |
| Device UDIDs | not needed | not needed |
| Build lifetime | 90 days | 90 days |

**What it costs the operator**

- Each internal tester becomes an App Store Connect user of the organisation's
  Apple account (with a limited role). For an app whose threat model includes
  adversaries who would like the volunteer list, that is a real consideration: every
  tester's Apple ID is known to the account holder and to Apple.
- The build is not a GitHub-release download. "Downloadable" becomes "installable
  from an invite".
- External testing means Apple reviews the app and its metadata.

### Option B — Ad Hoc

An IPA signed with an **Ad Hoc** profile that lists specific device UDIDs. This is
the only option that is genuinely "download a file and install it" — but only for
pre-registered devices.

**Requirements**

- `ExportOptions.plist` with `method = ad-hoc` (`destination = export` is already set).
  **`method` is not changed by this PR.** Switching changes which secrets and profile are needed.
- A new **Ad Hoc provisioning profile** for `org.llamenos.hotline`, generated in the
  developer portal, with each tester device's UDID registered. The existing App Store
  profile cannot be reused (it has no device list — Verified, Mac).
- An Apple Distribution certificate (the Mac already has one) in the CI keychain, i.e.
  `IOS_CERTIFICATE_BASE64` / `IOS_CERTIFICATE_PASSWORD` and
  `IOS_PROVISIONING_PROFILE_BASE64` (now holding the Ad Hoc profile) and
  `APPLE_TEAM_ID`. The `APPLE_API_KEY_*` trio would not be needed for the build.
- An installation route: Apple Configurator / Finder (drag the IPA), or **over the
  air** with an `itms-services://?action=download-manifest&url=<https url of
  manifest.plist>` link. OTA needs a `manifest.plist` (bundle id, version, IPA URL)
  and both files served over **HTTPS with a certificate the device trusts**.
  *Unverified:* whether GitHub release-asset URLs (which redirect to a CDN host) work as
  the IPA/manifest URL for `itms-services`; the safe assumption is to host them on a
  server we control. GitHub-release hosting also collides with immutable releases —
  the IPA would have to be attached before the release is published.

**Limits (Apple-published)**

- **100 devices** per device family (iPhone, iPad, …) per membership year. Removing a
  device frees a slot only at the annual membership renewal.
- **Every new tester device requires**: add the UDID → regenerate the profile →
  **re-export and redistribute the IPA**. Existing testers must reinstall.
- Ad Hoc profiles expire after one year; testers' installs stop launching then.
- Testers must be able to give you a UDID (Finder/Apple Configurator, or a
  UDID-collecting service — the latter leaks device identifiers to a third party).

### Option C — Local build to a device from Xcode

The developer (or a tester with a Mac) builds from a checkout and installs to a
cable-connected device. See `docs/deployment/local-mobile-deployment.md` for the
commands.

**Requirements**

- A Mac with Xcode signed into the team, with the **Apple Development** identity
  (Verified present on the Mac: `Apple Development: Richard Schulte (6SAFC2RF3X)`).
  `project.yml` already sets `DEVELOPMENT_TEAM: KN6NH935ZU` and
  `CODE_SIGN_STYLE: Automatic`, so no CI secrets and no profile files are needed.
- The device plugged into that Mac. Xcode can register the device to the team
  automatically (`-allowProvisioningUpdates -allowProvisioningDeviceRegistration`).
- No App Store Connect record, no API key, no review.

**Limits**

- Development-signed builds: profile lifetime 1 year for a paid team (Apple-published);
  the app must be re-installed when it expires.
- A person, not a pipeline, does each install. Doesn't scale to a "download and
  install" workflow; it is a *developer* path.
- **Unverified end-to-end on the Mac mini.** On 2026-09-25 `xcrun devicectl list
  devices` on the Mac returned "Timed out waiting for CoreDeviceService to fully
  initialize", and `xcrun simctl` prints "Install Failed: Authorization is required to
  install the packages" — the Xcode 26.6 / CoreSimulator package mismatch recorded by
  earlier workers. So installing to a device *from the Mac mini over SSH* is likely
  blocked until that host issue is fixed (needs an admin/sudo action). The same
  commands on a developer's own Mac with Xcode are unaffected by this host issue.

---

## Side-by-side

| | TestFlight | Ad Hoc | Local Xcode |
|---|---|---|---|
| Installable by "download and open" | No (invite + TestFlight app) | Yes, but only registered devices | No (needs Mac + cable) |
| Tester count | ≤100 internal, ≤10,000 external | ≤100 devices | the developers |
| Device UDID registration | No | **Yes, per device** | Only the developer's own |
| Apple review | None internal; Beta App Review external | None | None |
| Re-export when testers change | No | **Yes, every time** | n/a |
| `method` in ExportOptions | `app-store-connect` (current) | `ad-hoc` (change) | n/a (Xcode) |
| Secrets in CI | cert, profile, team; ASC key only for verifier | cert, ad-hoc profile, team | none |
| Works today | No — needs secrets, app record, fix open defect 1 | No — needs new profile + secrets | Partially — identity exists; Mac-mini host issue unresolved |
| Fits #969 (CI builds, local submits) | Yes — `fastlane beta` locally | Yes — IPA is the artifact | Yes |

---

## Decision and rationale

**Decided: TestFlight** (recommendation adopted by the operator). Use TestFlight internal testing for the internal beta, and keep Local Xcode as the
developer path. Do not choose Ad Hoc unless testers cannot be added to the Apple
team.**

Reasoning:

1. **It is the smallest change from what already exists.** `method =
   app-store-connect`, the App Store profile (valid to 2027-05-02), the Distribution
   identity, the `fastlane beta` lane, `verify-release-live.yml`'s TestFlight
   build-number check, and #969's "submission is local" policy all already assume
   TestFlight. Ad Hoc discards the profile and the verifier and needs a new profile
   generation flow.
2. **No UDID treadmill.** Ad Hoc means collecting a UDID from every tester and
   re-exporting the IPA for each new one. For a beta whose tester list will keep
   changing, that is recurring manual work with a 100-device ceiling.
3. **Updates are pushed.** TestFlight delivers new builds to testers; an Ad Hoc IPA
   requires each tester to be re-sent and reinstall it by hand.
4. **Internal testing needs no Apple review** and is available as soon as the
   build is processed.

Trade-offs to accept knowingly:

- The operator must **create the App Store Connect app record** (cannot confirm it
  exists from this repo) and add each tester as an internal user. That means each
  tester's Apple ID is visible to the Apple account owner — weigh this against the
  project's identity-protection posture. If that is unacceptable, Ad Hoc keeps the
  tester list off the Apple account, at the price of registering their device UDIDs
  with it instead. Neither option is anonymous toward Apple.
- "Download from the release page" is not achievable for iOS via TestFlight. The
  honest user-facing statement is "accept the TestFlight invite".

### Remaining before an IPA reaches TestFlight

The operator has chosen **TestFlight**, so `method = app-store-connect` is settled.
Defects 1 and 2 are fixed. What remains:

1. Confirm or create the App Store Connect app record for `org.llamenos.hotline`, and
   add internal testers.
2. Populate the signing secrets (#745) — or drop the `APPLE_API_KEY_*` trio and the
   `verify-release-live.yml` verifier if TestFlight uploads are only ever done locally.
3. Run the export on the Mac with the profile installed, to exercise the defect-1 fix
   end to end, then upload with `fastlane beta`.

A downloaded IPA is still **not** user-installable: testers install through the
TestFlight app after accepting an invite. Docs, release notes and tester guides must
not imply otherwise.
