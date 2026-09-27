export const siteConfig = {
  name: 'Llámenos',
  url: 'https://llamenos-platform.com',
  description: 'Secure open-source crisis response hotline software with end-to-end encryption.',

  github: {
    org: 'Llamenos-Hotline',
    repo: 'llamenos-platform',
    url: 'https://github.com/Llamenos-Hotline/llamenos-platform',
    releasesUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/releases/latest',
    issuesUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/issues',
    mobileReleasesUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/releases/latest',
  },

  // The container images this project publishes. These are the addresses the
  // download page and the deploy docs tell self-hosters to `docker pull`, so
  // they are a public API in the only sense that matters: an operator pastes
  // them into a terminal.
  //
  // Lowercase, unlike `github.org` above: OCI registries reject a mixed-case
  // repository path outright ("repository name must be lowercase"), while
  // GitHub renders the owner in its display casing. The producing workflow
  // folds `${{ github.repository }}` the same way before it reaches ghcr.io.
  //
  // A rail in tests/orchestrator/release-ghcr-publish.test.ts asserts `app`
  // equals what release.yml's `docker-stable` job actually publishes, with
  // the repository half resolved from the real repository rather than from a
  // literal — so this cannot go stale in step with the workflow again.
  registry: {
    app: 'ghcr.io/llamenos-hotline/llamenos-platform',
    signalNotifier: 'ghcr.io/llamenos-hotline/llamenos-signal-notifier',
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
