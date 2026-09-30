# Multi-stage Dockerfile for Llamenos (Bun self-hosted mode)
#
# Builds:
#   Stage 1: Install JS dependencies
#   Stage 2: Build Rust crypto library (.so) for bun:ffi
#   Stage 3 (`app`): Production image (API-only — desktop clients connect to this);
#     `app-base` plus a per-arch runtime pin (`app-amd64` / `app-arm64`)
#   Stage 4-6 (`static`): Caddy image for docker-compose.production.yml's
#     `caddy` service (built SPA + custom rate-limiting Caddy binary)
#
# EVERY consumer of this file MUST pass an explicit stage (`--target` /
# compose `build.target` / build-push-action `target:`). Docker builds the
# LAST stage when none is given, and that is `static` (Caddy) — not `app`.
# Call sites: deploy/docker/docker-compose.yml (app), docker-compose.production.yml
# (caddy), .github/workflows/{docker,release,ci,security-audit}.yml.
#
# Bun runs TypeScript natively — no esbuild transpilation step needed.

# Set automatically by BuildKit to the architecture being built (amd64/arm64).
# Declared in global scope so the `app` alias stage below can select the
# per-architecture runtime variant (see "simdutf kernel pin").
ARG TARGETARCH

# Stage 1: Install runtime deps
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS deps
# This runtime base is pinned independently of .mise.toml's `bun = "1.3.5"`.
# .mise.toml pins the *developer/CI tool* version (kept in sync with
# .github/workflows/ci.yml's bun-version input); this image is the
# *production container* base and tracks its own Dependabot-driven minor
# bumps on its own schedule. The two are allowed to diverge — Bun's runtime
# compatibility across 1.3.x/1.4.x minors is not the same contract as "CI
# uses the same tool version everywhere". Update via Dependabot or on a new
# minor release.
WORKDIR /app
COPY package.json bun.lockb ./
# Copy workspace package.json stubs so bun can resolve the workspace graph from the
# lockfile. Without these, --frozen-lockfile fails because the lockfile references
# workspace packages. Without the lockfile, some @aws-sdk versions freshly downloaded
# from npm carry workspace:^ refs for @smithy deps, which fail to resolve in a non-monorepo
# Docker context. Using --frozen-lockfile with these stubs avoids re-resolution entirely.
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/test-specs/package.json packages/test-specs/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY site/package.json site/package.json
RUN bun install --frozen-lockfile --production --ignore-scripts

# Stage 2: Build Rust crypto FFI (.so)
FROM rust:1-slim@sha256:f47a8de237dcbb0b0ce1099901e60a89728e3d51f24e664b40e947171538ade7 AS rust-builder
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY packages/crypto/ packages/crypto/
RUN cargo build --release --manifest-path packages/crypto/Cargo.toml --features server \
    && mkdir -p packages/crypto/dist/server \
    && cp packages/crypto/target/release/libllamenos_core.so packages/crypto/dist/server/

# Stage 3: Production
FROM oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS app-base
# Pinned independently of .mise.toml's dev/CI `bun = "1.3.5"` — see the
# `deps` stage comment above for why the two are allowed to diverge. Update
# via Dependabot.

# Apply outstanding Debian security updates on top of the pinned base.
# The base digest above is the newest published for the `1.4.0-slim` tag, so a
# digest bump cannot pick these up: when Debian publishes a security update the
# upstream image lags it, and security-audit.yml's image-scan gate (fail on
# FIXABLE CRITICAL) goes red on a base the tag can't move off. Upgrading here
# rebases onto the current debian-security archive (this landed for perl-base
# 5.40.1-6 → 5.40.1-6+deb13u1: CVE-2026-13221, CVE-2026-42496, CVE-2026-8376).
#
# espeak-ng is the one package added: the worker speaks every IVR prompt an
# operator did not upload on the self-hosted PBXs (IvrSpeechService, #1347),
# offline, in 19 of the shipped locales. ~30 MB; no recommends (no audio
# output devices — it only ever writes WAV to a pipe).
RUN apt-get update && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends espeak-ng \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r llamenos && useradd -r -g llamenos -d /app -s /sbin/nologin llamenos

