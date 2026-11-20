#!/usr/bin/env bash
#
# Runs a Gradle invocation and survives a transient dependency-registry failure,
# without ever retrying a real build, test or lint failure.
#
#   bash scripts/ci/gradle-retry.sh <gradle args...>      # run from apps/android
#
# WHY THIS EXISTS (#2864)
# -----------------------
# Merge group run 44432600870 ejected four PRs because Maven Central answered a
# single `junit-4.13.2.pom` lookup with "not found":
#
#   > Could not find junit:junit:4.13.2.
#       - https://dl.google.com/dl/android/maven2/junit/junit/4.13.2/junit-4.13.2.pom
#       - https://repo.maven.apache.org/maven2/junit/junit/4.13.2/junit-4.13.2.pom
#       - https://download.linphone.org/maven_repository/junit/junit/4.13.2/junit-4.13.2.pom
#
# junit 4.13.2 has been on Central since 2021, and the next group — same base,
# formed minutes later — passed untouched. `max_entries_to_build` is 1, so the
# cost is strictly serial: every ejection pushes every ready PR back by a group,
# and this one landed after ~an hour of Mac time on the iOS gate.
#
# WHY THIS SCRIPT IS NOT THE WHOLE ANSWER (#2879)
# ------------------------------------------------
# A merge group's ref is not the default branch, so setup-gradle restores
# read-only, and the only cache it can restore is the one a default-branch build
# wrote. That used to be CodeQL's `compileDebugKotlin`, which never resolves
# `debugUnitTestRuntimeClasspath` (junit arrives there, transitively via
# androidx.compose.ui:ui-test-junit4), so every group cold-fetched the unit-test
# graph from Maven Central — and on 2026-11-19, with two groups building at once
# from one egress address, Central answered 429 on all three attempts of run
# 44629546088 and ejected #2854.
#
# Retrying cannot fix that: the defect is the NUMBER of requests, not their
# spacing. The fix is android-cache-warm.yml, which runs the same Gradle tasks as
# android-build-test on the default branch so the cache a group restores already
# holds the whole graph. This script only makes a residual miss survivable —
# and, for a 429, stops making it worse (see WHY A 429 IS HANDLED DIFFERENTLY).
#
# WHY A 429 IS HANDLED DIFFERENTLY (#2879)
# ----------------------------------------
# Gradle's own repository retry (max.retries=6, initial.backoff=500ms) is right
# for a 5xx or a timeout: the server is flaky, ask again soon. A 429 is the
# server explicitly asking us to slow down, and across the hundreds of artifacts
# of a graph, six half-second retries each RAISE our request rate at exactly the
# wrong moment. So once an attempt has been answered with a 429, every later
# attempt runs with a small Gradle retry budget and a long initial backoff, and
# the delay between attempts is the (much longer) rate-limit one.
#
# WHY RETRY THE WHOLE INVOCATION
# ------------------------------
# Gradle already retries 5xx and timeouts on its own (org.gradle.internal.repository
# .max.retries, default 3, which this script raises). It does NOT retry a 404:
# that is an authoritative "this repository does not have it", and fails the
# build on the spot. So the retry has to live above Gradle.
#
# WHY A PLAIN RE-RUN IS NOT ENOUGH AFTER A 404 (#2866)
# ----------------------------------------------------
# Gradle remembers that "not found" in the GRADLE_USER_HOME a re-run reuses, and
# does not ask the registry again. The first version of this script retried with
# a plain re-run, on the strength of a test where a repository 404'd a POM once;
# a JAR miss behaves differently. Measured against Gradle 9.4.0 with a repository
# that 404s `lib-1.0.jar` exactly ONCE and then serves it:
#
#   run 1  > Could not find lib-1.0.jar (org.ex:lib:1.0).     (the one 404)
#   run 2  > Could not find lib-1.0.jar (org.ex:lib:1.0).     (the server saw NO request)
#   run 3  > Could not find lib-1.0.jar (org.ex:lib:1.0).     (nor this one)
#   run 4  --refresh-dependencies   RESOLVED                  (and a plain run after it too)
#
# That is the shape PR #2866 hit: five runtime-only legacy jars
# (kotlin-parcelize-runtime-1.9.22, gson-2.8.9, tink-android-1.8.0, ...) all
# "Could not find", identically, on all three attempts, the later ones failing in
# seconds. settings.gradle.kts was untouched and every one of those jars is on
# Central; the same cache restore passed on a sibling PR minutes earlier.
#
# A PARTIALLY RESTORED cache (module metadata intact, some files-2.1 jars gone) is
# not a separate case, measured against the same Gradle 9.4.0 (#2871): with a live
# registry Gradle notices the missing file and re-downloads it even on a plain run,
# so that state alone never produces "Could not find"; the failure needs the
# registry to miss the jar too, and then it is the remembered-miss case above —
# attempt 1 "Could not find", attempt 2 with --refresh-dependencies re-downloads
# the jar and resolves. Discarding the restored Gradle home is not needed.
#
# So once an attempt fails with an authoritative "Could not find", every later
# attempt runs with --refresh-dependencies, which drops the remembered miss. It
# is NOT used for a transport error (timeout, reset, DNS): Gradle does not cache
# those, a plain re-run recovers them (the DNS blip in the first #2864 run did
# exactly that), and --refresh-dependencies revalidates every module in the
# restored cache — hundreds of requests to the registry that just blipped. The
# first attempt never refreshes, so a green build costs nothing extra.
#
# WHAT IS RETRIED
# ---------------
# Only a failure whose Gradle output names a resolution/transport error
# (gradle-resolution.patterns). A compile error, a failing test, a lint finding
# and a Gradle configuration error all exit non-zero WITHOUT matching it and are
# returned immediately, after exactly one run, with Gradle's own exit status.
# A genuinely missing dependency (a typo in libs.versions.toml) also matches, is
# retried GRADLE_RETRY_ATTEMPTS times, and then fails — the final annotation says
# it persisted across every attempt, which is how it is told from a blip. The
# cost of that is two backoffs, not a hang.
#
# WHAT IS VISIBLE
# ---------------
# A retry that recovers is NOT silent: it emits a `::warning` naming the
# dependency that failed and writes a step-summary block, so a registry that is
# flaking every day shows up as a pattern instead of a clean green.
#
# KNOBS (environment)
#   GRADLE_BIN               the gradle launcher        (default ./gradlew)
#   GRADLE_RETRY_ATTEMPTS    total runs, first included (default 3)
#   GRADLE_RETRY_BACKOFF_SEC base delay, doubles        (default 20 -> 20s, 40s)
#   GRADLE_REPO_MAX_RETRIES  Gradle's own HTTP retries  (default 6)
#   GRADLE_RATE_LIMIT_BACKOFF_SEC  base delay after a 429 (default 90 -> 90s, 180s)
#   GRADLE_RATE_LIMIT_REPO_MAX_RETRIES  Gradle's own HTTP retries once a 429
#                            has been seen              (default 2)
#
# Exit status: the final Gradle run's own status.

