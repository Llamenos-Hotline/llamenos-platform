# Human Operator Setup Guide

**Epic 99 -- Manual prerequisites before desktop releases can ship.**

This document covers every manual step a human must complete before the automated
CI/CD pipelines (`ci.yml`, `tauri-release.yml`, `docker.yml`) can produce signed,
notarized, distributable release artifacts. Automated processes reference these
secrets and accounts; without them, builds will fail or produce unsigned binaries
that operating systems will block.

---

## Table of Contents

1. [Tauri Updater Signing Keypair](#1-tauri-updater-signing-keypair)
2. [Apple Developer Account (macOS)](#2-apple-developer-account-macos-code-signing--notarization)
3. [Windows Code Signing](#3-windows-code-signing)
4. [Flathub Submission (Linux)](#4-flathub-submission-linux)
5. [F-Droid Submission (future -- mobile)](#5-f-droid-submission-future----mobile)
6. [Google Play Store (future -- mobile)](#6-google-play-store-future----mobile)
7. [GitHub Repository Secrets Checklist](#7-github-repository-secrets-checklist)
8. [Version Sync Checklist](#8-version-sync-checklist)
9. [Mobile: Google Play Console Setup](#9-mobile-google-play-console-setup)
10. [Mobile: Apple Developer Account for iOS](#10-mobile-apple-developer-account-for-ios)
11. [Mobile: F-Droid Submission](#11-mobile-f-droid-submission)
12. [Mobile: Push Notification Certificates](#12-mobile-push-notification-certificates)

---

## 1. Tauri Updater Signing Keypair

The Tauri updater uses Ed25519 signatures to verify that downloaded updates are
authentic. Every release artifact (`.app.tar.gz`, `.nsis.zip`, `.AppImage`) gets
a `.sig` sidecar file. The desktop app checks signatures against the public key
embedded in `apps/desktop/tauri.conf.json` before applying updates.

**This is the single most critical secret.** If the private key is compromised,
an attacker can push malicious updates to every installed desktop client.

### Generate the keypair

Run this once on a secure, air-gapped machine if possible:

```bash
bunx @tauri-apps/cli signer generate -w ~/.tauri/llamenos.key
```

This outputs:
- **Private key file**: `~/.tauri/llamenos.key` (encrypted with the password you
  provide during generation)
- **Public key string**: printed to stdout (a base64-encoded Ed25519 public key)

Copy the public key string. It looks like:

```
dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ4...
```

### Store the public key in the app

Edit `apps/desktop/tauri.conf.json` and set the `plugins.updater.pubkey` field:

```jsonc
{
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEQ4...",
      "endpoints": [
        "https://github.com/Llamenos-Hotline/llamenos-platform/releases/latest/download/latest.json"
      ]
    }
  }
}
```

Commit this change. The public key is safe to embed in the source code -- it is
only used for verification, not signing.

### Store the private key in GitHub Secrets

Go to **Settings > Secrets and variables > Actions** in the GitHub repository.

| Secret Name | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | The full content of `~/.tauri/llamenos.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The password you chose during generation |

These are consumed by `tauri-release.yml` as environment variables:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

### Backup and rotation

- Store a backup of `~/.tauri/llamenos.key` and the password in a password
  manager or hardware security device (e.g., YubiKey + age encryption).
- To rotate: generate a new keypair, update `tauri.conf.json` with the new
  public key, and update both GitHub secrets. Users on the old version will
  fail to auto-update (they must manually download the new version once).
  Plan rotation carefully.

---

## 2. Apple Developer Account (macOS Code Signing + Notarization)

Without code signing, macOS Gatekeeper blocks the app with "this app is from an
unidentified developer." Without notarization, macOS Sequoia and later refuse to
open the app entirely (even with right-click > Open).

### 2.1 Enroll in the Apple Developer Program

1. Go to https://developer.apple.com/programs/
2. Sign in with the organization's Apple ID (create one if needed)
3. Enroll as an **Organization** ($99/year) -- requires a D-U-N-S number
   - If enrolling as an individual, use the project lead's Apple ID
4. Wait for enrollment approval (usually 24-48 hours)

### 2.2 Create a "Developer ID Application" certificate

This certificate type is specifically for apps distributed outside the Mac App
Store, which is the Tauri distribution model.

1. Open https://developer.apple.com/account/resources/certificates/list
2. Click the **+** button to create a new certificate
3. Select **Developer ID Application** (NOT "Mac App Distribution")
4. Follow the prompts to upload a Certificate Signing Request (CSR):
   - On a Mac, open **Keychain Access > Certificate Assistant > Request a
     Certificate From a Certificate Authority**
   - Fill in your email and select **Saved to disk**
   - Upload the `.certSigningRequest` file
5. Download the generated `.cer` file
6. Double-click the `.cer` file to install it in Keychain Access

### 2.3 Export as .p12 for CI

The GitHub Actions runner needs the certificate and private key in PKCS#12
format.

1. Open **Keychain Access**
2. In the **My Certificates** category, find your "Developer ID Application:
   Your Name (TEAMID)" certificate
3. Expand it to verify the private key is attached
4. Right-click the certificate > **Export...**
5. Choose **Personal Information Exchange (.p12)** format
6. Set a strong password (you will need this for CI)
7. Save as `Certificates.p12`

### 2.4 Base64-encode the .p12 for GitHub Secrets

```bash
base64 -i Certificates.p12 | pbcopy
```

This copies the base64 string to your clipboard. On Linux, use:

```bash
base64 -w 0 Certificates.p12 | xclip -selection clipboard
```

### 2.5 Create an App-Specific Password for notarization

Apple's notarization service requires an app-specific password (not your main
Apple ID password). This is enforced even if you have 2FA disabled.

1. Go to https://appleid.apple.com/account/manage
2. Sign in with the Apple ID enrolled in the Developer Program
3. Under **Sign-In and Security**, select **App-Specific Passwords**
4. Click **Generate an app-specific password**
5. Label it "Llamenos CI Notarization"
6. Copy the generated password (format: `xxxx-xxxx-xxxx-xxxx`)

### 2.6 Find your Team ID and Signing Identity

- **Team ID**: Go to https://developer.apple.com/account > Membership Details.
  The Team ID is a 10-character alphanumeric string (e.g., `A1B2C3D4E5`).
- **Signing Identity**: The full name of your certificate as it appears in
  Keychain Access. Typically: `Developer ID Application: Your Org Name (TEAMID)`

### 2.7 Set GitHub Secrets

| Secret Name | Value | Example |
|---|---|---|
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` file content | `MIIKYwIBAzCCCi...` |
| `APPLE_CERTIFICATE_PASSWORD` | Password used when exporting `.p12` | `my-p12-password` |
| `APPLE_SIGNING_IDENTITY` | Certificate common name | `Developer ID Application: Llamenos (A1B2C3D4E5)` |
| `APPLE_ID` | Apple ID email used for notarization | `dev@llamenos.org` |
| `APPLE_PASSWORD` | App-specific password from step 2.5 | `xxxx-xxxx-xxxx-xxxx` |
| `APPLE_TEAM_ID` | 10-character team identifier | `A1B2C3D4E5` |

These are used in `tauri-release.yml` during the macOS build:

```yaml
- name: Setup macOS signing
  env:
    APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
    APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
  run: |
    echo "$APPLE_CERTIFICATE" | base64 --decode > certificate.p12
    security create-keychain -p "" build.keychain
    security default-keychain -s build.keychain
    security unlock-keychain -p "" build.keychain
    security import certificate.p12 -k build.keychain \
      -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple:,codesign: \
      -s -k "" build.keychain
    rm certificate.p12

- name: Build (macOS universal)
  env:
    APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
    APPLE_ID: ${{ secrets.APPLE_ID }}
    APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
    APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  run: bun run tauri:build -- --target universal-apple-darwin
```

### 2.8 Certificate renewal

Apple Developer ID certificates are valid for 5 years. Set a calendar reminder
to renew before expiration. When renewing:

1. Generate a new CSR and certificate
2. Export a new `.p12`
3. Update `APPLE_CERTIFICATE` and `APPLE_CERTIFICATE_PASSWORD` secrets
4. The signing identity name typically stays the same

---

## 3. Windows Code Signing

Without code signing, Windows SmartScreen displays a warning that blocks most
users from running the app. SmartScreen reputation is built over time once you
start signing; the first few releases may still show reduced warnings.

There are three options, listed in order of recommendation:

### Option A: Azure Trusted Signing (recommended for CI)

This is Microsoft's cloud-based signing service. No hardware token required,
which makes it ideal for GitHub Actions CI. Cost is approximately $10/month.

#### 3A.1 Prerequisites

- An Azure subscription (https://portal.azure.com)
- An organization identity-validated Azure account

#### 3A.2 Set up Azure Trusted Signing

1. Go to https://portal.azure.com
2. Search for **Trusted Signing** and create a new account
3. Create a **Certificate Profile**:
   - Type: **Public Trust**
   - This requires identity validation (Microsoft verifies your organization)
4. Create an **App Registration** for CI access:
   - Go to **Azure Active Directory > App registrations > New registration**
   - Name: `llamenos-ci-signing`
   - Create a **Client Secret** under Certificates & secrets
   - Note the **Application (client) ID** and **Directory (tenant) ID**
5. Grant the app registration the **Trusted Signing Certificate Profile Signer**
   role on your Trusted Signing account

#### 3A.3 Configure Tauri for Azure Trusted Signing

Add to `apps/desktop/tauri.conf.json` under `bundle`:

```jsonc
{
  "bundle": {
    "windows": {
      "signCommand": "trusted-signing-cli sign -e https://eus.codesigning.azure.net -a YourAccountName -c YourCertProfileName %1"
    }
  }
}
```

Or configure via environment variables in the CI workflow. The Tauri build will
call the sign command for each Windows binary.

#### 3A.4 Set GitHub Secrets

| Secret Name | Value |
|---|---|
| `AZURE_TENANT_ID` | Azure AD tenant (directory) ID |
| `AZURE_CLIENT_ID` | App registration client ID |
| `AZURE_CLIENT_SECRET` | App registration client secret |

Add to the Windows build step in `tauri-release.yml`:

```yaml
- name: Build (Windows)
  if: matrix.platform == 'windows-latest'
  env:
    AZURE_TENANT_ID: ${{ secrets.AZURE_TENANT_ID }}
    AZURE_CLIENT_ID: ${{ secrets.AZURE_CLIENT_ID }}
    AZURE_CLIENT_SECRET: ${{ secrets.AZURE_CLIENT_SECRET }}
  run: bun run tauri:build
```

### Option B: EV Code Signing Certificate (traditional)

Extended Validation certificates provide the highest trust level on Windows and
immediately bypass SmartScreen. However, they require a hardware token (USB
dongle), which makes CI more complex.

#### Cost

$300-500/year from providers like DigiCert, Sectigo, or GlobalSign.

#### Setup

1. Purchase an EV code signing certificate from a trusted CA
2. The CA will ship a hardware token (SafeNet, YubiKey, or similar)
3. For CI, you must use a cloud HSM or signing service that exposes the
   hardware token remotely:
   - **DigiCert KeyLocker**: Cloud-based HSM for DigiCert certificates
   - **SignPath**: CI-integrated signing service
   - **AWS CloudHSM** or **Azure Key Vault**: Host the key in a cloud HSM

This option requires significantly more setup for CI. Azure Trusted Signing
(Option A) is recommended unless you specifically need an EV certificate.

### Option C: Self-signed (development only)

For local development testing only. Never use this for releases.

```bash
# Generate a self-signed certificate (Windows PowerShell)
New-SelfSignedCertificate -Type Custom -Subject "CN=Llamenos Dev" `
  -KeyUsage DigitalSignature -FriendlyName "Llamenos Dev Signing" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3")
```

Self-signed certificates will always trigger SmartScreen warnings.

---

## 4. Flathub Submission (Linux)

Flathub is the primary distribution channel for Linux desktop apps. Once
accepted, updates are published automatically when you push new tags.

### 4.1 Prepare the Flatpak manifest

Create `org.llamenos.Hotline.yml` in a fork of the Flathub repository. The
manifest must describe how to build the app from source.

Example structure:

```yaml
app-id: org.llamenos.Hotline
runtime: org.freedesktop.Platform
runtime-version: '24.08'
sdk: org.freedesktop.Sdk
sdk-extensions:
  - org.freedesktop.Sdk.Extension.rust-stable
  - org.freedesktop.Sdk.Extension.node20
command: hotline

finish-args:
  - --share=ipc
  - --socket=fallback-x11
  - --socket=wayland
  - --share=network
  - --device=dri
  # Audio for call handling
  - --socket=pulseaudio
  # Notifications
  - --talk-name=org.freedesktop.Notifications
  # System tray
  - --talk-name=org.kde.StatusNotifierWatcher
  # Secret storage (for Stronghold vault)
  - --talk-name=org.freedesktop.secrets

modules:
  - name: hotline
    buildsystem: simple
    build-options:
      append-path: /usr/lib/sdk/rust-stable/bin:/usr/lib/sdk/node20/bin
      env:
        CARGO_HOME: /run/build/hotline/cargo
    build-commands:
      - npm install  # or bun equivalent
      - cargo build --release -p llamenos-desktop
      - install -Dm755 src-tauri/target/release/hotline /app/bin/hotline
    sources:
      - type: git
        url: https://github.com/Llamenos-Hotline/llamenos-platform.git
        tag: v0.1.0  # Updated per release
```

This is a starting point. Flathub reviewers will likely request changes. Consult
the Flathub documentation for current requirements:
https://docs.flathub.org/docs/for-app-authors/submission

### 4.2 Submit to Flathub

1. Fork https://github.com/flathub/flathub
2. Create a new branch named `org.llamenos.Hotline`
3. Add `org.llamenos.Hotline.yml` to the repository root
4. Add required metadata:
   - `org.llamenos.Hotline.metainfo.xml` (AppStream metadata with app
     description, screenshots, release notes)
   - Desktop file and icons in the expected paths
5. Open a pull request to `flathub/flathub`
6. Respond to reviewer feedback (typically 1-3 review rounds)

### 4.3 After approval

Once the PR is merged, Flathub creates a dedicated repository at
`https://github.com/flathub/org.llamenos.Hotline`. To publish updates:

1. Update the `tag` and `commit` in the manifest's `sources` section
2. Push to the Flathub repository (you get maintainer access after approval)
3. Flathub's buildbot picks up changes and publishes within ~1 hour

Consider automating this with a GitHub Action that updates the Flathub manifest
whenever a new `release/desktop-v*` tag is pushed.

### 4.4 Desktop file and AppStream metadata

These files must be installed by the app for Flathub compliance:

- **Desktop file**: `org.llamenos.Hotline.desktop` with proper `Exec`,
  `Icon`, `Categories`, and `StartupWMClass` fields
- **AppStream metainfo**: `org.llamenos.Hotline.metainfo.xml` with OARS
  content rating, screenshots, and release history
- **Icons**: SVG preferred, at minimum 128x128 PNG

---

## 5. F-Droid Submission (future -- mobile)

This section applies to the `llamenos-mobile` React Native app once it is ready
for release. F-Droid is the primary distribution channel for privacy-conscious
Android users.

### 5.1 Prerequisites

- The mobile app must build reproducibly from source
- All dependencies must be free/open-source (F-Droid policy)
- No proprietary push notification services (use UnifiedPush or polling)

### 5.2 Prepare the metadata

1. Fork https://gitlab.com/fdroid/fdroiddata on GitLab
2. Create `metadata/org.llamenos.hotline.yml`:

```yaml
Categories:
  - Phone & SMS
  - Security
License: AGPL-3.0-or-later
AuthorName: Llamenos
AuthorEmail: dev@llamenos.org
AuthorWebSite: https://llamenos-platform.com
WebSite: https://llamenos-platform.com
SourceCode: https://github.com/Llamenos-Hotline/llamenos-platform
IssueTracker: https://github.com/Llamenos-Hotline/llamenos-platform/issues

AutoName: Hotline
Description: |
  Secure, privacy-preserving crisis response hotline with end-to-end
  encryption. Designed for organizations running phone-based crisis
  lines where volunteer and caller identity protection is critical.

RepoType: git
Repo: https://github.com/Llamenos-Hotline/llamenos-platform.git

Builds:
  - versionName: 1.0.0
    versionCode: 1
    commit: v1.0.0
    subdir: android/app
    gradle:
      - yes
    prebuild:
      - cd ../..
      - npm install
    scandelete:
      - node_modules

AutoUpdateMode: Version
UpdateCheckMode: Tags
CurrentVersion: 1.0.0
CurrentVersionCode: 1
```

### 5.3 Submit

1. Open a Merge Request on `gitlab.com/fdroid/fdroiddata`
2. F-Droid maintainers will review the build recipe
3. After merge, builds are picked up in the next F-Droid index cycle (can take
   up to a week)
4. Subsequent releases are detected automatically via `AutoUpdateMode: Version`

### 5.4 Signing

F-Droid builds and signs the APK with their own key by default. If you want
users to be able to verify your signature, publish your signing key fingerprint
on your website and in the app's metadata.

---

## 6. Google Play Store (future -- mobile)

For reaching the broadest Android audience. This is separate from F-Droid and
uses Google's signing infrastructure.

### 6.1 Enroll in Google Play Console

1. Go to https://play.google.com/console
2. Pay the one-time $25 registration fee
3. Complete identity verification (government ID required)
4. Wait for account approval (can take several days for organizations)

### 6.2 Create the app listing

1. In Play Console, click **Create app**
2. Fill in:
   - **App name**: Hotline (by Llamenos)
   - **Default language**: English (US)
   - **App or game**: App
   - **Free or paid**: Free
3. Complete the **Store listing**:
   - Short description (80 chars max)
   - Full description (4000 chars max)
   - Screenshots: phone (2+), 7-inch tablet, 10-inch tablet
   - Feature graphic (1024x500)
   - App icon (512x512)
4. Complete the **Content rating** questionnaire (IARC)
5. Set **Target audience**: select appropriate age groups
6. Complete the **Data safety** section (critical for a privacy-focused app --
   declare exactly what data is collected, encrypted, and whether it can be
   deleted)

### 6.3 Set up Play App Signing

Google Play requires Play App Signing for new apps. This means Google holds the
signing key, and you upload an upload key.

1. In Play Console, go to **Setup > App signing**
2. Choose **Use Google-generated key** (recommended) or upload your own
3. Generate an **upload key**:
   ```bash
   keytool -genkey -v -keystore upload-keystore.jks \
     -keyalg RSA -keysize 2048 -validity 10000 \
     -alias upload -storepass YOUR_STORE_PASSWORD
   ```
4. Export the upload certificate:
   ```bash
   keytool -export -rfc -keystore upload-keystore.jks \
     -alias upload -file upload_certificate.pem
   ```
5. Upload `upload_certificate.pem` to Play Console

### 6.4 CI integration

For automated releases from CI, store these as GitHub Secrets:

| Secret Name | Value |
|---|---|
| `PLAY_KEYSTORE` | Base64-encoded `upload-keystore.jks` |
| `PLAY_KEYSTORE_PASSWORD` | Keystore password |
| `PLAY_KEY_ALIAS` | Key alias (e.g., `upload`) |
| `PLAY_KEY_PASSWORD` | Key password |
| `PLAY_SERVICE_ACCOUNT_JSON` | Google Play API service account credentials |

The service account JSON is created in Google Cloud Console and linked to your
Play Console account for automated publishing.

### 6.5 Release tracks

Use the **Internal testing** track for early builds, then promote through:
Internal testing > Closed testing > Open testing > Production.

---

## 7. GitHub Repository Secrets Checklist

Complete inventory of every secret the CI/CD pipelines require. Set these at
**Settings > Secrets and variables > Actions** in the GitHub repository.

### Desktop Release Secrets (`tauri-release.yml`)

| Secret | Used By | How to Get | Required |
|--------|---------|------------|----------|
| `TAURI_SIGNING_PRIVATE_KEY` | All platforms | [Section 1](#1-tauri-updater-signing-keypair) | Yes -- updater breaks without this |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | All platforms | [Section 1](#1-tauri-updater-signing-keypair) | Yes -- updater breaks without this |
| `APPLE_CERTIFICATE` | macOS build | [Section 2](#2-apple-developer-account-macos-code-signing--notarization) | Yes for macOS distribution |
| `APPLE_CERTIFICATE_PASSWORD` | macOS build | [Section 2](#2-apple-developer-account-macos-code-signing--notarization) | Yes for macOS distribution |
| `APPLE_SIGNING_IDENTITY` | macOS build | [Section 2](#2-apple-developer-account-macos-code-signing--notarization) | Yes for macOS distribution |
| `APPLE_ID` | macOS notarization | [Section 2](#2-apple-developer-account-macos-code-signing--notarization) | Yes for macOS distribution |
| `APPLE_PASSWORD` | macOS notarization | [Section 2](#2-apple-developer-account-macos-code-signing--notarization) | Yes for macOS distribution |
| `APPLE_TEAM_ID` | macOS notarization | [Section 2](#2-apple-developer-account-macos-code-signing--notarization) | Yes for macOS distribution |
| `AZURE_TENANT_ID` | Windows build | [Section 3 Option A](#option-a-azure-trusted-signing-recommended-for-ci) | Yes for Windows distribution |
| `AZURE_CLIENT_ID` | Windows build | [Section 3 Option A](#option-a-azure-trusted-signing-recommended-for-ci) | Yes for Windows distribution |
| `AZURE_CLIENT_SECRET` | Windows build | [Section 3 Option A](#option-a-azure-trusted-signing-recommended-for-ci) | Yes for Windows distribution |

### CI/CD Secrets (`ci.yml`)

The backend is a Bun + PostgreSQL server deployed to a self-hosted VPS via Ansible/Docker
Compose. `ci.yml` does not use Cloudflare credentials for backend deployment. Cloudflare
credentials are only required for the marketing site (`site/`) deployment via
`bun run deploy:site`.

| Secret | Used By | How to Get | Required |
|--------|---------|------------|----------|
| `CLOUDFLARE_API_TOKEN` | Marketing site deploy (`site/`) only | Cloudflare dashboard > API Tokens | Only for `bun run deploy:site` |
| `CLOUDFLARE_ACCOUNT_ID` | Marketing site deploy (`site/`) only | Cloudflare dashboard > Account Home | Only for `bun run deploy:site` |

### Docker Secrets (`docker.yml`)

| Secret | Used By | How to Get | Required |
|--------|---------|------------|----------|
| `GITHUB_TOKEN` | GHCR push, release creation | Automatic (provided by GitHub Actions) | Automatic -- no setup needed |

### Future Mobile Secrets (not yet needed)

| Secret | Used By | How to Get | Required |
|--------|---------|------------|----------|
| `PLAY_KEYSTORE` | Android Play Store release | [Section 6](#6-google-play-store-future----mobile) | When mobile ships |
| `PLAY_KEYSTORE_PASSWORD` | Android Play Store release | [Section 6](#6-google-play-store-future----mobile) | When mobile ships |
| `PLAY_KEY_ALIAS` | Android Play Store release | [Section 6](#6-google-play-store-future----mobile) | When mobile ships |
| `PLAY_KEY_PASSWORD` | Android Play Store release | [Section 6](#6-google-play-store-future----mobile) | When mobile ships |
| `PLAY_SERVICE_ACCOUNT_JSON` | Android Play Store API | [Section 6](#6-google-play-store-future----mobile) | When mobile ships |

### Verification command

After setting secrets, verify they are visible to workflows:

```bash
gh secret list --repo Llamenos-Hotline/llamenos-platform
```

Expected output should include at minimum:

```
TAURI_SIGNING_PRIVATE_KEY          Updated 2025-XX-XX
TAURI_SIGNING_PRIVATE_KEY_PASSWORD Updated 2025-XX-XX
APPLE_CERTIFICATE                  Updated 2025-XX-XX
APPLE_CERTIFICATE_PASSWORD         Updated 2025-XX-XX
APPLE_SIGNING_IDENTITY             Updated 2025-XX-XX
APPLE_ID                           Updated 2025-XX-XX
APPLE_PASSWORD                     Updated 2025-XX-XX
APPLE_TEAM_ID                      Updated 2025-XX-XX
AZURE_TENANT_ID                    Updated 2025-XX-XX
AZURE_CLIENT_ID                    Updated 2025-XX-XX
AZURE_CLIENT_SECRET                Updated 2025-XX-XX
```

For marketing site deployment only (optional):
```
CLOUDFLARE_API_TOKEN               Updated 2025-XX-XX
CLOUDFLARE_ACCOUNT_ID              Updated 2025-XX-XX
```

---

## 8. Version Sync Checklist

Before cutting the first public release, verify that all version numbers,
identifiers, and configuration values are consistent across the project.

### Pre-first-release checklist

- [x] **Tauri updater public key** is set in `apps/desktop/tauri.conf.json`
      (`plugins.updater.pubkey` contains the real minisign Ed25519 public key; key ID E1F35E58BD83142F)
- [x] **Tauri updater endpoint** URL in `apps/desktop/tauri.conf.json` points to
      the RustFS update server (primary: `https://updates.llamenos-hotline.org/desktop/latest.json`,
      fallback: `https://releases.llamenos-hotline.org/desktop/latest.json`)
- [ ] **App identifier** is finalized in `apps/desktop/tauri.conf.json`
      (currently: `org.llamenos.hotline`)
- [ ] **Version numbers are in sync** across all files:
  - `package.json` `version` field (currently: `0.19.10`)
  - `apps/desktop/Cargo.toml` `version` field
  - `apps/desktop/tauri.conf.json` `version` field
  - `deploy/helm/llamenos/Chart.yaml` `appVersion` field
- [ ] **Tauri and Cargo versions match**: `apps/desktop/tauri.conf.json` `version`
      must equal `apps/desktop/Cargo.toml` `version`. Both must match `package.json`
      at release time. knope manages version bumps across all files automatically.
- [ ] **Bundle targets** in `apps/desktop/tauri.conf.json` are set to `"all"` for
      release (currently correct)
- [ ] **`createUpdaterArtifacts`** is `true` in `apps/desktop/tauri.conf.json`
      (currently correct -- ensures `.sig` files are generated)
- [ ] **GitHub Actions workflows are enabled** on the repository (check
      Settings > Actions > General)
- [ ] **`packages/crypto` is in-repo**: The shared Rust crypto crate lives at
      `packages/crypto/` in this monorepo. No external `llamenos-core` checkout
      is needed. `tauri-release.yml` builds from the monorepo directly.
- [ ] **All GitHub Secrets from Section 7** are set and populated
- [ ] **CSP `connect-src`** in `apps/desktop/tauri.conf.json` is
      `ipc: http://ipc.localhost` — it lists no remote origin, because the desktop
      app reaches the API through the Rust side over Tauri IPC, not from the webview.
      If a remote origin is ever added it must be the production API domain,
      `https://api.<domain>` (`https://api.llamenos-hotline.org` for the reference
      deployment). `app.<domain>` is **not** the API domain: nothing serves it — no DNS
      record and no Caddy vhost (see `docs/deployment/first-deploy.md`). It survives only
      as a default CORS origin in `apps/worker/middleware/cors.ts` and
      `apps/worker/lib/redirect-guard.ts`.
- [ ] **Update manifest script** (`scripts/generate-update-manifest.sh`) uses
      the correct repository name in `REPO` variable (currently:
      `Llamenos-Hotline/llamenos-platform`)
- [ ] **Helm chart `sources`** in `deploy/helm/llamenos/Chart.yaml` points to
      the actual GitHub repository (currently: `https://github.com/your-org/llamenos`
      -- needs updating)
- [ ] **Test with a dry run**: Push a tag like `release/desktop-v0.1.0-rc.1` to
      trigger `tauri-release.yml` and verify that all three platform builds
      succeed, artifacts are uploaded, and the release is created with a valid
      `latest.json` manifest

### Version bump script gaps

The CI version job (`ci.yml` `version` step) currently bumps:
- `package.json` (yes)
- `deploy/helm/llamenos/Chart.yaml` `appVersion` (yes)

It does NOT bump:
- `apps/desktop/tauri.conf.json` `version` (needs adding)
- `apps/desktop/Cargo.toml` `version` (managed by knope)

Similarly, the manual `scripts/bump-version.ts` only updates `package.json`.
Before the first desktop release, update both the CI workflow and the manual
script to keep all four version files in sync.

### Release flow summary

1. **API releases** (automatic): Push to `main` with conventional commits.
   `ci.yml` runs E2E tests, bumps version, deploys the Bun + PostgreSQL backend
   to the self-hosted VPS via Ansible/Docker Compose, and creates a GitHub
   Release with CHECKSUMS.txt and SLSA provenance.

2. **Desktop releases** (tag-triggered): Push a `release/desktop-v*` tag or
   use workflow dispatch. `tauri-release.yml` builds signed binaries for
   macOS (universal), Windows (x64), and Linux (x64). Creates GitHub Release
   with `latest.json` manifest for auto-updater.

3. **Docker image releases** (tag-triggered): Any `v*` tag triggers
   `docker.yml`, which builds and pushes to GHCR with Trivy vulnerability
   scanning.

The desktop release is independent of the API release. Version numbers should
be coordinated but do not need to match exactly -- the desktop app connects to
a versioned API endpoint.

**Update (Epic 108)**: The `scripts/bump-version.ts` has been updated to sync
all 5 version files (package.json, tauri.conf.json, Cargo.toml, Chart.yaml,
metainfo.xml). Use `./scripts/sync-versions.sh --fix` to verify/fix sync.

---

## 9. Mobile: Google Play Console Setup

### Creating the app listing

1. Create a [Google Play Console](https://play.google.com/console) developer account ($25 one-time fee)
2. Create a new app: "Hotline" → category "Communication"
3. Complete the app content declaration (privacy policy URL, data safety form)
4. Set up an internal testing track first

### APK signing

Google Play requires AAB (Android App Bundle) for new apps. For sideloading, APK works.

**Option A: Google-managed signing (recommended)**
1. Upload the first AAB — Google generates and manages the signing key
2. You only need an upload key (different from the signing key)

**Option B: Self-managed signing**
1. Generate a keystore: `keytool -genkey -v -keystore release.keystore -alias hotline -keyalg RSA -keysize 2048 -validity 10000`
2. Store keystore password and alias as GitHub Secrets:
   - `ANDROID_KEYSTORE_BASE64` — base64-encoded `.keystore` file
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`

### GitHub Secrets for Android

| Secret | Description |
|--------|-------------|
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded release keystore |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore password |
| `ANDROID_KEY_ALIAS` | Key alias (e.g., "hotline") |
| `ANDROID_KEY_PASSWORD` | Key password |

---

## 10. Mobile: Apple Developer Account for iOS

### TestFlight setup

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) ($99/year)
2. Create an App ID with bundle identifier `net.riseup.llamenos`
3. Create a distribution certificate (Apple Distribution)
4. Create a provisioning profile (App Store)

### Code signing for CI

Export the distribution certificate as `.p12` and encode:
```bash
base64 < Certificates.p12 | pbcopy
```

### GitHub Secrets for iOS

| Secret | Description |
|--------|-------------|
| `APPLE_CERTIFICATE_BASE64` | Base64 .p12 distribution cert |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 password |
| `APPLE_PROVISIONING_PROFILE_BASE64` | Base64 provisioning profile |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_BUNDLE_ID` | `net.riseup.llamenos` |
| `APP_STORE_CONNECT_API_KEY_ID` | App Store Connect API key |
| `APP_STORE_CONNECT_ISSUER_ID` | App Store Connect issuer |
| `APP_STORE_CONNECT_API_KEY_BASE64` | Base64 .p8 API key |

---

## 11. Mobile: F-Droid Submission

F-Droid requires reproducible builds from source. Steps:

1. Ensure the app builds from source without proprietary dependencies
2. Create an F-Droid metadata file at `metadata/net.riseup.llamenos.yml`
3. Submit to [F-Droid Data](https://gitlab.com/fdroid/fdroiddata) via merge request
4. F-Droid builders compile from source on each release

Note: Since `packages/crypto` is a Rust crate compiled to native JNI libraries
for Android, F-Droid builds need the Rust toolchain and Android NDK in their
build environment. The crypto crate is in-repo at `packages/crypto/` -- no
external repository checkout is required.

---

## 12. Mobile: Push Notification Certificates

### APNs (iOS)

1. In Apple Developer portal → Certificates → create "Apple Push Notification service SSL"
2. Download `.p12` certificate
3. Or use APNs Auth Key (`.p8`) — recommended, doesn't expire

| Secret | Description |
|--------|-------------|
| `APNS_KEY_ID` | APNs auth key ID |
| `APNS_KEY_BASE64` | Base64 .p8 APNs key |
| `APNS_TEAM_ID` | Apple Developer Team ID |

### FCM (Android)

1. In Firebase Console → Project Settings → Cloud Messaging
2. Generate a service account JSON key
3. Or use the FCM v1 API with a server key

| Secret | Description |
|--------|-------------|
| `FCM_SERVICE_ACCOUNT_JSON` | Firebase service account JSON |
