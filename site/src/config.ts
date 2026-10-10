export const siteConfig = {
  name: 'Llámenos',
  url: 'https://llamenos-platform.com',
  description: 'Secure open-source crisis response hotline software with end-to-end encryption.',

  // The GitHub repository moved to the `Llamenos-Hotline` org, so every
  // github.com address here moves with it. These are live config, not
  // decoration: Header/Footer link `url`, and download.astro builds its
  // fallback links off `releasesUrl` and its issue references off `issuesUrl`.
  //
  // `releasesUrl` is the Releases INDEX, deliberately not /releases/latest:
  // "latest" is the integrity-only v<version> release (CHECKSUMS.txt,
  // provenance, SBOM — no installers). Installers ship on desktop-v<version>
  // and the APK on android-v<version>; utils/releases.ts resolves those tag
  // families via the GitHub API at build time and falls back to this index.
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
    releasesUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/releases',
    issuesUrl: 'https://github.com/Llamenos-Hotline/llamenos-platform/issues',
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
    // Minisign public key for manual installer signature verification.
    // This MUST stay identical to `plugins.updater.pubkey` in
    // apps/desktop/tauri.conf.json — tauri-release.yml signs every installer
    // on the desktop-v* releases with the matching private key, and the
    // download page's verification instructions are worthless if they name
    // any other key. Provenance: docs/UPDATER_KEY_PROVENANCE.md.
    minisignKeyId: 'C8279C12F39DD35B',
    minisignPublicKey: 'RWRb053zEpwnyHZWc7JyNuZTP+9ikeGSbqDXHBv+Boll6SHuGlJNT1Py',

    // Public audit repository (metadata, signatures, SBOM, provenance — no
    // binaries). Rendered on the download page as the provenance trust
    // anchor, so it must not rest on an owner redirect — see `github` above.
    // The repo exists under the org but is still EMPTY: tauri-release.yml
    // pushes metadata to the old-owner clone instead (outside site/'s
    // ownership — tracked in #1218). The link resolves; content lands when
    // the workflow is pointed here.
    auditRepoUrl: 'https://github.com/Llamenos-Hotline/llamenos-releases',
  },
} as const;
