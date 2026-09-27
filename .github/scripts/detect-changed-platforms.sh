#!/usr/bin/env bash
# Classifies a list of changed files into the platform/scope flags CI uses to
# decide which jobs a PR's changes actually need.
#
# This is the SINGLE source of truth for the platform path map. Before this
# script existed, the same map was maintained independently in three places
# that had already drifted from each other: ci.yml's `changes` job (an
# `android` regex only), desktop-e2e.yml's `on.pull_request.paths:` list, and
# ios-e2e.yml's own `ios_related` regex. Extending or fixing platform scope
# happens HERE, once — every workflow that needs it calls this script instead
# of re-deriving its own copy (see #664).
#
# Usage: printf '%s\n' "$CHANGED_FILES" | detect-changed-platforms.sh
# Reads the changed-file list (one path per line) from stdin. Emits one
# `key=value` line per flag on stdout — safe to redirect straight into
# $GITHUB_OUTPUT, or to capture and parse in a test.
set -euo pipefail

CHANGED_FILES=$(cat)

# Any file under one of these paths is reachable from every platform's build
# — a change here must run every platform's tests, not just whichever tree
# it happens to live in. Deliberately narrower than "everything that isn't
# docs": apps/worker/** (backend) is NOT here — it is its own `backend`
# platform below — so a pure backend change no longer drags in Android/iOS
# builds the way the old per-workflow regexes did (that coupling was part of
# the over-triggering #664 exists to fix).
#
# .github/scripts/detect-changed-platforms.sh (this file) is included here
# too: it is the single thing that decides every other flag below, so a
# change to it gets the same "run everything" treatment as ci.yml itself —
# anything narrower risks a broken rewrite of this script shipping with its
# own blast radius silently gated to `false`.
SHARED_DEPS_RE='^(packages/crypto/|packages/protocol/|packages/shared/|packages/i18n/|package\.json$|bun\.lock|\.mise\.toml$|tsconfig[^/]*\.json$|vitest[^/]*\.config\.ts$|scripts/|\.github/workflows/ci\.yml$|\.github/scripts/detect-changed-platforms\.sh$)'

IOS_RE='^apps/ios/'
# Which iOS TIER a diff earns (see apps/ios/Tests/UI/ci-smoke.txt for the full
# rationale). `ios` above stays a blast-radius flag — it is `true` for every
# SHARED_DEPS_RE hit, because a change under scripts/ or package.json cannot be
# proven harmless to iOS and must never gate iOS to `false`. But only a diff
# that can actually change the iOS BINARY deserves all 326 tests: apps/ios/
# itself, the three packages whose codegen/FFI output is compiled into the app
# (crypto -> UniFFI XCFramework, protocol -> Swift types, i18n -> .strings),
# and the CI wiring that decides any of this. Everything else runs the smoke
# tier: still a real iOS gate, 2 runners instead of 4.
IOS_FULL_RE='^(apps/ios/|packages/crypto/|packages/protocol/|packages/i18n/|\.github/workflows/ci\.yml$|\.github/workflows/ios-e2e\.yml$|\.github/scripts/detect-changed-platforms\.sh$)'
ANDROID_RE='^apps/android/'
DESKTOP_RE='^(apps/desktop/|src/client/|tests/)'
# Carved out of DESKTOP_RE's blanket `tests/` prefix: directories under tests/
# that are NOT desktop e2e. Without this, `ci.yml`'s `e2e` job
# (`if: desktop == 'true' || backend == 'true'`) runs four Playwright shards,
# E2E (Linux) and a Docker Compose stack for changes that cannot affect either.
# On 2026-09-27 this was the sole reason #1164 — an orchestrator-only PR — sat
# blocked on `ci-status`.
#
# Two independent sources agree these are not e2e, and this list must not drift
# from either:
#   - `playwright.config.ts`'s desktop project already carries
#     `testIgnore: ["**/live/**", …, "**/orchestrator/**", "**/*.test.ts"]`.
#     Playwright does not run them; the filter should not schedule a job for them.
#   - `tests/load` (k6), `tests/iso-builder` and `tests/eslint` are referenced by
#     no job in ci.yml at all.
#
# Deliberately NOT excluded: `tests/desktop/` (feeds desktop-unit), `tests/steps/`,
# `tests/mocks/`, `tests/pages/`, `tests/fixtures/` and the root `*.spec.ts`
# files — all genuinely e2e or its infrastructure.
#
# This stays an EXCLUDE list rather than becoming an include list on purpose.
# An include list makes "a new test directory gates nothing" the default, which
# is the same silent-non-execution failure this repo already has three open
# issues for (#1126, #1153, #1167). Excluding fails toward running too much,
# which costs minutes; including fails toward running nothing, which costs a
# regression nobody sees.
#
# Checked as a separate expression rather than folded into DESKTOP_RE because
# these are POSIX ERE (`grep -E`), which has no negative lookahead.
DESKTOP_EXCLUDE_RE='^tests/(orchestrator|live|load|iso-builder|eslint)/'
# src/server/ is the actual Bun server entry point (`bun run build:server`,
# and the image `docker compose ... up --build` produces for e2e/backend-bdd/
# android-e2e) — it lives outside apps/worker/ but is exactly as
# backend-relevant. drizzle/ (migration files + snapshots) and
# drizzle.config.ts are the literal inputs `bun run migration:check` (the
# migration-drift job) diffs, and backend-bdd applies these migrations via
# the bootstrapped backend — both need the `backend` flag, not just
# migration-drift. tests/steps/backend/ is backend-bdd's own step
# definitions (playwright.config.ts's `backend-bdd` project points its
# `steps` glob there specifically, distinct from the desktop `bdd` project's
# steps) — already caught by the blanket `tests/` prefix below for the
# `desktop` flag, but backend-bdd itself only gates on `backend`, so it needs
# its own hit here too.
BACKEND_RE='^(apps/worker/|sip-bridge/|signal-notifier/|deploy/docker/|src/server/|drizzle/|drizzle\.config\.ts$|tests/steps/backend/)'
CRYPTO_RE='^packages/crypto/'
ANSIBLE_RE='^deploy/ansible/'
# Dependency manifests only — deliberately narrower than SHARED_DEPS_RE: a
# docs- or workflow-only PR must not be blocked by a dependency advisory it
# could not possibly have introduced.
AUDIT_RE='^(package\.json$|bun\.lock)'
# The fleet orchestrator has no backend/DB dependency and its safety-rail
# tests run inside the backend-unit job (see that job's own comment in
# ci.yml) — its own source and tests must gate that job too, independent of
# the `backend` flag.
ORCHESTRATOR_RE='^(orchestrator/|tests/orchestrator/|vitest\.orchestrator\.config\.ts$)'
# The cross-platform BDD feature corpus (packages/test-specs/features/**)
# and the one composite action every backend-bootstrapping job shares
# (.github/actions/bootstrap-backend) — both are read directly by ci.yml's
# `e2e` (desktop bdd + backend-bdd Playwright projects), `backend-bdd`, and
# `android-e2e` (collects `packages/test-specs/features/platform/mobile/**`
# into androidTest assets) jobs, and by desktop-e2e.yml's own `test` job
# (also bootstraps via the same action). None of the three platform-specific
# regexes above would catch either path on its own, so a change here sets
# `desktop`, `backend`, AND `android` directly rather than relying on one of
# them to coincidentally already be true.
E2E_INFRA_RE='^(packages/test-specs/|\.github/actions/)'
# playwright.config.ts is read directly by ci.yml's `e2e` job and by
# desktop-e2e.yml's `test` job (both invoke `bunx playwright test` against
# it) — not by android/ios, which don't use Playwright at all.
PLAYWRIGHT_CONFIG_RE='^playwright\.config\.ts$'
DOCS_ONLY_EXEMPT_RE='\.md$|^site/'

