export const siteConfig = {
  name: 'Llámenos',
  url: 'https://llamenos-platform.com',
  description: 'Secure open-source crisis response hotline software with end-to-end encryption.',

  github: {
    org: 'rhonda-rodododo',
    repo: 'llamenos-platform',
    url: 'https://github.com/rhonda-rodododo/llamenos-platform',
    releasesUrl: 'https://github.com/rhonda-rodododo/llamenos-platform/releases/latest',
    issuesUrl: 'https://github.com/rhonda-rodododo/llamenos-platform/issues',
    mobileReleasesUrl: 'https://github.com/rhonda-rodododo/llamenos-platform/releases/latest',
  },

  // Deliberately still `rhonda-rodododo`, NOT a missed rename (#1218): the
  // repository moved to the `Llamenos-Hotline` org but the GHCR package did
  // not follow the transfer. `ghcr.io/rhonda-rodododo/llamenos-platform`
  // returns 200 with live tags (`latest`, `0.19.15`); the Llamenos-Hotline
  // path returns 403 and does not exist yet. This is the address the download
  // page tells operators to `docker pull`, so moving it before the new
  // package exists AND is public (GHCR defaults new packages to private)
  // would break a working install command. Tracked in #1223.
  registry: {
    app: 'ghcr.io/rhonda-rodododo/llamenos-platform',
    signalNotifier: 'ghcr.io/rhonda-rodododo/llamenos-signal-notifier',
  },

  license: 'AGPL-3.0',

  distribution: {
    // Self-hosted update and download servers (Iceland VPS)
    updateServerUrl: 'https://updates.llamenos.org/desktop',
    downloadServerUrl: 'https://downloads.llamenos.org',

    // Minisign public key for manual signature verification
    // Key ID: E1F35E58BD83142F
    minisignPublicKey: 'RWQvFIO9WF7z4SSDEpgFWbUeUKOwbqVJeNfuIFhhhMkS/0K8XGMXJ9M2',

    // GPG fingerprint for optional CHECKSUMS.txt verification
    // Set this to the actual fingerprint once the release signing key is generated
    gpgFingerprint: 'A1B2 C3D4 E5F6 7890 1234 5678 90AB CDEF 1234 5678',

    // Public audit repository (metadata, signatures, SBOM, provenance — no binaries)
    auditRepoUrl: 'https://github.com/rhonda-rodododo/llamenos-releases',
  },
} as const;
