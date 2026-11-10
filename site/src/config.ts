// The repository's identity, once. Every github.com address below and the
// container image address are derived from these two values, so none of them
// can be renamed without the others.
const GITHUB_ORG = 'Llamenos-Hotline';
const GITHUB_REPO = 'llamenos-platform';
const GITHUB_URL = `https://github.com/${GITHUB_ORG}/${GITHUB_REPO}`;

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
  // provenance, SBOM — no installers). Installers ship on v<version>-desktop
  // and the APK on v<version>-android; utils/releases.ts resolves those tag
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
    org: GITHUB_ORG,
    repo: GITHUB_REPO,
    url: GITHUB_URL,
    releasesUrl: `${GITHUB_URL}/releases`,
    issuesUrl: `${GITHUB_URL}/issues`,
  },

  // Where self-hosters `docker pull` the app image from. It is derived the
  // same way release.yml's `docker-stable` job derives the address it
  // publishes to: `ghcr.io/${{ github.repository }}`, folded to lowercase
  // because registries reject mixed-case paths and GitHub renders the
  // owner in display casing. It is derived, not written out, because a
  // second literal is exactly what went stale here: a repository transfer
  // does not move its container packages. After the org move this file kept
  // advertising `ghcr.io/rhonda-rodododo/llamenos-platform` (its last tag is
  // 0.19.18) while every release from 0.19.19 on went to the org's own
  // namespace, so anyone following the docs stayed on an old version.
  //
  // tests/orchestrator/release-ghcr-publish.test.ts fails if this stops
  // matching what `docker-stable` pushes, or if any deploy doc names another
  // owner. verify-release-live.yml (surface 6) checks that the address can be
  // pulled anonymously. GHCR creates packages private, so an operator has to
  // make the package public once; until that is done, surface 6 stays red.
  registry: {
    app: `ghcr.io/${GITHUB_ORG.toLowerCase()}/${GITHUB_REPO}`,
  },

  license: 'AGPL-3.0',

  distribution: {
    // Minisign public key for manual installer signature verification.
    // This MUST stay identical to `plugins.updater.pubkey` in
    // apps/desktop/tauri.conf.json — tauri-release.yml signs every installer
    // on the v*-desktop releases with the matching private key, and the
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
