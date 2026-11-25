#!/usr/bin/env bash
#
# Proves, BEFORE the emulator boots, that `connectedDebugAndroidTest` resolves
# nothing from the network (#2971).
#
#   bash scripts/ci/assert-connected-test-offline.sh        # run from apps/android
#
# WHY: android-e2e lost merge groups to Maven Central answering 429 for
# `protobuf-java` while the emulator step resolved AGP's Unified Test Platform
# classpath (`_internal-unified-test-platform-*`). That configuration is resolved
# only when `connectedDebugAndroidTest` itself starts, so nothing earlier had put
# it in the Gradle cache, and the request went to Central from a runner address
# GitHub's hosted pool shares with every other Actions user. Retrying a per-IP
# throttle does not help. The only fix that does is to make no request at all: the
# earlier, retried, cached step primes the set (resolveConnectedTestDependencies,
# scripts/ci/gradle-resolve-connected-test.init.gradle.kts), and THIS script is the
# check that it did, so the claim is verified on every run instead of assumed.
#
# HOW: `gradlew --offline connectedDebugAndroidTest` with no device attached. Task
# inputs (the UTP classpaths) resolve before the task runs, and the task then stops
# at "No connected devices!". With --offline Gradle will not open a socket, so:
#
#   * a configuration that is not in the cache fails with "No cached version of ...
#     available for offline mode" / "Could not resolve all files" -> this script
#     FAILS and names it;
#   * everything cached gets as far as "No connected devices!" -> PASS.
#
# A failure for any OTHER reason also fails: a check that cannot see the thing it
# checks must not pass. The same mode runs the real emulator step (ci.yml), so a
# dependency that slips past this check still cannot reach the network there.
#
# Resolution failures are recognised with the shared list the retry wrapper and the
# CI classifier read (gradle-resolution.patterns) plus Gradle's offline-mode wording.
#
#   GRADLE_BIN        the gradle launcher            (default ./gradlew)
#   ANDROID_BUILD_DIR the app build dir              (default app/build)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GRADLE_BIN="${GRADLE_BIN:-./gradlew}"
PATTERNS="${GRADLE_RESOLUTION_PATTERNS:-$HERE/gradle-resolution.patterns}"
BUILD_DIR="${ANDROID_BUILD_DIR:-app/build}"
[ -s "$PATTERNS" ] || { echo "assert-connected-test-offline: pattern file ${PATTERNS} is missing or empty" >&2; exit 2; }

fail() { # $1 title, $2 body
  echo "::error title=$1::$2"
  echo "assert-connected-test-offline: $1 — $2" >&2
  exit 1
}

# The no-device run creates these (empty) result directories. The classifier reads
# the same directories after the REAL run, so leave nothing of ours behind.
OURS=()
for d in "$BUILD_DIR/outputs/androidTest-results" "$BUILD_DIR/reports/androidTests"; do
  [ -e "$d" ] || OURS+=("$d")
done

log="$(mktemp "${RUNNER_TEMP:-/tmp}/connected-offline.XXXXXX")"
trap 'rm -f "$log"; for d in "${OURS[@]:-}"; do [ -n "$d" ] && rm -rf "$d"; done' EXIT

"$GRADLE_BIN" --offline connectedDebugAndroidTest --console=plain >"$log" 2>&1
rc=$?
cat "$log"

if grep -qE 'available for offline mode' "$log" || grep -qE -f "$PATTERNS" "$log"; then
  miss="$(grep -m1 -E 'available for offline mode|Could not (find|resolve|GET|HEAD|download|get resource) ' "$log" | sed -E 's/^[[:space:]>*-]+//' | cut -c1-240)"
  cfg="$(grep -m1 -oE "configuration '[^']+'" "$log" || true)"
  fail "connectedDebugAndroidTest needs the network" \
    "it could not resolve from the Gradle cache alone (${cfg:-no configuration named}; ${miss:-see the log}). Whatever it asked for must be resolved by resolveConnectedTestDependencies in the earlier, retried step; otherwise the emulator step requests it from Maven Central."
fi

if [ "$rc" -eq 0 ] || grep -q 'No connected devices' "$log"; then
  echo "assert-connected-test-offline: connectedDebugAndroidTest resolved everything from the Gradle cache (no network)."
  exit 0
fi
fail "offline check inconclusive" "Gradle exited ${rc} for a reason that is neither a resolution failure nor 'No connected devices'; it did not demonstrably get past dependency resolution."
