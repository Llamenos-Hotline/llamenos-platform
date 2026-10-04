---
name: release-signing
description: Use when cutting a release, signing desktop artifacts, promoting builds to production, uploading to RustFS, generating Tauri updater manifests, or when the user says "/release", "sign release", "promote build", "cut a release", or "publish desktop". Walks through the complete offline signing workflow with strict verification gates.
argument-hint: [version]
allowed-tools: [Read, Glob, Grep, Bash, Write, Edit, AskUserQuestion]
---

# Offline Signing & Release Workflow

This skill guides you through the complete desktop release signing workflow.
Every step is gated — **refuse to proceed if any verification fails**.

## Prerequisites

Before starting, verify these tools are installed:

```bash
# Required
command -v minisign || { echo "FATAL: minisign not installed. Install: apt install minisign / brew install minisign"; exit 1; }
command -v aws || { echo "FATAL: aws CLI not installed. Install: apt install awscli / brew install awscli"; exit 1; }
command -v jq || { echo "FATAL: jq not installed."; exit 1; }
command -v sha256sum || { echo "FATAL: sha256sum not installed."; exit 1; }
```

Also verify:
- `RUSTFS_ENDPOINT`, `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `RUSTFS_BUCKET` are set (or in `~/.llamenos-release.env`)
- The minisign private key is accessible (typically on a USB drive, e.g., `/media/operator/SIGNING_KEY/llamenos-release.key`)
- The `llamenos-releases` audit repo is cloned locally

## Arguments

The user may pass a version: `$ARGUMENTS`

If no version argument, ask the user:
> What version are you releasing? (e.g., 0.19.0)

Store as `VERSION` for all subsequent steps.

## Step 1: Fetch Staging Artifacts from RustFS

**Gate:** Artifacts must exist in the staging bucket.

```bash
# Source credentials if env file exists
[ -f ~/.llamenos-release.env ] && source ~/.llamenos-release.env

# List staging artifacts for this version
aws s3 ls "s3://${RUSTFS_BUCKET}/staging/v${VERSION}/" \
  --endpoint-url "${RUSTFS_ENDPOINT}" \
  --no-sign-request=false

# Download all staging artifacts to a local work directory
RELEASE_WORK="${TMPDIR:-/tmp}/llamenos-release-v${VERSION}"
mkdir -p "${RELEASE_WORK}"
aws s3 cp "s3://${RUSTFS_BUCKET}/staging/v${VERSION}/" "${RELEASE_WORK}/" \
  --endpoint-url "${RUSTFS_ENDPOINT}" \
  --recursive
```

**Verification gate:** Count downloaded files. Expect at minimum:
- `*.app.tar.gz` (macOS)
- `*.AppImage` (Linux)
- `*.nsis.zip` (Windows)
- `*.deb` (Linux)
- `*.flatpak` (Linux)
- `CHECKSUMS.txt`
- `*.sig` files (Tauri updater signatures from CI)

If fewer than 6 artifacts are present, **STOP** and report what's missing.

Show the user: file listing with sizes, and ask for confirmation before proceeding.

## Step 2: Verify Reproducible Build

**Gate:** `verify-build.sh` must exit 0.

```bash
# Run the existing reproducible build verifier against the version tag
./scripts/verify-build.sh "v${VERSION}"
```

This script (at `scripts/verify-build.sh`) will:
1. Download release artifacts from GitHub Releases
2. Verify cosign signatures (if cosign is installed)
3. Verify SBOM attestation
4. Verify SLSA provenance
5. Clone source at the tag, rebuild in Docker, compare checksums

**If `verify-build.sh` exits non-zero, STOP IMMEDIATELY.** Report the failure output to the operator. Do NOT proceed to signing.

**If cosign is not installed**, warn the operator but allow proceeding — the Docker reproducible build comparison is the primary trust anchor.

Ask the operator to confirm they've reviewed the verification output before proceeding.

## Step 3: Sign Artifacts with minisign

**Gate:** Every artifact must be signed. The operator must provide the key path.

Ask the operator:
> Where is your minisign private key? (e.g., /media/operator/SIGNING_KEY/llamenos-release.key)

Store as `MINISIGN_KEY`.

```bash
cd "${RELEASE_WORK}"

