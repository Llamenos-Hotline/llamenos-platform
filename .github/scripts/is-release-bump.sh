#!/usr/bin/env bash
# Decides whether a diff is a knope release bump and NOTHING else.
#
# Usage: is-release-bump.sh <base> <head>
# Exit 0 when `git diff <base>...<head>` is exactly what `knope prepare-release`
# produces; exit 1 (with the reason on stderr) otherwise. ci.yml's `changes`
# job calls it for a `release` PR and, on exit 0, hands the platform
# classifier an empty file list so no suite is scheduled for a diff that
# cannot change behaviour (#2094). Anything else — an extra file, a version
# file changed beyond its one version line — returns 1 and the PR gets the
# ordinary full matrix. The branch NAME is never trusted on its own; a
# `release` branch carrying real code must fail here.
#
# The permitted files are read from knope.toml's `versioned_files` so a newly
# versioned file cannot silently turn a release PR into a path to unverified
# code, nor silently fall out of this allowlist.
set -euo pipefail

BASE="${1:?base ref required}"
HEAD="${2:?head ref required}"
KNOPE_TOML="${KNOPE_TOML:-knope.toml}"

fail() { echo "not a release bump: $*" >&2; exit 1; }

# Both spellings knope.toml uses: a bare "path" string, and { path = "..." , regex = ... }.
mapfile -t VERSIONED < <(
  awk '/^versioned_files = \[/{on=1; next} on && /^\]/{exit} on' "$KNOPE_TOML" \
    | grep -vE '^\s*#' \
    | sed -nE 's/^\s*"([^"]+)",?\s*$/\1/p; s/^\s*\{ path = "([^"]+)".*$/\1/p'
)
[[ ${#VERSIONED[@]} -gt 0 ]] || fail "no versioned_files parsed from $KNOPE_TOML"

CHANGELOG="$(sed -nE 's/^changelog = "([^"]+)".*$/\1/p' "$KNOPE_TOML")"
[[ -n "$CHANGELOG" ]] || fail "no changelog parsed from $KNOPE_TOML"

# One version line, nothing else, in whatever syntax the file uses.
VERSION_LINE_RE='^[+-][[:space:]]*("version"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+",?|version[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"|versionName[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"|appVersion:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"|<string>[0-9]+\.[0-9]+\.[0-9]+</string>)[[:space:]]*$'

mapfile -t CHANGED < <(git diff --name-only "$BASE...$HEAD")
[[ ${#CHANGED[@]} -gt 0 ]] || fail "empty diff"

for file in "${CHANGED[@]}"; do
  if [[ "$file" == "$CHANGELOG" || "$file" =~ ^\.changeset/.+\.md$ ]]; then
    continue
  fi

  allowed=false
  for v in "${VERSIONED[@]}"; do [[ "$file" == "$v" ]] && allowed=true; done
  $allowed || fail "$file is not a knope versioned file"

  diff_u0="$(git diff -U0 "$BASE...$HEAD" -- "$file" | grep -E '^[+-]' | grep -vE '^(\+\+\+|---) ' || true)"
  removed="$(grep -c '^-' <<<"$diff_u0" || true)"
  added="$(grep -c '^+' <<<"$diff_u0" || true)"
  [[ "$removed" == 1 && "$added" == 1 ]] || fail "$file changes $removed/$added lines, expected exactly one version line"
  while IFS= read -r line; do
    [[ "$line" =~ $VERSION_LINE_RE ]] || fail "$file changes a non-version line: $line"
  done <<<"$diff_u0"

  # Cargo.lock lists every dependency's version the same way; only the
  # package knope owns may move.
  if [[ "$file" == */Cargo.lock ]]; then
    git diff -U1 "$BASE...$HEAD" -- "$file" | grep -qxF ' name = "llamenos-desktop"' \
      || fail "$file version change is not on the llamenos-desktop package"
  fi
done

echo "release bump: ${#CHANGED[@]} file(s), all knope-owned version/changelog lines"
