#!/usr/bin/env bash
#
# Installs Ubuntu-archive packages on a GitHub-hosted runner with a hard
# wall-clock bound on every network phase, and names the cause when it fails.
#
#   bash scripts/ci/apt-install-bounded.sh <package>...
#
# WHY THIS EXISTS (#2545)
# -----------------------
# `desktop-rust` ran `sudo apt-get update && sudo apt-get install -y <tauri
# deps>` with no bound of its own. Five times in two days the step sat until the
# job's 30-minute `timeout-minutes` killed it. The log of the 2026-11-06 20:58Z
# occurrence (job 128149982896) shows what it was doing: not a lock and not a
# dead connection, but `azure.archive.ubuntu.com` delivering ~40 KB/s —
# libjavascriptcoregtk-4.1-0 (8.1 MB) took 205 s, and 30 minutes bought 169 of
# 180 packages out of 67.7 MB. A trickle never trips apt's own connection
# timeouts (bytes keep arriving), so nothing short of the job ceiling ended it.
# Healthy runs of the same step take 21-34 s.
#
# And because GitHub reports a `timeout-minutes` overrun as `cancelled`, every
# occurrence read like a deliberate dequeue: nothing in the log named a cause,
# and someone had to call the jobs API and count steps to tell them apart.
#
# WHAT IT DOES
# ------------
# 1. Network phase — `apt-get update` + `apt-get install --download-only` —
#    under a wall-clock budget (APT_DOWNLOAD_BUDGET_SEC, default 150 s; a
#    healthy runner needs ~10 s). Attempt 1 uses the runner's own sources (its
#    `mirror+file:` list, Azure mirror first).
# 2. If attempt 1 stalls or hits a network error, attempt 2 points apt at the
#    canonical archive (archive.ubuntu.com + security.ubuntu.com) instead,
#    under the same budget. That is a different backend from the Azure mirror,
#    so one throttled mirror cannot fail the step on its own. Whatever attempt
#    1 already fetched stays in apt's archive cache and is not fetched again.
#    It is NOT a retry of the same thing: a package-set error (unknown
#    package, unmet dependency) fails immediately, because a second mirror
#    cannot fix it.
# 3. Install phase — `apt-get install --no-download` — is purely local (dpkg),
#    under its own budget (APT_INSTALL_BUDGET_SEC, default 180 s).
#
# Worst case, every phase hitting its budget plus timeout's 15 s kill grace:
# 165 + 165 + 195 = 525 s (8 min 45 s). The workflow step adds a
# `timeout-minutes` backstop just above that in case this script itself
# misbehaves. The package set and install semantics (recommends included) are
# exactly what the step installed before; only the bounding changed.
#
# Every failure ends with a `::error title=...::` annotation that says which
# phase, which mirror, how much of the download had arrived and at what rate,
# and whether it is infrastructure (re-run) or a real defect in the step.
#
# SCOPE
# -----
# Only for packages that come from the Ubuntu archive itself: attempt 2
# replaces ALL apt sources with the archive's, so a package from a third-party
# repo (k6, packages.microsoft.com) would be "not found" there.

set -euo pipefail

DOWNLOAD_BUDGET="${APT_DOWNLOAD_BUDGET_SEC:-150}"
INSTALL_BUDGET="${APT_INSTALL_BUDGET_SEC:-180}"
KILL_GRACE=15
# Overridable only so the test can run on a machine without the keyring.
KEYRING="${APT_FALLBACK_KEYRING:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}"
STEP="${APT_STEP_NAME:-Install Linux deps}"

# GitHub workflow commands: a property value (title=) ENDS at the first comma
# or colon unless they are %-escaped, and data needs %, CR and LF escaped. The
# first CI run of this script showed it — "apt mirror stall (infrastructure,
# not a test ...)" was cut to "apt mirror stall (infrastructure".
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
# annotate <error|warning> <title> <message>
annotate() {
  printf '::%s title=%s::%s\n' "$1" "$(gh_escape_prop "$2")" "$(gh_escape_data "$3")"
}

if [ "$#" -eq 0 ]; then
  annotate error "${STEP} — no packages given" "usage: apt-install-bounded.sh <package>..." >&2
  exit 2
fi
PACKAGES=("$@")

SUDO=()
[ "$(id -u)" -eq 0 ] || SUDO=(sudo)

WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/apt-bounded.XXXXXX")"
chmod 755 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# Options common to every apt invocation. Lock::Timeout makes a held dpkg lock
# wait (inside the budget) instead of failing instantly; the HTTP timeouts end a
# connection that goes fully silent. Neither catches a trickle — the budget does.
COMMON_OPTS=(
  -o DPkg::Lock::Timeout=60
  -o Acquire::http::Timeout=30
  -o Acquire::https::Timeout=30
  -o Acquire::Retries=2
)