WORKDIR /app

# Copy runtime dependencies with correct ownership
COPY --chown=llamenos:llamenos package.json ./
COPY --chown=llamenos:llamenos --from=deps /app/node_modules/ node_modules/

# Copy source with correct ownership (Bun runs TS directly — no bundled output)
COPY --chown=llamenos:llamenos src/ src/
COPY --chown=llamenos:llamenos apps/worker/ apps/worker/
COPY --chown=llamenos:llamenos packages/shared/ packages/shared/
COPY --chown=llamenos:llamenos packages/i18n/ packages/i18n/
COPY --chown=llamenos:llamenos packages/protocol/ packages/protocol/
COPY --chown=llamenos:llamenos packages/crypto/package.json packages/crypto/package.json
COPY --chown=llamenos:llamenos packages/crypto/ffi.ts packages/crypto/ffi.ts
COPY --chown=llamenos:llamenos tsconfig.json ./

# Copy native crypto library from Rust build with correct ownership
COPY --chown=llamenos:llamenos --from=rust-builder /build/packages/crypto/dist/server/libllamenos_core.so packages/crypto/dist/server/

# Copy Drizzle SQL migrations + migration runner with correct ownership
COPY --chown=llamenos:llamenos drizzle/migrations/ drizzle/migrations/
COPY --chown=llamenos:llamenos scripts/run-migrations.ts scripts/run-migrations.ts
# Startup invariant check for Bun's native text layer (run by the entrypoint)
COPY --chown=llamenos:llamenos scripts/verify-runtime.ts scripts/verify-runtime.ts

# Copy entrypoint (runs migrations then starts the app)
COPY --chown=llamenos:llamenos deploy/docker/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Serve a minimal download page for browsers hitting the root URL
COPY --chown=llamenos:llamenos deploy/docker/download-page/ public/

# Switch to non-root user
USER llamenos

# Environment defaults
ENV PLATFORM=bun \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD bun -e "fetch('http://localhost:3000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD []

# ── simdutf kernel pin (amd64) ────────────────────────────────────────────
# Bun >= 1.4.0 bundles simdutf 9.0.0 for all base64 / UTF-8 work — including
# Bun.SQL's SCRAM-SHA-256 client proof, Buffer, TextDecoder and JSON. simdutf
# picks its SIMD kernel from CPUID, and Bun's x64 build ships NO scalar
# fallback kernel. On a VM whose virtual CPU model hides SSE4.2 in CPUID
# (`kvm64`/`qemu64`, still the default CPU model on many KVM/Proxmox/OpenStack
# VPS hosts) the hardware still executes SSE4.2 — so Bun itself starts — but
# simdutf finds no usable kernel and falls back to its "unsupported" stub,
# whose operations return 0 / empty. The observed result: an empty SCRAM proof
# (PostgreSQL: "Malformed proof in client-final-message"), base64 encodes that
# never return (the entrypoint hangs at "Running database migrations..."), and
# non-ASCII strings silently decoded as "".
#
# Forcing the SSE4.2 (`westmere`) kernel is safe on every host this image can
# run on: Bun 1.4's own x64 build executes SSE4.2 unconditionally at startup,
# so a CPU that cannot run the westmere kernel cannot run Bun at all. The cost
# on hosts with honest CPUID is using the SSE4.2 kernel instead of AVX2/AVX-512
# for text/base64 — negligible at this service's request sizes. It is set as
# image ENV (not in the entrypoint) so that EVERY bun process in the container
# gets it: the HEALTHCHECK, `docker exec … bun …` admin commands, and the app.
#
# arm64 is unaffected (simdutf treats NEON as always present), so arm64 images
# get no override. scripts/verify-runtime.ts (run by the entrypoint) fails the
# container loudly if the text layer is ever broken again — e.g. a future Bun
# renaming the `westmere` kernel — and scripts/image-smoke.sh exercises the
# built image on a CPUID-masked KVM guest before every release.
#
# Exit condition: drop this override once upstream Bun ships simdutf's
# fallback kernel (or otherwise stops selecting the stub on SSE4.2-capable
# CPUs); scripts/image-smoke.sh --cpu kvm64 with the override removed must pass.
FROM app-base AS app-amd64
ENV SIMDUTF_FORCE_IMPLEMENTATION=westmere

