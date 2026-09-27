export const siteConfig = {
  name: 'Llámenos',
  url: 'https://llamenos-platform.com',
  description: 'Secure open-source crisis response hotline software with end-to-end encryption.',

  // The GitHub repository moved to the `Llamenos-Hotline` org, so every
  // github.com address here moves with it. These are live config, not
  // decoration: Header/Footer link `url`, and download.astro drives every
  // download button and the CHECKSUMS link off `releasesUrl`.
  //
  // Migrated rather than left on the redirect deliberately. GitHub serves the
  // old-owner redirect only while the vacated path stays unoccupied — and
  // that is a condition this project does not control, because a personal
  // account can be deleted or renamed, which frees the username for anyone to
  // register. A download page resolving through a redirect someone else can
  // one day terminate is a supply-chain path aimed at exactly the people this
  // product protects.
  github: {
    org: 'Llamenos-Hotline',
    repo: 'llamenos-platform',
    url: 'https://github.com/Llamenos-Hotline/llamenos-platform',
    releasesUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/releases/latest',
    issuesUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/issues',
    mobileReleasesUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/releases/latest',
  },

  // THE CONTAINER REGISTRY ADDRESSES BELOW — and nothing else in this file —
  // are deliberately still `rhonda-rodododo`. This is not a missed rename
  // (#1218), and it does NOT extend to the github.com URLs above, which are
  // correctly migrated: the repository moved, so those move with it.
  //
  // What did not move is the GHCR package. A repository transfer does not
  // carry its container packages, and this one demonstrably did not:
  // `ghcr.io/rhonda-rodododo/llamenos-platform` returns 200 with live tags
  // (`latest`, `0.19.15`, `0.19.14`), while
  // `ghcr.io/llamenos-hotline/llamenos-platform` returns 403 and does not
  // exist. Unlike a github.com path, ghcr.io serves no redirect, so this is
  // the only address that currently works.
  //
  // These are what the download page and deploy docs tell self-hosters to
  // `docker pull`. Moving them before the new package exists AND is public
  // (GHCR defaults new packages to private on first push) would replace a
  // working install command with a 404. Tracked in #1223, which moves them
  // once that holds.
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

    // Public audit repository (metadata, signatures, SBOM, provenance — no binaries).
    // Rendered on the download page as the provenance trust anchor, so it must
    // not rest on an owner redirect — see the note above `github`.
    //
    // CAVEAT: this repository does not exist yet under EITHER owner (both
    // `gh api` lookups 404). Only the owner is migrated here; the name is
    // unchanged, because inventing a different target would be a guess. Two
    // things must line up before this link resolves: the repo has to be
    // created under the org, and `tauri-release.yml` has to push its metadata
    // there — it currently clones `rhonda-rodododo/llamenos-releases`, which
    // is inside the files #1217 owns and so was left untouched here. See
    // #1218 for the full list of `llamenos-releases` references.
    auditRepoUrl: 'https://github.com/Llamenos-Hotline/llamenos-releases',
  },
} as const;