# Attempt-specific source options, set by use_*_sources.
SOURCE_OPTS=()
SOURCE_LABEL=""

use_runner_sources() {
  SOURCE_OPTS=()
  SOURCE_LABEL="runner sources ($(mirror_hosts))"
}

use_archive_sources() {
  local codename
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  if [ -z "$codename" ] || [ ! -r "$KEYRING" ]; then
    echo "cannot build the archive fallback: codename='${codename}' keyring='${KEYRING}' (readable: $([ -r "$KEYRING" ] && echo yes || echo no))" >&2
    return 1
  fi
  mkdir -p "$WORK/sources.list.d"
  cat >"$WORK/sources.list.d/archive.sources" <<EOF
Types: deb
URIs: http://archive.ubuntu.com/ubuntu
Suites: ${codename} ${codename}-updates ${codename}-backports
Components: main restricted universe multiverse
Signed-By: ${KEYRING}

Types: deb
URIs: http://security.ubuntu.com/ubuntu
Suites: ${codename}-security
Components: main restricted universe multiverse
Signed-By: ${KEYRING}
EOF
  chmod 755 "$WORK/sources.list.d"
  chmod 644 "$WORK/sources.list.d/archive.sources"
  SOURCE_OPTS=(
    -o "Dir::Etc::SourceList=/dev/null"
    -o "Dir::Etc::SourceParts=$WORK/sources.list.d"
  )
  SOURCE_LABEL="canonical archive (archive.ubuntu.com, security.ubuntu.com)"
}

# The hosts the runner's own sources resolve to, for the failure message.
mirror_hosts() {
  local hosts
  hosts="$( { cat /etc/apt/apt-mirrors.txt 2>/dev/null; cat /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null; } \
    | grep -vE '^[[:space:]]*#' | grep -oE 'https?://[^/ 	]+' | sed -E 's#https?://##' | sort -u | paste -sd, - || true)"
  echo "${hosts:-unknown}"
}

# Human-readable byte count.
human() {
  awk -v b="$1" 'BEGIN { split("B kB MB GB", u, " "); i = 1; while (b >= 1000 && i < 4) { b /= 1000; i++ } printf (i == 1 ? "%d %s" : "%.1f %s"), b, u[i] }'
}

# Bytes of every archive `Get:` line except the last, which is the one that
# was still in flight when the budget expired. apt prints `Get:` as a fetch
# STARTS, so the completed total is all of them but the final one. It is an
# estimate (apt fetches from several hosts in parallel), and is reported as
# one: its job is to show "stalled at 2 MB of 68" versus "nearly done". Only lines
# after "Need to get" count: the index fetches of `apt-get update` before it
# are not part of the download that line sizes. If apt never got that far, the
# index fetches are all there is, so they are counted instead.
completed_bytes() {
  local scope=archives
  grep -q '^Need to get ' "$1" || scope=indexes
  awk -v scope="$scope" '
    /^Need to get / { counting = 1; have = 0; total = 0; next }
    (scope == "indexes" || counting) && /^Get:[0-9]+ https?:\/\// && /\[[0-9.]+ [kMG]?B\]/ {
      match($0, /\[[0-9.]+ [kMG]?B\]/); s = substr($0, RSTART + 1, RLENGTH - 2)
      split(s, p, " "); v = p[1]; u = p[2]
      m = (u == "kB" ? 1e3 : u == "MB" ? 1e6 : u == "GB" ? 1e9 : 1)
      if (have) total += last
      last = v * m; have = 1
    }
    END { printf "%d", total }' "$1"
}

# "Need to get 67.7 MB of archives." -> bytes, or empty if apt never got that far.
needed_bytes() {
  awk '/^Need to get / {
      v = $4; u = $5; sub(/\/.*/, "", u)
      m = (u == "kB" ? 1e3 : u == "MB" ? 1e6 : u == "GB" ? 1e9 : 1)
      printf "%d", v * m; exit }' "$1"
}

last_fetch() {
  grep -E '^Get:[0-9]+ https?://' "$1" | tail -n 1 | sed -E 's/^Get:[0-9]+ //' || true
}

# Run one bounded apt command, streaming its output to the job log AND to $log.
# Returns apt's exit status, or 124/137 when the budget expired.
# Call as `bounded ... || rc=$?` — pipefail makes the pipeline's status the
# command's own, never tee's.
bounded() {
  local budget="$1" log="$2"
  shift 2
  "${SUDO[@]}" timeout --kill-after="$KILL_GRACE" "$budget" "$@" 2>&1 | tee -a "$log"
}