# Sign each release artifact (not .sig files from CI — those are Tauri updater sigs)
for artifact in *.app.tar.gz *.AppImage *.nsis.zip *.deb *.flatpak *.dmg; do
  [ -f "$artifact" ] || continue
  echo "Signing: ${artifact}"
  minisign -S -s "${MINISIGN_KEY}" -m "${artifact}" \
    -t "llamenos v${VERSION} — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "  Created: ${artifact}.minisig"
done

# Also sign CHECKSUMS.txt
minisign -S -s "${MINISIGN_KEY}" -m CHECKSUMS.txt \
  -t "llamenos v${VERSION} checksums — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Signed CHECKSUMS.txt"
```

**Verification gate:** For each signed artifact, verify the signature:

```bash
# Read the public key from tauri.conf.json (base64-encoded minisign pubkey)
PUBKEY_B64=$(jq -r '.plugins.updater.pubkey' apps/desktop/tauri.conf.json)
# Decode it — it's a minisign public key in the standard format
echo "${PUBKEY_B64}" | base64 -d > "${RELEASE_WORK}/llamenos-release.pub"

# Verify every .minisig
VERIFY_FAILED=0
for sig in "${RELEASE_WORK}"/*.minisig; do
  artifact="${sig%.minisig}"
  if minisign -V -p "${RELEASE_WORK}/llamenos-release.pub" -m "${artifact}"; then
    echo "  VERIFIED: $(basename "${artifact}")"
  else
    echo "  FAILED: $(basename "${artifact}")"
    VERIFY_FAILED=1
  fi
done

if [ "$VERIFY_FAILED" -ne 0 ]; then
  echo "FATAL: One or more signatures failed verification. Aborting."
  exit 1
fi
echo "All signatures verified."
```

**If ANY signature verification fails, STOP.** Report the specific file that failed.

### Windows Authenticode (Optional)

If the operator has a Windows EV code signing certificate on a YubiKey:

```bash
# Only if osslsigncode is available and the operator confirms they have an EV cert
if command -v osslsigncode &>/dev/null; then
  echo "Windows Authenticode signing available."
  # Ask operator if they want to Authenticode-sign the Windows installer
  # osslsigncode sign -pkcs11engine /usr/lib/engines-3/pkcs11.so \
  #   -pkcs11module /usr/lib/libykcs11.so \
  #   -n "Llamenos Hotline" -t http://timestamp.digicert.com \
  #   -in "${RELEASE_WORK}/llamenos_${VERSION}_x64-setup.nsis.zip" \
  #   -out "${RELEASE_WORK}/llamenos_${VERSION}_x64-setup-signed.nsis.zip"
fi
```

Ask the operator if they want to perform Authenticode signing. If they decline, note it and proceed.

## Step 4: Promote to Release Bucket

**Gate:** All signatures verified in Step 3.

```bash
# Upload signed artifacts + .minisig files to the release path
aws s3 cp "${RELEASE_WORK}/" "s3://${RUSTFS_BUCKET}/releases/v${VERSION}/" \
  --endpoint-url "${RUSTFS_ENDPOINT}" \
  --recursive \
  --exclude "*.pub" \
  --exclude ".DS_Store"

echo "Uploaded to s3://${RUSTFS_BUCKET}/releases/v${VERSION}/"

# List what was uploaded for operator confirmation
aws s3 ls "s3://${RUSTFS_BUCKET}/releases/v${VERSION}/" \
  --endpoint-url "${RUSTFS_ENDPOINT}"
```

Show the uploaded file listing to the operator and confirm.

## Step 5: Generate Tauri Updater Manifest

**Gate:** Release artifacts uploaded.

Use the existing `scripts/generate-update-manifest.ts` to generate `latest.json`:

```bash
# Generate latest.json using the TypeScript manifest generator
# It reads .sig files (Tauri updater signatures) from the artifacts directory
bun run scripts/generate-update-manifest.ts \
  --version "${VERSION}" \
  --notes "Desktop v${VERSION}" \
  --output "${RELEASE_WORK}/latest.json" \
  --sig-dir "${RELEASE_WORK}" \
  --url-base "https://updates.llamenos.org/desktop/releases/v${VERSION}"
```

**Verification gate:** Validate the generated manifest:

```bash
# Validate latest.json structure
jq -e '.version' "${RELEASE_WORK}/latest.json" > /dev/null
jq -e '.platforms["darwin-aarch64"].signature' "${RELEASE_WORK}/latest.json" > /dev/null
jq -e '.platforms["linux-x86_64"].signature' "${RELEASE_WORK}/latest.json" > /dev/null

# Check version matches
MANIFEST_VERSION=$(jq -r '.version' "${RELEASE_WORK}/latest.json")
if [ "${MANIFEST_VERSION}" != "${VERSION}" ]; then
  echo "FATAL: Manifest version '${MANIFEST_VERSION}' != expected '${VERSION}'"
  exit 1
fi

# Check that all platform signatures are non-empty
for platform in darwin-aarch64 darwin-x86_64 linux-x86_64 windows-x86_64; do
  SIG=$(jq -r ".platforms[\"${platform}\"].signature // empty" "${RELEASE_WORK}/latest.json")
  if [ -z "$SIG" ]; then
    echo "WARNING: No signature for ${platform} in latest.json"
  else
    echo "  ${platform}: signature present (${#SIG} chars)"
  fi
done

echo "Manifest validation passed."
cat "${RELEASE_WORK}/latest.json"
```

**If version mismatch or no platform entries, STOP.**

Upload the manifest:

```bash
# Upload latest.json to the release-specific path AND the canonical updater path
aws s3 cp "${RELEASE_WORK}/latest.json" \
  "s3://${RUSTFS_BUCKET}/releases/v${VERSION}/latest.json" \
  --endpoint-url "${RUSTFS_ENDPOINT}" \
  --content-type "application/json"

aws s3 cp "${RELEASE_WORK}/latest.json" \
  "s3://${RUSTFS_BUCKET}/releases/latest.json" \
  --endpoint-url "${RUSTFS_ENDPOINT}" \
  --content-type "application/json"

echo "latest.json uploaded to both release-specific and canonical paths."
```

## Step 6: Commit to Audit Repository

**Gate:** Manifest uploaded.

Ask the operator:
> Where is your local clone of the `llamenos-releases` audit repo? (e.g., ~/projects/llamenos-releases)

Store as `AUDIT_REPO`.

```bash
cd "${AUDIT_REPO}"
git pull --ff-only origin main

# Create version directory
mkdir -p "v${VERSION}"

# Copy checksums, signatures, and manifest
cp "${RELEASE_WORK}/CHECKSUMS.txt" "v${VERSION}/"
cp "${RELEASE_WORK}/CHECKSUMS.txt.minisig" "v${VERSION}/"
cp "${RELEASE_WORK}/latest.json" "v${VERSION}/"
cp "${RELEASE_WORK}"/*.minisig "v${VERSION}/"

# Generate a release summary
cat > "v${VERSION}/RELEASE.md" << RELEASE_EOF
# Llamenos v${VERSION}

**Released:** $(date -u +%Y-%m-%dT%H:%M:%SZ)
**Signed by:** $(minisign -V -p "${RELEASE_WORK}/llamenos-release.pub" -m "${RELEASE_WORK}/CHECKSUMS.txt" 2>&1 | grep "comment:" | sed 's/.*comment: //')

## Artifacts

$(ls -lh "${RELEASE_WORK}" | grep -v '\.pub$' | grep -v total)

## Verification

\`\`\`bash
# Verify checksums signature
minisign -V -p llamenos-release.pub -m v${VERSION}/CHECKSUMS.txt

# Verify individual artifact
minisign -V -p llamenos-release.pub -m <artifact-file>
\`\`\`
RELEASE_EOF

# Commit and tag
git add "v${VERSION}/"
git commit -m "release: v${VERSION} — signed checksums and manifest

Artifacts signed with minisign Ed25519.
Reproducible build verified via scripts/verify-build.sh.
Tauri updater manifest at releases/latest.json."

git tag -a "v${VERSION}" -m "Llamenos Desktop v${VERSION}"

echo "Committed and tagged v${VERSION} in audit repo."
echo "Review the commit before pushing:"
git log --oneline -1
git diff HEAD~1 --stat
```

Ask the operator to review the commit, then:

```bash
cd "${AUDIT_REPO}"
git push origin main
git push origin "v${VERSION}"
echo "Pushed to llamenos-releases."
```

## Step 7: Verify Live Endpoint

**Gate:** Audit repo pushed.

```bash
# Fetch the live updater manifest
LIVE_MANIFEST=$(curl -sSf "https://updates.llamenos.org/desktop/latest.json")

if [ $? -ne 0 ]; then
  echo "FATAL: Could not fetch https://updates.llamenos.org/desktop/latest.json"
  echo "Check DNS, Caddy config, and RustFS proxy."
  exit 1
fi

# Compare version
LIVE_VERSION=$(echo "${LIVE_MANIFEST}" | jq -r '.version')
if [ "${LIVE_VERSION}" != "${VERSION}" ]; then
  echo "FATAL: Live manifest version '${LIVE_VERSION}' != expected '${VERSION}'"
  echo "The upload may not have propagated, or Caddy is caching a stale response."
  echo "Check: aws s3 cp s3://${RUSTFS_BUCKET}/releases/latest.json - --endpoint-url ${RUSTFS_ENDPOINT} | jq .version"
  exit 1
fi

# Compare full manifest content
LOCAL_HASH=$(jq -cS '.' "${RELEASE_WORK}/latest.json" | sha256sum | cut -d' ' -f1)
LIVE_HASH=$(echo "${LIVE_MANIFEST}" | jq -cS '.' | sha256sum | cut -d' ' -f1)

if [ "${LOCAL_HASH}" != "${LIVE_HASH}" ]; then
  echo "WARNING: Live manifest content differs from local. Comparing..."
  diff <(jq -cS '.' "${RELEASE_WORK}/latest.json") <(echo "${LIVE_MANIFEST}" | jq -cS '.') || true
  echo "This may be due to pub_date differences. Verify platform URLs and signatures match."
else
  echo "VERIFIED: Live manifest matches local manifest exactly."
fi

# Also check the GitHub releases fallback endpoint
GITHUB_MANIFEST=$(curl -sSfL "https://github.com/Llamenos-Hotline/llamenos-platform/releases/latest/download/latest.json" 2>/dev/null || echo "")
if [ -n "${GITHUB_MANIFEST}" ]; then
  GH_VERSION=$(echo "${GITHUB_MANIFEST}" | jq -r '.version // empty')
  echo "GitHub releases fallback: version ${GH_VERSION:-'not found'}"
else
  echo "NOTE: GitHub releases fallback not yet updated (upload via gh release upload if needed)."
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  RELEASE v${VERSION} COMPLETE"
echo "═══════════════════════════════════════════════════"
echo ""
echo "  RustFS:    s3://${RUSTFS_BUCKET}/releases/v${VERSION}/"
echo "  Updater:   https://updates.llamenos.org/desktop/latest.json"
echo "  Audit:     llamenos-releases repo tagged v${VERSION}"
echo "  GitHub:    https://github.com/Llamenos-Hotline/llamenos-platform/releases/tag/v${VERSION}"
echo ""
```

## Cleanup

After successful verification:

```bash
# Remove the temporary work directory
rm -rf "${RELEASE_WORK}"
echo "Cleaned up ${RELEASE_WORK}"
```

## Key Rotation

If the operator needs to rotate the minisign signing key:

1. Generate a new key: `minisign -G -s new-llamenos-release.key -p new-llamenos-release.pub`
2. Update `apps/desktop/tauri.conf.json` → `plugins.updater.pubkey` with the base64-encoded new public key
3. Commit and release a version with the NEW pubkey (clients fetch this update using the OLD key)
4. All subsequent releases use the new key
5. Document the rotation in the `llamenos-releases` audit repo
6. Securely destroy the old private key after confirming the transition release was accepted by clients

**The transition release is critical:** it must be signed with the OLD key but contain the NEW pubkey. Clients verify the transition release with the old key, then use the new key for future updates.

## Error Recovery

- **Step 1 fails (no artifacts):** CI build didn't upload to staging. Check `tauri-release.yml` workflow run.
- **Step 2 fails (verify-build.sh):** Build is not reproducible. Do NOT sign. Investigate the CI build environment.
- **Step 3 fails (signing):** Wrong key or corrupted key file. Verify key with `minisign -V`.
- **Step 4 fails (upload):** Check RustFS credentials and network. Retry is safe.
- **Step 5 fails (manifest):** Missing `.sig` files from CI. Re-download from GitHub Releases.
- **Step 7 fails (live check):** CDN/proxy cache. Check Caddy config, try `curl --no-cache`.
