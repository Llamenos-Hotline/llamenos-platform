import { siteConfig } from '../config';

/**
 * Build-time lookup of the GitHub Releases that actually carry installable
 * artifacts.
 *
 * Release layout (published by CI):
 *   `desktop-v<version>` — desktop installers, each with a base64-wrapped
 *                          minisign `.sig`, plus CHECKSUMS.txt, SBOM and
 *                          build-info.json (.github/workflows/tauri-release.yml)
 *   `android-v<version>` — app-release.apk + app-release.apk.sha256
 *                          (.github/workflows/mobile-release.yml)
 *   `v<version>`         — integrity metadata ONLY (cosign-signed CHECKSUMS.txt,
 *                          SLSA provenance, SBOM). Never carries an installer,
 *                          so it must never be the source of a download link.
 *
 * CHECKSUMS.txt is taken from the SAME desktop-v* release that serves the
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

function latestTagged(releases: GhRelease[], prefix: string): GhRelease | null {
  const matches = releases.filter(r => !r.draft && r.tag_name.startsWith(prefix));
  if (matches.length === 0) return null;
  matches.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
  return matches[0];
}

function assetUrl(release: GhRelease, match: (name: string) => boolean): string | null {
  return release.assets.find(a => match(a.name))?.browser_download_url ?? null;
}

// Asset names observed on desktop-v0.19.18:
//   Hotline_0.19.18_x64-setup.exe, Hotline_0.19.18_x64_en-US.msi,
//   Hotline_0.19.18_amd64.AppImage, Hotline_0.19.18_amd64.deb,
//   Hotline-0.19.18-1.x86_64.rpm, CHECKSUMS.txt (+ .sig per installer)
function toDesktopRelease(r: GhRelease): DesktopRelease {
  return {
    tag: r.tag_name,
    version: r.tag_name.replace(/^desktop-v/, ''),
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
function toAndroidRelease(r: GhRelease): AndroidRelease {
  return {
    tag: r.tag_name,
    version: r.tag_name.replace(/^android-v/, ''),
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
  const desktop = latestTagged(releases, 'desktop-v');
  const android = latestTagged(releases, 'android-v');
  return {
    desktop: desktop ? toDesktopRelease(desktop) : null,
    android: android ? toAndroidRelease(android) : null,
    fetchFailed: false,
  };
}
