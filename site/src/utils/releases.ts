import { siteConfig } from '../config';

/**
 * Build-time lookup of the GitHub Releases that actually carry installable
 * artifacts.
 *
 * Release layout (published by CI):
 *   `v<version>-desktop` — desktop installers, each with a base64-wrapped
 *                          minisign `.sig`, plus CHECKSUMS.txt, SBOM and
 *                          build-info.json (.github/workflows/tauri-release.yml)
 *   `v<version>-android` — app-release.apk + app-release.apk.sha256
 *                          (.github/workflows/mobile-release.yml)
 *   `v<version>`         — integrity metadata ONLY (cosign-signed CHECKSUMS.txt,
 *                          SLSA provenance, SBOM). Never carries an installer,
 *                          so it must never be the source of a download link.
 *
 * Platform tags are version-first so GitHub's Releases page, which orders
 * same-day releases by tag name, keeps one version's releases together.
 * Releases cut before that change are tagged `desktop-v<version>` /
 * `android-v<version>`; tags are immutable, so both forms are read.
 *
 * CHECKSUMS.txt is taken from the SAME desktop release that serves the
 * installers, so the integrity reference cannot drift from the binaries.
 *
 * Runs only at build time (Astro static output). Any failure — offline build,
 * GitHub outage, API rate limit — yields nulls, and the download page renders
 * an explicit error plus a link to the Releases index. It never invents a URL.
 * Set GITHUB_TOKEN in the build environment to raise the API rate limit.
 */

export interface DesktopRelease {
  tag: string;
  version: string;
  url: string;
  checksumsUrl: string | null;
  windowsExe: string | null;
  windowsMsi: string | null;
  linuxAppImage: string | null;
  linuxDeb: string | null;
  linuxRpm: string | null;
}

export interface AndroidRelease {
  tag: string;
  version: string;
  url: string;
  apkUrl: string | null;
  apkSha256Url: string | null;
}

export interface LatestReleases {
  desktop: DesktopRelease | null;
  android: AndroidRelease | null;
  fetchFailed: boolean;
}

interface GhAsset {
  name: string;
  browser_download_url: string;
}

interface GhRelease {
  tag_name: string;
  draft: boolean;
  published_at: string;
  html_url: string;
  assets: GhAsset[];
}

async function listReleases(): Promise<GhRelease[] | null> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'llamenos-site-build',
  };
  // Optional: raises the unauthenticated 60 req/hr per-IP API limit in CI.
  const token = import.meta.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${siteConfig.github.org}/${siteConfig.github.repo}/releases?per_page=50`,
      { headers },
    );
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return Array.isArray(data) ? (data as GhRelease[]) : null;
  } catch {
    return null;
  }
}

type Platform = 'desktop' | 'android';

/** The version a platform release's tag names, or null if it is not one. */
export function platformTagVersion(tag: string, platform: Platform): string | null {
  const m = new RegExp(`^(?:v(\\d[^\\s]*)-${platform}|${platform}-v(\\d[^\\s]*))$`).exec(tag);
  return m ? (m[1] ?? m[2]) : null;
}

interface TaggedRelease {
  release: GhRelease;
  version: string;
}

function latestTagged(releases: GhRelease[], platform: Platform): TaggedRelease | null {
  const matches: TaggedRelease[] = [];
  for (const release of releases) {
    const version = release.draft ? null : platformTagVersion(release.tag_name, platform);
    if (version !== null) matches.push({ release, version });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => Date.parse(b.release.published_at) - Date.parse(a.release.published_at));
  return matches[0];
}

function assetUrl(release: GhRelease, match: (name: string) => boolean): string | null {
  return release.assets.find(a => match(a.name))?.browser_download_url ?? null;
}

// Asset names observed on desktop-v0.19.18:
//   Hotline_0.19.18_x64-setup.exe, Hotline_0.19.18_x64_en-US.msi,
//   Hotline_0.19.18_amd64.AppImage, Hotline_0.19.18_amd64.deb,
//   Hotline-0.19.18-1.x86_64.rpm, CHECKSUMS.txt (+ .sig per installer)
function toDesktopRelease({ release: r, version }: TaggedRelease): DesktopRelease {
  return {
    tag: r.tag_name,
    version,
    url: r.html_url,
    checksumsUrl: assetUrl(r, n => n === 'CHECKSUMS.txt'),
    windowsExe: assetUrl(r, n => n.endsWith('_x64-setup.exe')),
    windowsMsi: assetUrl(r, n => n.endsWith('.msi')),
    linuxAppImage: assetUrl(r, n => n.endsWith('.AppImage')),
    linuxDeb: assetUrl(r, n => n.endsWith('.deb')),
    linuxRpm: assetUrl(r, n => n.endsWith('.rpm')),
  };
}

// Asset names observed on android-v0.19.18: app-release.apk, app-release.apk.sha256
function toAndroidRelease({ release: r, version }: TaggedRelease): AndroidRelease {
  return {
    tag: r.tag_name,
    version,
    url: r.html_url,
    apkUrl: assetUrl(r, n => n === 'app-release.apk'),
    apkSha256Url: assetUrl(r, n => n === 'app-release.apk.sha256'),
  };
}

export async function fetchLatestReleases(): Promise<LatestReleases> {
  const releases = await listReleases();
  if (!releases) {
    return { desktop: null, android: null, fetchFailed: true };
  }
  const desktop = latestTagged(releases, 'desktop');
  const android = latestTagged(releases, 'android');
  return {
    desktop: desktop ? toDesktopRelease(desktop) : null,
    android: android ? toAndroidRelease(android) : null,
    fetchFailed: false,
  };
}
