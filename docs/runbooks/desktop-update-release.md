# Desktop Update Release Operations

## Purpose

How desktop updates are published to the update server, and how to manually re-upload if needed.

## Status (read first)

The **GitHub Release** `desktop-v<version>` is the working, always-on channel and
needs nothing from the server. The self-hosted updater origin
(`updates.<domain>` / `releases.<domain>`) is an *additional* channel and is **not
yet functional end to end**: `scripts/generate-update-manifest.sh` produces
`"platforms": {}` for the real release artifacts (it searches for
`*.app.tar.gz.sig` / `*.nsis.zip.sig` / `*.AppImage.tar.gz.sig`; Tauri v2 ships
`*.AppImage.sig`, `*-setup.exe.sig`, `*.msi.sig`), and `RUSTFS_PUBLIC_URL` is never
set by the workflow, so URLs default to `https://releases.llamenos-hotline.org`. Details and
the hosting options: [`docs/deployment/first-deploy.md` §5](../deployment/first-deploy.md#5-serving-desktop-updates-from-this-box).

## What the server serves

`updates.<domain>` and `releases.<domain>` are vhosts of the box's single Caddy
(role `llamenos-caddy`, enabled by `llamenos_update_server_enabled`), serving
`/opt/llamenos/services/update-server/artifacts` read-only:

```
desktop/latest.json                 <- tauri.conf.json plugins.updater.endpoints
desktop/v<version>/<installer>      <- URLs inside latest.json
desktop/v<version>/<installer>.sig
```

Only `/desktop/*` and `/health` are served; everything else is 404.

## CI flow (`tauri-release.yml`)

1. Builds and signs (minisign, `TAURI_SIGNING_PRIVATE_KEY`) the desktop artifacts.
2. **Always** publishes the GitHub Release `desktop-v<version>` with every installer, its `.sig`, `CHECKSUMS.txt`, SBOM and `build-info.json`.
3. **Only if all five** of `RELEASES_REPO_PAT`, `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `RUSTFS_ENDPOINT`, `RUSTFS_STAGING_BUCKET` are set: uploads to `s3://<bucket>/desktop/v<version>/…` and `s3://<bucket>/desktop/latest.json`, and commits checksums/SBOM to the `llamenos-releases` repo. None set → skipped cleanly; some set → the job fails.
4. The Tauri updater verifies the minisign signature against the pubkey embedded in `tauri.conf.json` before applying.

## Manual publish to the box

Once the manifest generator is fixed (or a correct `latest.json` is produced by
hand — one `platforms` entry per target with `signature` = the contents of the
installer's `.sig` and `url` = `https://releases.<domain>/desktop/v<version>/<installer>`):

```bash
# 1. get the signed artifacts (GitHub Release is the source of truth)
gh release download desktop-v<version> --repo Llamenos-Hotline/llamenos-platform -D flat-artifacts

# 2. manifest (URLs must point at the self-hosted origin)
VERSION=<version> RUSTFS_PUBLIC_URL=https://releases.<domain> \
  ./scripts/generate-update-manifest.sh flat-artifacts        # writes ./latest.json — check it has platform entries!

# 3. upload: versioned files first, the manifest LAST (it is what clients read)
rsync -av flat-artifacts/ -e "ssh -p <ssh_port> -i ~/.ssh/<key>" \
  deploy@<ipv4>:/opt/llamenos/services/update-server/artifacts/desktop/v<version>/
rsync -av latest.json -e "ssh -p <ssh_port> -i ~/.ssh/<key>" \
  deploy@<ipv4>:/opt/llamenos/services/update-server/artifacts/desktop/latest.json

# 4. verify
curl -fsS https://updates.<domain>/desktop/latest.json | jq '.version, (.platforms | keys)'
```

## Anti-Rollback

The Tauri updater in `src/client/lib/updater.ts` enforces a version floor — clients reject updates with a version lower than their current version. This prevents downgrade attacks even if `latest.json` is tampered with (signature verification would also catch this).
