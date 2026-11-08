# Set by BuildKit to the architecture being built (amd64/arm64); selects the
# per-architecture runtime stage at the bottom (see "simdutf kernel pin").
ARG TARGETARCH

# Debian archive state: the cache key for the security upgrade below. Same
# mechanism as deploy/docker/Dockerfile's `debian-archive-state` stage (#2564):
# a cached `apt-get upgrade` layer never re-runs, so the mount of these signed
# release files is what makes it re-run when Debian publishes a fix.
FROM scratch AS debian-archive-state
ADD https://deb.debian.org/debian/dists/trixie/InRelease /trixie.InRelease
ADD https://deb.debian.org/debian/dists/trixie-updates/InRelease /trixie-updates.InRelease
ADD https://deb.debian.org/debian-security/dists/trixie-security/InRelease /trixie-security.InRelease

# The production runtime, pinned to the SAME image and digest as
# deploy/docker/Dockerfile's `app-base` and independently of .mise.toml's
# dev/CI tool pin (see that file's `deps` stage for why the two may diverge).
#
# Bun verifies TLS against the root store compiled into the binary and never
# consults the container's /etc/ssl bundle (which the 1.3.5 base did not even
# have), so the Bun release IS this service's outbound trust store. 1.3.5 still trusted
# emSign ECC Root CA - G3 and accepted chains through the eMudhra intermediates
# whose private keys were disclosed on 2026-10-20 (#2582); 1.4.4 drops that
# root and refuses those chains as revoked. Dependabot watches this directory
# (.github/dependabot.yml) so the runtime — and with it the trust store — keeps
# moving; scripts/check-image-trust-store.sh is what verifies it did.
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS runtime-base
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

# simdutf kernel pin: Bun >= 1.4 picks its base64/UTF-8 kernel from CPUID and
# ships no scalar fallback, so on a VPS whose virtual CPU model hides SSE4.2
# (kvm64/qemu64) every base64 encode returns empty — postgres.js's SCRAM proof
# among them. Same pin, same reasoning and same exit condition as the
# "simdutf kernel pin" block in deploy/docker/Dockerfile.
FROM runtime-base AS runtime-amd64
ENV SIMDUTF_FORCE_IMPLEMENTATION=westmere

FROM runtime-base AS runtime-arm64

FROM runtime-${TARGETARCH}
