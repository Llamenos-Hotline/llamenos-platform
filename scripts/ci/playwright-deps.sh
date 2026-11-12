#!/usr/bin/env bash
#
# Makes the OS libraries Playwright's chromium needs present, touching the
# network ONLY when something is actually missing.
#
#   bash scripts/ci/playwright-deps.sh
#
# WHY THIS EXISTS (#2736)
# -----------------------
# Every Playwright job ran `bunx playwright install-deps chromium` whenever its
# browser cache hit, under a step named "(cached browsers)". The name promised
# no network; the command always needed it: install-deps shells out to
# `apt-get update` + `apt-get install` against the Ubuntu archive mirrors.
# On 2026-11-11 those hostnames stopped resolving for ~30 minutes ("Temporary
# failure resolving 'archive.ubuntu.com'") and the step failed in all seven
# Playwright jobs of two consecutive merge groups, ejecting #2712 and #2714 from
# the queue (an ejected PR loses its place and needs a human to re-arm it).
# Nothing about the code under test was involved.
#
# WHAT IT DOES
# ------------
# 1. PROBE. `ldd` every cached chromium executable; if no shared library is
#    "not found", the libraries are already on the runner and there is nothing
#    to install. Exit 0 without touching apt. This is what makes a cache hit
#    mean "no network needed". (GitHub-hosted images ship Google Chrome, whose
#    dependencies are a superset of headless chromium's, so this is the normal
#    case.)
# 2. INSTALL, bounded. Only if the probe finds a missing library (or there is
#    no browser to probe): run install-deps with a per-attempt wall-clock
#    budget and a few attempts with backoff.
# 3. NAME THE CAUSE. If every attempt fails, the annotation says the Ubuntu
#    mirror was unreachable and lists the missing libraries — infrastructure,
#    not a test result — so a blip is distinguishable from a real break.
#
# Fonts: install-deps also installs a few fonts. Headless chromium does not
# need them to start, and no test here compares rendered pixels, so a probe
# that skips them is deliberate.
#
# Knobs (tests shrink them): PLAYWRIGHT_BROWSERS_PATH, PW_DEPS_ATTEMPTS,
# PW_DEPS_ATTEMPT_BUDGET_SEC, PW_DEPS_BACKOFF_SEC (space separated, one per
# retry gap), PW_DEPS_INSTALL_CMD.

set -euo pipefail

BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
ATTEMPTS="${PW_DEPS_ATTEMPTS:-3}"
BUDGET="${PW_DEPS_ATTEMPT_BUDGET_SEC:-120}"
BACKOFF="${PW_DEPS_BACKOFF_SEC:-10 30}"
INSTALL_CMD="${PW_DEPS_INSTALL_CMD:-bunx playwright install-deps chromium}"
STEP="Install Playwright OS deps"

gh_escape_data() { local s="$1"; s="${s//'%'/%25}"; s="${s//$'\r'/%0D}"; s="${s//$'\n'/%0A}"; printf '%s' "$s"; }
gh_escape_prop() { local s; s="$(gh_escape_data "$1")"; s="${s//:/%3A}"; s="${s//,/%2C}"; printf '%s' "$s"; }
annotate() { printf '::%s title=%s::%s\n' "$1" "$(gh_escape_prop "$2")" "$(gh_escape_data "$3")"; }

# Probe every cached chromium executable. Sets PROBED to how many were checked and
# MISSING to the distinct shared libraries ldd reports "not found" (empty when all
# resolve). Sets globals rather than printing: a command substitution would lose PROBED.
PROBED=0
MISSING=""
probe() {
  local bin out all=""
  local bins=()
  if [ -d "$BROWSERS" ]; then
    while IFS= read -r bin; do bins+=("$bin"); done < <(
      find "$BROWSERS" -maxdepth 4 -type f \( -name chrome -o -name headless_shell -o -name chrome-headless-shell \) \
        -path '*chromium*' 2>/dev/null | sort)
  fi
  PROBED=${#bins[@]}
  for bin in "${bins[@]}"; do
    # ldd exits non-zero for a static/non-ELF file; treat that as "nothing missing".
    out="$(ldd "$bin" 2>&1 | grep 'not found' || true)"
    [ -z "$out" ] || all+="$out"$'\n'
  done
  MISSING="$(printf '%s' "$all" | awk 'NF { print $1 }' | sort -u)"
}

probe
if [ "$PROBED" -gt 0 ] && [ -z "$MISSING" ]; then
  echo "${STEP}: all shared libraries of ${PROBED} cached chromium executable(s) already resolve — nothing to install, no network used."
  exit 0
fi

if [ "$PROBED" -eq 0 ]; then
  reason="no cached chromium executable under ${BROWSERS} to probe"
else
  reason="missing shared libraries: $(echo "$MISSING" | paste -sd' ' -)"
fi
echo "${STEP}: ${reason}; running '${INSTALL_CMD}' (${ATTEMPTS} attempt(s), ${BUDGET}s each)."

read -r -a gaps <<<"$BACKOFF"
rc=0
for ((n = 1; n <= ATTEMPTS; n++)); do
  echo "::group::${STEP} — attempt ${n}/${ATTEMPTS}"
  rc=0
  # shellcheck disable=SC2086  # INSTALL_CMD is a command line on purpose
  timeout --kill-after=15 "$BUDGET" $INSTALL_CMD || rc=$?
  echo "::endgroup::"
  if [ "$rc" -eq 0 ]; then
    echo "${STEP}: installed on attempt ${n}."
    exit 0
  fi
  echo "${STEP}: attempt ${n} failed (exit ${rc})."
  if [ "$n" -lt "$ATTEMPTS" ]; then
    gap="${gaps[$((n - 1))]:-${gaps[${#gaps[@]} - 1]:-10}}"
    echo "${STEP}: backing off ${gap}s before attempt $((n + 1))."
    sleep "$gap"
  fi
done

msg="'${INSTALL_CMD}' failed ${ATTEMPTS} times (last exit ${rc}; $( [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ] && echo "budget of ${BUDGET}s expired" || echo "apt error")). Probe: ${reason}. The Ubuntu package mirrors were unreachable or too slow — this is a runner-network problem, not a test or build result and not caused by this PR. Re-run the job unchanged (#2736)."
annotate error "${STEP} — Ubuntu apt mirror unreachable (infrastructure, not a test result)" "$msg"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### ${STEP}: Ubuntu apt mirror unreachable — infrastructure, not a test result"; echo; echo "$msg"; } >>"$GITHUB_STEP_SUMMARY"
fi
exit 1