docs_only=true
ios=false
ios_full=false
android=false
desktop=false
backend=false
crypto=false
ansible=false
audit=false
orchestrator=false

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  if ! echo "$file" | grep -qE "$DOCS_ONLY_EXEMPT_RE"; then
    docs_only=false
  fi

  if echo "$file" | grep -qE "$SHARED_DEPS_RE"; then
    ios=true; android=true; desktop=true; backend=true; crypto=true
    echo "Shared-dependency file changed: $file" >&2
  fi

  echo "$file" | grep -qE "$IOS_RE" && { ios=true; echo "iOS file changed: $file" >&2; }
  echo "$file" | grep -qE "$IOS_FULL_RE" && { ios=true; ios_full=true; echo "iOS full-tier file changed: $file" >&2; }
  echo "$file" | grep -qE "$ANDROID_RE" && { android=true; echo "Android file changed: $file" >&2; }
  echo "$file" | grep -qE "$DESKTOP_RE" && ! echo "$file" | grep -qE "$DESKTOP_EXCLUDE_RE" \
    && { desktop=true; echo "Desktop file changed: $file" >&2; }
  echo "$file" | grep -qE "$BACKEND_RE" && { backend=true; echo "Backend file changed: $file" >&2; }
  echo "$file" | grep -qE "$CRYPTO_RE" && { crypto=true; echo "Crypto file changed: $file" >&2; }
  echo "$file" | grep -qE "$ANSIBLE_RE" && { ansible=true; echo "Ansible file changed: $file" >&2; }
  echo "$file" | grep -qE "$AUDIT_RE" && { audit=true; echo "Dependency manifest changed: $file" >&2; }
  echo "$file" | grep -qE "$ORCHESTRATOR_RE" && { orchestrator=true; echo "Fleet orchestrator file changed: $file" >&2; }
  echo "$file" | grep -qE "$E2E_INFRA_RE" && { desktop=true; backend=true; android=true; echo "E2E test infra file changed: $file" >&2; }
  echo "$file" | grep -qE "$PLAYWRIGHT_CONFIG_RE" && { desktop=true; backend=true; echo "Playwright config changed: $file" >&2; }
done <<< "$CHANGED_FILES"

app=$([ "$docs_only" = "false" ] && echo true || echo false)

# full > smoke > none. `ios=true` with `ios_full=false` is the blast-radius
# case: iOS is reachable from the diff but cannot have changed the binary.
if [ "$ios_full" = "true" ]; then ios_tier=full
elif [ "$ios" = "true" ]; then ios_tier=smoke
else ios_tier=none
fi

cat <<EOF
docs_only=$docs_only
app=$app
ios=$ios
ios_tier=$ios_tier
android=$android
desktop=$desktop
backend=$backend
crypto=$crypto
ansible=$ansible
audit=$audit
orchestrator=$orchestrator
EOF
