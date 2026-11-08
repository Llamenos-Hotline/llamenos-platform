FROM oven/bun:1.3.5@sha256:e90cdbaf9ccdb3d4bd693aa335c3310a6004286a880f62f79b18f9b1312a8ec3 AS base
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

# Production stage
FROM oven/bun:1.3.5@sha256:e90cdbaf9ccdb3d4bd693aa335c3310a6004286a880f62f79b18f9b1312a8ec3
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
