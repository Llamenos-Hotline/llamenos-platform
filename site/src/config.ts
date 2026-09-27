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
