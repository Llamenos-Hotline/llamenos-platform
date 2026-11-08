# Deployment and distribution: the options

A map of the supported ways to run the Llámenos server and to get the clients
onto devices. Each entry says who it is for and points at the document that holds
the procedure; nothing is repeated here.

## Server

### Self-hosted with Ansible (any Debian VPS)

For operators who run their own server. You provision a Debian host, fill in
inventory and vars, and run the Ansible playbooks. Cost: one VPS (plus a second
small one if you want the push relay, see below) and a domain.

- Ordered procedure from blank VPS to running platform: [`first-deploy.md`](first-deploy.md)
- Self-hosted runbook: [`../runbooks/deploy-self-hosted.md`](../runbooks/deploy-self-hosted.md).
  It carries a **known-broken** notice for `deploy/scripts/deploy-self-hosted.sh`;
  follow `first-deploy.md` for the working path.

### Full-disk-encrypted install from the custom ISO

For operators who need the VPS provider to be unable to read the disk. You build a
Debian 13 installer ISO with LUKS2 + LVM encryption, install it once through the
provider's web console, then hand over to the same Ansible playbooks. Cost: a
workstation with Docker and one console session during install. Details:
[`iso-install.md`](iso-install.md).

### Two-tier layout: encrypted platform host + unencrypted push relay

The layout `first-deploy.md` targets: an **encrypted host** for the app, database,
object storage and TLS (it holds every secret), and a separate **unencrypted host**
that runs only the ntfy push relay and holds no secrets at rest. Cost: two VPSes.
See [Two hosts, two tiers](first-deploy.md#2-two-hosts-two-tiers). The official
deployment's day-2 operations are in
[`../runbooks/deploy-official.md`](../runbooks/deploy-official.md), and why Android
push uses a self-hosted relay is in [`../../deploy/PUSH_NOTIFICATIONS.md`](../../deploy/PUSH_NOTIFICATIONS.md).

## Clients

### Install a published release

For end users and testers; free, no toolchain needed.

- **Android:** the signed APK attached to the `v<version>-android` GitHub Release,
  titled `<version> Android` (with its SHA-256 checksum). Release procedure: [`../runbooks/android-release.md`](../runbooks/android-release.md).
- **Desktop:** the AppImage, deb, rpm, exe and msi installers (and macOS builds)
  attached to the `v<version>-desktop` GitHub Release, titled `<version> Desktop`.
  Releases up to and including 0.21.7 are tagged `android-v<version>` /
  `desktop-v<version>` instead (tags are immutable). Update-channel details:
  [`../runbooks/desktop-update-release.md`](../runbooks/desktop-update-release.md).

### Build and install locally from a checkout

For developers and testers who want a build without a store or release pipeline.
**Verified working for Android:** a clean run of
`packages/crypto/scripts/build-mobile.sh android` followed by `./gradlew assembleDebug`
produced an installable `app-debug.apk` carrying the locally built
`libllamenos_core.so`. Full steps and the iOS developer path:
[`local-mobile-deployment.md`](local-mobile-deployment.md).

### iOS

A downloaded iOS IPA is **not user-installable**. The repo exports with
`method = app-store-connect`, and iOS only runs such a binary when it arrives via
the App Store or TestFlight; there is no sideloading equivalent of an APK. The
chosen path is **TestFlight**: testers install the TestFlight app and accept an
invite, and nobody handles an IPA directly. What is and is not in place, and the
alternatives that were weighed, are in [`ios-distribution.md`](ios-distribution.md).