# A failure no other mirror can fix: the package set itself does not resolve.
is_package_set_error() {
  grep -qE 'Unable to locate package|has no installation candidate|unmet dependencies|Unmet dependencies|held broken packages' "$1"
}

ATTEMPT_REPORTS=()

# Network phase for one source configuration. 0 = everything downloaded.
download_attempt() {
  local n="$1" log="$WORK/attempt-$1.log" started elapsed rc what why
  : >"$log"
  echo "::group::${STEP} — attempt ${n}: ${SOURCE_LABEL}, network budget ${DOWNLOAD_BUDGET}s"
  started=$(date +%s)
  rc=0
  bounded "$DOWNLOAD_BUDGET" "$log" bash -c '
    apt-get "$@" update --error-on=any \
      && apt-get "$@" install -y --download-only '"$(printf '%q ' "${PACKAGES[@]}")"'
  ' _ "${COMMON_OPTS[@]}" "${SOURCE_OPTS[@]}" || rc=$?
  elapsed=$(( $(date +%s) - started ))
  echo "::endgroup::"

  if [ "$rc" -eq 0 ]; then
    echo "${STEP}: attempt ${n} (${SOURCE_LABEL}) downloaded everything in ${elapsed}s."
    return 0
  fi

  if is_package_set_error "$log"; then
    why="$(grep -m1 -E '^E: ' "$log" || echo 'apt could not resolve the package set')"
    annotate error "${STEP} — the package set does not resolve (a real defect in this step, not a mirror problem)" \
      "${why} — attempt ${n}, ${SOURCE_LABEL}. A different mirror cannot fix this; the package list or the runner image changed."
    exit 1
  fi

  local done_b need_b rate inflight of
  done_b="$(completed_bytes "$log")"
  need_b="$(needed_bytes "$log")"
  rate=$(( elapsed > 0 ? done_b / elapsed : 0 ))
  inflight="$(last_fetch "$log")"
  of="<download size never reported — stalled in apt-get update>"
  [ -z "$need_b" ] || of="$(human "$need_b")"
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    what="STALLED — budget of ${DOWNLOAD_BUDGET}s expired"
  else
    what="network error (apt exit ${rc}: $(grep -m1 -E '^(E|Err):' "$log" | cut -c1-200 || true))"
  fi
  ATTEMPT_REPORTS+=("attempt ${n}, ${SOURCE_LABEL}: ${what}; ≈$(human "$done_b") fetched of ${of} in ${elapsed}s (≈$(human "$rate")/s)${inflight:+; in flight: ${inflight}}")
  echo "${STEP}: ${ATTEMPT_REPORTS[-1]}"
  return 1
}

# ── network phase ──────────────────────────────────────────────────────────────
ok=""
use_runner_sources
if download_attempt 1; then
  ok=1
elif use_archive_sources && download_attempt 2; then
  ok=1
  annotate warning "${STEP} — the runner's apt mirror failed; installed from the canonical archive instead" "${ATTEMPT_REPORTS[0]}"
fi

if [ -z "$ok" ]; then
  summary="$(printf '%s | ' "${ATTEMPT_REPORTS[@]}")"
  summary="${summary% | }"
  annotate error "${STEP} — apt mirror stall (infrastructure, not a test or build result)" \
    "${summary}. No test ran. Re-run the job unchanged; this PR did not cause it (#2545)."
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### ${STEP}: apt mirror stall — infrastructure, not a test or build result"
      echo
      for r in "${ATTEMPT_REPORTS[@]}"; do echo "- ${r}"; done
      echo
      echo "No test ran. Re-run the job unchanged (#2545)."
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 1
fi

# ── install phase (local only) ─────────────────────────────────────────────────
log="$WORK/install.log"
: >"$log"
started=$(date +%s)
rc=0
bounded "$INSTALL_BUDGET" "$log" apt-get "${COMMON_OPTS[@]}" "${SOURCE_OPTS[@]}" \
  install -y --no-download "${PACKAGES[@]}" || rc=$?
elapsed=$(( $(date +%s) - started ))
if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
  annotate error "${STEP} — dpkg install exceeded its ${INSTALL_BUDGET}s budget (infrastructure, not a test or build result)" \
    "Every package was already downloaded; the local install did not finish in ${elapsed}s. Last line: $(tail -n 1 "$log" | cut -c1-200). Re-run the job unchanged (#2545)."
  exit 1
elif [ "$rc" -ne 0 ]; then
  annotate error "${STEP} — apt-get install failed (exit ${rc})" \
    "$(grep -m1 -E '^(E|dpkg):' "$log" | cut -c1-300 || tail -n 1 "$log")"
  exit "$rc"
fi
echo "${STEP}: installed ${#PACKAGES[@]} requested package(s) in ${elapsed}s (${SOURCE_LABEL})."