set -uo pipefail

GRADLE_BIN="${GRADLE_BIN:-./gradlew}"
ATTEMPTS="${GRADLE_RETRY_ATTEMPTS:-3}"
BACKOFF="${GRADLE_RETRY_BACKOFF_SEC:-20}"
REPO_RETRIES="${GRADLE_REPO_MAX_RETRIES:-6}"
RATE_BACKOFF="${GRADLE_RATE_LIMIT_BACKOFF_SEC:-90}"
RATE_REPO_RETRIES="${GRADLE_RATE_LIMIT_REPO_MAX_RETRIES:-2}"
REPO_INITIAL_BACKOFF_MS=500
RATE_REPO_INITIAL_BACKOFF_MS=5000

# What counts as a resolution/transport failure, and which of those Gradle
# REMEMBERS, live in two pattern files beside this script (one ERE per line) so
# that .github/scripts/classify-infra-failure.py reads the very same lists
# (#2870). Deliberately specific: a bare "Could not" would also match "Could not
# compile", which is a real error. Never inline a copy of either list here or
# anywhere else: three implementations that disagree is how android-e2e came to
# call a missed gson jar "not an infrastructure signature".
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESOLUTION_PATTERNS="${GRADLE_RESOLUTION_PATTERNS:-$HERE/gradle-resolution.patterns}"
CACHED_MISS_PATTERNS="${GRADLE_CACHED_MISS_PATTERNS:-$HERE/gradle-cached-miss.patterns}"
for f in "$RESOLUTION_PATTERNS" "$CACHED_MISS_PATTERNS"; do
  [ -s "$f" ] || { echo "gradle-retry: pattern file ${f} is missing or empty" >&2; exit 2; }
done

gh_escape_data() {
  local s="$1"
  s="${s//'%'/%25}"; s="${s//$'\r'/%0D}"; s="${s//$'\n'/%0A}"
  printf '%s' "$s"
}
gh_escape_prop() {
  local s
  s="$(gh_escape_data "$1")"
  s="${s//:/%3A}"; s="${s//,/%2C}"
  printf '%s' "$s"
}
annotate() {
  printf '::%s title=%s::%s\n' "$1" "$(gh_escape_prop "$2")" "$(gh_escape_data "$3")"
}

if [ "$#" -eq 0 ]; then
  annotate error "gradle-retry — no Gradle arguments given" "usage: gradle-retry.sh <gradle args...>" >&2
  exit 2
