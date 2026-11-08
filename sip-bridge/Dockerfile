# Set by BuildKit to the architecture being built (amd64/arm64); selects the
# per-architecture runtime stage at the bottom (see "simdutf kernel pin").
ARG TARGETARCH

# Builder and runtime are the same Bun release, pinned to the same image and
# digest as deploy/docker/Dockerfile's `deps` stage and independently of
# .mise.toml's dev/CI tool pin (see that stage for why the two may diverge).
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

# Copy source code (exclude test files via .dockerignore)
COPY src/ src/
COPY tsconfig.json tsconfig.build.json ./

# Type check (build config excludes test files)
RUN bunx tsc --noEmit --project tsconfig.build.json

# Build
RUN bun build src/index.ts --outdir dist --target bun

# Debian archive state: the cache key for the security upgrade below. Same
# mechanism as deploy/docker/Dockerfile's `debian-archive-state` stage (#2564):
# a cached `apt-get upgrade` layer never re-runs, so the mount of these signed
# release files is what makes it re-run when Debian publishes a fix.
FROM scratch AS debian-archive-state
ADD https://deb.debian.org/debian/dists/trixie/InRelease /trixie.InRelease
ADD https://deb.debian.org/debian/dists/trixie-updates/InRelease /trixie-updates.InRelease
ADD https://deb.debian.org/debian-security/dists/trixie-security/InRelease /trixie-security.InRelease

# Production stage.
#
# Bun verifies TLS against the root store compiled into the binary and never
# consults the container's /etc/ssl bundle (which the 1.3.5 base did not even
# have), so the Bun release IS the bridge's outbound trust store — for WORKER_WEBHOOK_URL, ARI and
# the Kamailio JSON-RPC whenever an operator points them at https://. 1.3.5
# still trusted emSign ECC Root CA - G3 and accepted chains through the eMudhra
# intermediates whose private keys were disclosed on 2026-10-20 (#2582); 1.4.4
# drops that root and refuses those chains as revoked. Dependabot watches this
# directory (.github/dependabot.yml); scripts/check-image-trust-store.sh is what
# verifies the result.
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS runtime-base
WORKDIR /app

# Outstanding Debian security updates on top of the pinned base, as in
# deploy/docker/Dockerfile's app-base, plus espeak-ng for local TTS support
# (used when TTS_ENGINE=espeak).
RUN --mount=type=bind,from=debian-archive-state,target=/run/debian-archive-state \
    . /etc/os-release \
    && { [ "$VERSION_CODENAME" = trixie ] \
         || { echo "base is Debian $VERSION_CODENAME; update the debian-archive-state suites" >&2; exit 1; }; } \
    && apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends espeak-ng \
    && rm -rf /var/lib/apt/lists/*

COPY --from=base /app/dist/ dist/
COPY --from=base /app/package.json ./

# Shared environment variables (set at runtime)
ENV PBX_TYPE=asterisk
ENV BRIDGE_HOST=0.0.0.0
ENV BRIDGE_PORT=3000

# Asterisk defaults (override at runtime for other PBX types)
ENV ARI_URL=ws://asterisk:8088/ari/events
ENV ARI_REST_URL=http://asterisk:8088/ari
ENV ARI_USERNAME=llamenos
# ARI_PASSWORD must be set at runtime — no default (CWE-798)

# FreeSWITCH defaults (used when PBX_TYPE=freeswitch)
ENV ESL_HOST=freeswitch
ENV ESL_PORT=8021
# ESL_PASSWORD must be set at runtime

# Kamailio defaults (used when PBX_TYPE=kamailio)
ENV KAMAILIO_JSONRPC_URL=http://kamailio:5060/jsonrpc

# Worker/bridge secrets — must be set at runtime
# WORKER_WEBHOOK_URL=http://app:3000
# BRIDGE_SECRET=<random>

ENV STASIS_APP=llamenos

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["bun", "run", "dist/index.js"]

# simdutf kernel pin: Bun >= 1.4 picks its base64/UTF-8 kernel from CPUID and
# ships no scalar fallback, so on a VPS whose virtual CPU model hides SSE4.2
# (kvm64/qemu64) base64 and non-ASCII text silently come back empty — the
# BRIDGE_SECRET HMAC and every webhook body among them. Same pin, same
# reasoning and same exit condition as the "simdutf kernel pin" block in
# deploy/docker/Dockerfile.
FROM runtime-base AS runtime-amd64
ENV SIMDUTF_FORCE_IMPLEMENTATION=westmere

FROM runtime-base AS runtime-arm64

FROM runtime-${TARGETARCH}
