# Debian archive state: the cache key for the security upgrade below. Same
# mechanism as deploy/docker/Dockerfile's `debian-archive-state` stage (#2564):
# a cached `apt-get upgrade` layer never re-runs, so the mount of these signed
# release files is what makes it re-run when Debian publishes a fix.
FROM scratch AS debian-archive-state
ADD https://deb.debian.org/debian/dists/trixie/InRelease /trixie.InRelease
ADD https://deb.debian.org/debian/dists/trixie-updates/InRelease /trixie-updates.InRelease
ADD https://deb.debian.org/debian-security/dists/trixie-security/InRelease /trixie-security.InRelease

# oven/bun:1.3.5-slim digest pinned to match .mise.toml — update via scripts/update-image-digests.sh
FROM oven/bun:1.3.5-slim@sha256:6111acec4c5a703f2069d6e681967c047920ff2883e7e5a5e64f4ac95ddeb27f
# Outstanding Debian security updates on top of the pinned base, as in
# deploy/docker/Dockerfile's app-base.
RUN --mount=type=bind,from=debian-archive-state,target=/run/debian-archive-state \
    . /etc/os-release \
    && { [ "$VERSION_CODENAME" = trixie ] \
         || { echo "base is Debian $VERSION_CODENAME; update the debian-archive-state suites" >&2; exit 1; }; } \
    && apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
EXPOSE 3100
CMD ["bun", "run", "src/index.ts"]