fi
case "$ATTEMPTS" in ''|*[!0-9]*|0) echo "GRADLE_RETRY_ATTEMPTS must be a positive integer (got '${ATTEMPTS}')" >&2; exit 2 ;; esac

WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/gradle-retry.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# The most specific resolution error, for the annotation: what Gradle could not
# find or fetch, before the generic "Could not resolve all files" wrapper.
first_failure() {
  { grep -m1 -E 'Could not (find|GET|HEAD|download|get resource) |timed out|reset|refused|status code' "$1" \
      || grep -m1 -E -f "$RESOLUTION_PATTERNS" "$1"; } | sed -E 's/^[[:space:]>*-]+//' | cut -c1-240
}

REPORTS=()
REFRESH=()   # becomes (--refresh-dependencies) once a remembered "Could not find" is suspected
RATE_LIMITED=0   # becomes 1 once any attempt was answered with a 429 (#2879)
rc=0
for attempt in $(seq 1 "$ATTEMPTS"); do
  log="$WORK/attempt-${attempt}.log"
  echo "::group::gradle-retry — attempt ${attempt}/${ATTEMPTS}: ${GRADLE_BIN} ${REFRESH[*]:-} $*"
  echo "::endgroup::"
  rc=0
  "$GRADLE_BIN" \
    "-Dorg.gradle.internal.repository.max.retries=${REPO_RETRIES}" \
    "-Dorg.gradle.internal.repository.initial.backoff=${REPO_INITIAL_BACKOFF_MS}" \
    ${REFRESH[@]+"${REFRESH[@]}"} \
    "$@" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}

  if [ "$rc" -eq 0 ]; then
    if [ "${#REPORTS[@]}" -gt 0 ]; then
      annotate warning "Gradle dependency resolution recovered on attempt ${attempt} (transient registry failure, #2864)" \
        "$(printf '%s | ' "${REPORTS[@]}")The retry succeeded, so the registry — not this change — was the problem. If this appears daily, the registry/mirror order needs attention."
      if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        {
          echo "### Gradle dependency resolution: transient failure survived (#2864)"
          echo
          for r in "${REPORTS[@]}"; do echo "- ${r}"; done
          echo "- attempt ${attempt}: succeeded"
        } >>"$GITHUB_STEP_SUMMARY"
      fi
    fi
    exit 0
  fi

  if ! grep -qE -f "$RESOLUTION_PATTERNS" "$log"; then
    # Not a registry problem: a compile error, a failing test, a lint finding.
    # Retrying would only hide a flake or double the time to a real failure.
    echo "gradle-retry: Gradle exited ${rc} with no dependency-resolution error — not retrying."
    exit "$rc"
  fi

  REPORTS+=("attempt ${attempt}: $(first_failure "$log")")
  # An authoritative miss is what Gradle remembers; only that needs the refresh.
  if [ "${#REFRESH[@]}" -eq 0 ] && grep -qE -f "$CACHED_MISS_PATTERNS" "$log"; then
    REFRESH=(--refresh-dependencies)
  fi
  # The registry told us to slow down. Back off hard, and stop Gradle's own
  # per-artifact retries from multiplying the very request rate being limited.
  if grep -qE 'Received status code 429' "$log"; then
    RATE_LIMITED=1
    REPO_RETRIES="$RATE_REPO_RETRIES"
    REPO_INITIAL_BACKOFF_MS="$RATE_REPO_INITIAL_BACKOFF_MS"
  fi
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    base="$BACKOFF"
    [ "$RATE_LIMITED" -eq 1 ] && base="$RATE_BACKOFF"
    delay=$(( base * (1 << (attempt - 1)) ))
    echo "gradle-retry: dependency resolution failed (attempt ${attempt}/${ATTEMPTS}): $(first_failure "$log")"
    [ "$RATE_LIMITED" -eq 1 ] && echo "gradle-retry: the registry answered 429 Too Many Requests — Gradle's own HTTP retries are cut to ${REPO_RETRIES} (initial backoff ${REPO_INITIAL_BACKOFF_MS}ms) and the delay base is ${base}s, so this does not add to the request rate being limited."
    echo "gradle-retry: retrying in ${delay}s${REFRESH[*]:+ with ${REFRESH[*]} (Gradle remembers a 'Could not find'; a plain re-run would not ask the registry again)}."
    sleep "$delay"
  fi
done

annotate error "Gradle dependency resolution failed on all ${ATTEMPTS} attempts (a persistent miss, not a blip)" \
  "$(printf '%s | ' "${REPORTS[@]}")The same dependency failed to resolve after backoff, so a registry blip is unlikely: check the version in the catalog and the repositories in settings.gradle.kts."
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Gradle dependency resolution failed on every attempt (#2864)"
    echo
    for r in "${REPORTS[@]}"; do echo "- ${r}"; done
  } >>"$GITHUB_STEP_SUMMARY"
fi
exit "$rc"
