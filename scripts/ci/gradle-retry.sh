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
# Why a warm Gradle cache would NOT have saved it: a merge group's ref is not the
# default branch, so setup-gradle restores read-only, and the only cache it can
# restore is the one a default-branch build wrote — CodeQL's `compileDebugKotlin`.
# That never resolves `debugUnitTestRuntimeClasspath` (junit arrives there,
# transitively via androidx.compose.ui:ui-test-junit4), so the unit-test graph
# is fetched from the network on every group. Nothing here changes that; it
# makes the fetch survivable.
#
# WHY RETRY THE WHOLE INVOCATION
# ------------------------------
# Gradle already retries 5xx and timeouts on its own (org.gradle.internal.repository
# .max.retries, default 3, which this script raises). It does NOT retry a 404:
# that is an authoritative "this repository does not have it", and fails the
# build on the spot. So the retry has to live above Gradle. It is a plain re-run,
# not `--refresh-dependencies`: measured against Gradle 9.4.0 with a repository
# that 404s a POM once, a second ordinary invocation on the SAME cache asks the
# registry again and succeeds, so no cached miss needs discarding — and
# `--refresh-dependencies` would revalidate every module in the restored cache,
# which is hundreds of extra requests to the very registry that just blipped.
#
# WHAT IS RETRIED
# ---------------
# Only a failure whose Gradle output names a resolution/transport error
# (RESOLUTION_PATTERN below). A compile error, a failing test, a lint finding
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
#
# Exit status: the final Gradle run's own status.

set -uo pipefail

GRADLE_BIN="${GRADLE_BIN:-./gradlew}"
ATTEMPTS="${GRADLE_RETRY_ATTEMPTS:-3}"
BACKOFF="${GRADLE_RETRY_BACKOFF_SEC:-20}"
REPO_RETRIES="${GRADLE_REPO_MAX_RETRIES:-6}"

# A transport or resolution failure, as Gradle prints it. Deliberately specific:
# a bare "Could not" would also match "Could not compile", which is a real error.
RESOLUTION_PATTERN='Could not resolve |Could not find |Could not GET |Could not HEAD |Could not download |Could not get resource|Could not resolve all (files|dependencies)|Read timed out|Connect timed out|Connection (reset|refused)|Remote host terminated|Premature end of Content-Length|Received status code 5[0-9][0-9]|Received status code 429|Temporary failure in name resolution|Network is unreachable|UnknownHostException|SSLHandshakeException|Unable to tunnel'

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
      || grep -m1 -E "$RESOLUTION_PATTERN" "$1"; } | sed -E 's/^[[:space:]>*-]+//' | cut -c1-240
}

REPORTS=()
rc=0
for attempt in $(seq 1 "$ATTEMPTS"); do
  log="$WORK/attempt-${attempt}.log"
  echo "::group::gradle-retry — attempt ${attempt}/${ATTEMPTS}: ${GRADLE_BIN} $*"
  echo "::endgroup::"
  rc=0
  "$GRADLE_BIN" \
    "-Dorg.gradle.internal.repository.max.retries=${REPO_RETRIES}" \
    "-Dorg.gradle.internal.repository.initial.backoff=500" \
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

  if ! grep -qE "$RESOLUTION_PATTERN" "$log"; then
    # Not a registry problem: a compile error, a failing test, a lint finding.
    # Retrying would only hide a flake or double the time to a real failure.
    echo "gradle-retry: Gradle exited ${rc} with no dependency-resolution error — not retrying."
    exit "$rc"
  fi

  REPORTS+=("attempt ${attempt}: $(first_failure "$log")")
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    delay=$(( BACKOFF * (1 << (attempt - 1)) ))
    echo "gradle-retry: dependency resolution failed (attempt ${attempt}/${ATTEMPTS}): $(first_failure "$log")"
    echo "gradle-retry: retrying in ${delay}s."
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
