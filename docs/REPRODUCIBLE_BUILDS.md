# Reproducible Builds

This document explains how Llamenos achieves reproducible builds and how operators and auditors can verify that released artifacts match the public source code.

**Related documents**:
- [Deployment Hardening](security/DEPLOYMENT_HARDENING.md) — Infrastructure security guidance
- [Threat Model](security/THREAT_MODEL.md#reproducible-builds-as-supply-chain-mitigation) — Supply chain threat analysis
- [Epic 79](epics/epic-79-reproducible-builds.md) — Implementation details

---

## 1. Why Reproducible Builds

Llamenos is a security-critical application deployed to protect vulnerable populations. Operators and auditors need to verify that:

1. The client code served to volunteers is the same code reviewed in the public repository
2. No backdoors, key exfiltration, or weakened cryptography were introduced during the build process
3. The build environment did not inject malicious code

Reproducible builds provide this assurance by ensuring that building the same source code always produces the same output, byte-for-byte.

---

## 2. How It Works

### Deterministic Build Configuration

The build process eliminates all sources of non-determinism:

| Source of Non-Determinism | Mitigation |
|--------------------------|------------|
| Timestamps in output files | `SOURCE_DATE_EPOCH` set to git commit timestamp |
| Random filenames | Vite content-hashed filenames (hash of file content, not random) |
| Dependency versions | `bun.lockb` lockfile with frozen installs (`--frozen-lockfile`) |
| Build tool versions | Pinned in `Dockerfile.build` (specific Bun version) |
| OS-level differences | Docker-based build environment (deterministic base image) |

### Build Artifacts

| Artifact | Deterministic? | How |
|----------|---------------|-----|
| Client JS bundles (`dist/client/assets/*.js`) | Yes | Content-hashed filenames, `SOURCE_DATE_EPOCH` |
| Client CSS bundles (`dist/client/assets/*.css`) | Yes | Content-hashed filenames |
| `index.html` | Yes | References content-hashed assets |
| `CHECKSUMS.txt` | Yes | SHA-256 of all output files |
| Server bundle (Bun) | Yes | Same deterministic config (`dist/server/`) |

---

## 3. Verification

### Automated Verification

```bash
# Verify a specific release version
scripts/verify-build.sh v1.0.0

# Verify latest release
scripts/verify-build.sh

# Skip Docker build — verify signatures only (faster)
SKIP_DOCKER_BUILD=1 scripts/verify-build.sh v1.0.0

# The script:
# 1. Downloads CHECKSUMS.txt + cosign signatures from the llamenos-releases repo
# 2. Verifies cosign keyless signatures (if cosign is installed)
# 3. Verifies SBOM attestation and SLSA provenance (if cosign is installed)
# 4. Clones the source at the tagged version
# 5. Builds inside a Docker container (Dockerfile.build)
# 6. Computes checksums of the local build output
# 7. Compares them — any mismatch is flagged
```

### Manual Verification

If you prefer to verify manually:

```bash
# 1. Check out the specific release
git checkout v1.0.0

# 2. Build in the deterministic Docker environment
docker build -f Dockerfile.build -t llamenos-verify .

# 3. Extract build output from the container
docker create --name llamenos-verify-extract llamenos-verify
docker cp llamenos-verify-extract:/build/dist ./local-dist
docker rm llamenos-verify-extract

# 4. Compute local checksums
(cd local-dist && find . -type f -exec sha256sum {} \; | sort) > local-checksums.txt

# 5. Download the published checksums from the llamenos-releases repo
curl -sL https://raw.githubusercontent.com/Llamenos-Hotline/llamenos-releases/main/desktop/v1.0.0/CHECKSUMS.txt > release-checksums.txt

# 6. Compare
diff local-checksums.txt release-checksums.txt
# No output = match. Any output = mismatch (investigate).
```

---

## 4. Trust Anchor

The trust anchor is the **`llamenos-releases` repository** — specifically the `CHECKSUMS.txt` committed to `desktop/v<version>/CHECKSUMS.txt`. Binary artifacts are hosted on the self-hosted RustFS instance at `releases.llamenos.org`. The GitHub Release contains the metadata (CHECKSUMS.txt, SBOM, provenance) but not the binaries themselves.

### What This Proves

If verification passes, you know:
- The client JS/CSS bundles in the GitHub Release were built from the tagged source code
- No modifications were made to the build output after the build step
- The SLSA provenance attestation confirms the build ran in a specific GitHub Actions workflow

### What This Does NOT Prove

| Limitation | Reason |
|-----------|--------|
| The running server serves these exact files | A compromised server could serve different files |
| The source code is free of vulnerabilities | Reproducible builds verify build integrity, not code quality |
| GitHub Actions was not compromised | CI/CD supply chain is a separate trust boundary |

### Why Not Serve Checksums from the App

The application intentionally does **not** expose a verification endpoint (e.g., `/api/config/verify`). If an attacker controls the server, they could serve fake checksums that match their modified code. The trust anchor must be external to the system being verified.

---

## 5. Scope

### Verified (Client Bundles)

Client JavaScript and CSS bundles are fully verified:
- `dist/client/assets/*.js` — All JavaScript modules
- `dist/client/assets/*.css` — All stylesheets
- `dist/client/index.html` — Entry point HTML

These are the security-critical artifacts — they contain the cryptographic code that handles key management, encryption, and decryption.

### Server Bundle

The Bun server bundle (`dist/server/`) is deterministic and can be verified using the same Docker build process (`Dockerfile.build`). The server is self-hosted (Bun + PostgreSQL on VPS) — there is no Cloudflare Worker deployment for the backend. The Cloudflare deployment (`site/`) is the marketing site only and is not subject to this verification process.

---

## 6. CI Integration

### GitHub Actions Workflow

The release workflow automatically:

1. Sets `SOURCE_DATE_EPOCH` to the tagged commit's timestamp
2. Builds the client using `Dockerfile.build`
3. Generates `CHECKSUMS.txt` with SHA-256 hashes of all output files
4. Attaches `CHECKSUMS.txt` to the GitHub Release
5. Generates SLSA provenance attestation (links the release to the specific workflow run and source commit)

### SLSA Provenance

[SLSA](https://slsa.dev/) (Supply-chain Levels for Software Artifacts) provenance attestation provides:

- **Source**: Which Git commit was built
- **Builder**: Which GitHub Actions workflow ran the build
- **Materials**: Which dependencies were used (from `bun.lockb`)
- **Reproducibility**: Whether the build is deterministic

The attestation is signed by GitHub's Sigstore integration and can be verified using `slsa-verifier`.

---

## 7. For Operators

### When to Verify

- **Before initial deployment**: Verify the release you are deploying
- **Before each update**: Verify the new release before applying
- **After a security incident**: Re-verify to ensure the deployed code was not tampered with

### What to Do If Verification Fails

If `scripts/verify-build.sh` reports a mismatch:

1. **Do not deploy the release** — the build output does not match the source code
2. Check if your local build environment matches the expected Docker image
3. Re-run the verification to rule out transient failures
4. If the mismatch persists, report it as a security issue at security@llamenos.org
5. Deploy a previous verified release while the issue is investigated