FROM app-base AS app-arm64

# The target every consumer builds (`--target app` / compose `target: app`).
FROM app-${TARGETARCH} AS app

# ─────────────────────────────────────────────────────────────────────────
# Stages below build the `static` target consumed by
# docker-compose.production.yml's `caddy` service (Tier 4 split-origin
# Caddy: see deploy/docker/Caddyfile.production).

# Stage 4: Install full JS deps (incl. devDependencies) for the SPA build.
# Separate from the `deps` stage above, which installs --production only.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS frontend-deps
WORKDIR /app
COPY package.json bun.lockb ./
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/test-specs/package.json packages/test-specs/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY site/package.json site/package.json
RUN bun install --frozen-lockfile --ignore-scripts

# Stage 5: Build the SPA (Vite) served at /srv/app by the `static` image.
# The client imports Zod schemas straight from packages/protocol/schemas
# (via the @protocol alias) — no protocol codegen step is required for
# this build, unlike the native (iOS/Android) clients.
FROM frontend-deps AS frontend-builder
COPY index.html vite.config.ts tsconfig.json ./
COPY public/ public/
COPY src/client/ src/client/
COPY packages/shared/ packages/shared/
COPY packages/i18n/ packages/i18n/
COPY packages/protocol/ packages/protocol/
ARG BUILD_VERSION=dev
ARG BUILD_COMMIT=local
ARG BUILD_TIME=
ENV GITHUB_SHA=${BUILD_COMMIT}
RUN bun run build

# Stage 6: Custom Caddy binary with the caddy-ratelimit plugin.
# Caddyfile.production's `rate_limit` directive (auth/register throttling —
# see CLAUDE.md's "Call spam mitigation" / network-level rate limiting
# requirement) is NOT part of stock Caddy; it ships only via this plugin,
# built with xcaddy. Without this stage Caddy refuses to start with
# "unrecognized directive: rate_limit".
# Digest bump (issue #650, 2026-09-20): refreshes the Alpine package layer
# (curl/c-ares/libcrypto3/libssl3 CVEs) under the same 2.11.4 tag — same Caddy
# version, no behavior change. See the `static` stage below for the matching bump.
FROM caddy:2.11.4-builder-alpine@sha256:2b9f32cbba6045e79212bb253f595588d20be8f7d1edf61582c519e124e0d2d8 AS caddy-builder
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

# Stage 7 (`static`): Caddy image serving the built SPA. Matches the
# `caddy:2.11.4-alpine` base pinned in docker-compose.yml, with the custom
# rate-limiting binary swapped in and the SPA baked into /srv/app.
# Digest bump (issue #650, 2026-09-20): see caddy-builder stage above — same
# tag, refreshed Alpine layer. Trivy re-scan of this stage went from 23 fixable
# HIGH (curl/c-ares/libcrypto3/libssl3) to 0 on the OS layer; the xcaddy-built
# binary's own Go-module HIGH findings (golang.org/x/*, grpc) are unaffected by
# this bump — they come from the Caddy 2.11.4 release's resolved dependency set,
# not the Alpine base, and need a Caddy version bump to clear (follow-up, needs
# Caddyfile.production + caddy-ratelimit plugin compat validation first).
FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b AS static
COPY --from=caddy-builder /usr/bin/caddy /usr/bin/caddy
COPY --from=frontend-builder /app/dist/client /srv/app
# NOTE: /srv/crypto (the Tier-4 sandboxed-crypto-iframe origin referenced by
# Caddyfile.production's {$CRYPTO_DOMAIN} block) is intentionally left
# empty. The crypto-sandbox/ app that's supposed to be baked in here was
# developed on an unmerged branch (commit a294b15a5, "tier 4 PR-B") and
# never landed on main — there is no source in this tree to build. Do not
# fabricate placeholder content: crypto.$CRYPTO_DOMAIN will 404 until that
# app is merged. See the PR that added this comment for full context.
RUN mkdir -p /srv/crypto
