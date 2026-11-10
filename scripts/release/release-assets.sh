# shellcheck shell=bash
# Release-asset transfers that survive a transient GitHub error.
#
# SOURCED by the release workflows (release.yml, tauri-release.yml,
# mobile-release.yml), never executed. Every function that talks to GitHub runs
# under `ra_retry`: a bounded number of attempts, a visible `::warning::` per
# failed attempt and an `::error::` when the attempts run out — exhausted retries
# still fail the step.
#
# Two releases were stranded as drafts by ONE transient error each: an HTTP/2
# `PROTOCOL_ERROR` mid-`gh release download` (v0.21.9) and an HTTP 500 from
# uploads.github.com mid-`gh release create` (v0.21.4). Neither command retries.
#
# Idempotency: an upload that failed may have left an asset behind — a "starter"
# stub (GitHub then rejects every re-upload of that name as `already_exists`) or
# a truncated file. A retry therefore verifies BY DIGEST, per asset:
#   - attached, state "uploaded", GitHub's server-side sha256 == the local file's
#     => those bytes landed; it is not uploaded again;
#   - anything else under that name => deleted and uploaded again (clobber).
# Clobber alone would also converge, but it re-sends every file (~300 MB of
# installers) on every retry; digest-skip re-sends only what did not land, and
# the same check proves the result, so a retry can never "succeed" onto a
# partial asset. Downloads are checked against the same digest, so a stream cut
# short reads as a failed attempt, not as a smaller installer.
#
# Plain curl + jq against the REST API (no `gh`): every request is visible and
# the behaviour under failure is ours to test (release-assets.test.ts runs it
# against a local server that fails on purpose). bash 3.2-safe: the iOS publish
# step runs on macOS /bin/bash.
#
# Environment: GH_TOKEN, GITHUB_REPOSITORY (owner/repo), GITHUB_API_URL (set by
# Actions; defaults to https://api.github.com). Tuning:
# RELEASE_RETRY_ATTEMPTS (default 5), RELEASE_RETRY_BACKOFF_SEC (default 10;
# attempt n waits n * that many seconds).

# ra_retry <what> <command...> — run <command> until it succeeds, at most
# RELEASE_RETRY_ATTEMPTS times. <command> is called in a `||` context, so errexit
# is off inside it: every function passed here checks its own failures.
ra_retry() {
  local what="$1" max="${RELEASE_RETRY_ATTEMPTS:-5}" backoff="${RELEASE_RETRY_BACKOFF_SEC:-10}"
  local attempt=1 rc delay
  shift
  while :; do
    rc=0
    "$@" || rc=$?
    if [ "$rc" -eq 0 ]; then
      if [ "$attempt" -gt 1 ]; then echo "${what}: succeeded on attempt ${attempt}/${max}" >&2; fi
      return 0
    fi
    if [ "$attempt" -ge "$max" ]; then
      echo "::error::${what} failed after ${max} attempts (last exit ${rc}). Giving up — this step fails." >&2
      return "$rc"
    fi
    delay=$((backoff * attempt))
    echo "::warning::${what} failed (attempt ${attempt}/${max}, exit ${rc}) — retrying in ${delay}s" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

_ra_url() {
  case "$1" in
    http://* | https://*) printf '%s' "$1" ;;
    *) printf '%s/%s' "${GITHUB_API_URL:-https://api.github.com}" "${1#/}" ;;
  esac
}

# _ra_api <METHOD> <path-or-url> [curl args...] — ONE request; body on stdout on
# 2xx. Anything else (transport error, non-2xx) is logged to stderr with the
# status and the start of the body, and returns 1.
_ra_api() {
  local method="$1" url body code rc=0
  if [ -z "${GH_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ]; then
    echo "::error::release-assets.sh needs GH_TOKEN and GITHUB_REPOSITORY in the environment" >&2
    return 1
  fi
  url=$(_ra_url "$2")
  shift 2
  body=$(mktemp) || return 1
  code=$(curl --silent --show-error --output "$body" --write-out '%{http_code}' \
    --connect-timeout 30 --max-time "${RA_MAX_TIME:-120}" \
    --request "$method" \
    --header "Authorization: Bearer ${GH_TOKEN}" \
    --header "Accept: ${RA_ACCEPT:-application/vnd.github+json}" \
    --header "X-GitHub-Api-Version: 2022-11-28" \
    "$@" "$url") || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  ${method} ${url}: curl exit ${rc}" >&2
    rm -f "$body"
    return 1
  fi
  case "$code" in
    2??)
      cat "$body"
      rm -f "$body"
      return 0
      ;;
  esac
  echo "  ${method} ${url}: HTTP ${code} $(head -c 300 "$body" | tr '\n' ' ')" >&2
  rm -f "$body"
  return 1
}

# _ra_get_all <path> — every page of a list endpoint, merged into one JSON array.
_ra_get_all() {
  local path="$1" sep page=1 n tmp
  case "$path" in *\?*) sep='&' ;; *) sep='?' ;; esac
  tmp=$(mktemp -d) || return 1
  while :; do
    if ! _ra_api GET "${path}${sep}per_page=100&page=${page}" >"${tmp}/${page}.json"; then
      rm -rf "$tmp"
      return 1
    fi
    if ! n=$(jq 'length' "${tmp}/${page}.json"); then
      echo "  GET ${path} page ${page}: response is not a JSON array" >&2
      rm -rf "$tmp"
      return 1
    fi
    if [ "$n" -lt 100 ]; then break; fi
    page=$((page + 1))
  done
  jq -cs 'add // []' "${tmp}"/*.json
  n=$?
  rm -rf "$tmp"
  return "$n"
}

# _ra_releases <tag> — every release (draft or published) carrying <tag>. Drafts
# are invisible to /releases/tags/<tag>, so this pages the full list.
_ra_releases() {
  local all
  all=$(_ra_get_all "repos/${GITHUB_REPOSITORY}/releases") || return 1
  jq -c --arg t "$1" '[.[] | select(.tag_name == $t)]' <<<"$all"
}

# _ra_the_draft <tag> — the single draft release for <tag>, or fail.
_ra_the_draft() {
  local rels n
  rels=$(_ra_releases "$1") || return 1
  n=$(jq '[.[] | select(.draft)] | length' <<<"$rels") || return 1
  if [ "$n" -ne 1 ]; then
    echo "  expected exactly one draft release for $1, found ${n}" >&2
    return 1
  fi
  jq -c '[.[] | select(.draft)][0]' <<<"$rels"
}

_ra_assets() { # <release-id>
  _ra_get_all "repos/${GITHUB_REPOSITORY}/releases/$1/assets"
}

_ra_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    shasum -a 256 -- "$1" | awk '{print $1}'
  fi
}

_ra_size() { wc -c <"$1" | tr -d ' '; }

# _ra_intact <asset-json> <size> <sha256> — the asset holds exactly these bytes.
# GitHub's `digest` is its own sha256 of what it stored. If it is absent the
# size must still match (and the gap is said out loud): that is no weaker than
# the name+size check these workflows made before.
_ra_intact() {
  local state size digest
  state=$(jq -r '.state' <<<"$1")
  size=$(jq -r '.size' <<<"$1")
  digest=$(jq -r '.digest // ""' <<<"$1")
  [ "$state" = uploaded ] || return 1
  [ "$size" = "$2" ] || return 1
  if [ -z "$digest" ]; then
    echo "::notice::GitHub reported no digest for $(jq -r .name <<<"$1"); accepted on size alone" >&2
    return 0
  fi
  [ "$digest" = "sha256:$3" ]
}

_ra_asset_named() { # <assets-json> <name>
  jq -c --arg n "$2" '[.[] | select(.name == $n)][0] // empty' <<<"$1"
}

# ── Upload ──────────────────────────────────────────────────────────────────

_ra_upload_once() {
  local tag="$1" rel id upload_url assets f name size sha existing
  shift
  rel=$(_ra_the_draft "$tag") || return 1
  id=$(jq -r '.id' <<<"$rel")
  upload_url=$(jq -r '.upload_url | sub("\\{.*$"; "")' <<<"$rel")
  assets=$(_ra_assets "$id") || return 1
  for f in "$@"; do
    name=$(basename "$f")
    size=$(_ra_size "$f")
    sha=$(_ra_sha256 "$f")
    existing=$(_ra_asset_named "$assets" "$name")
    if [ -n "$existing" ]; then
      if _ra_intact "$existing" "$size" "$sha"; then
        echo "  ${name}: already attached with sha256 ${sha} — not re-uploading" >&2
        continue
      fi
      echo "  ${name}: attached but not these bytes (state $(jq -r .state <<<"$existing"), size $(jq -r .size <<<"$existing")) — replacing it" >&2
      _ra_api DELETE "repos/${GITHUB_REPOSITORY}/releases/assets/$(jq -r .id <<<"$existing")" >/dev/null || return 1
    fi
    echo "  ${name}: uploading ${size} bytes" >&2
    RA_MAX_TIME=1800 _ra_api POST "${upload_url}?name=$(jq -rn --arg n "$name" '$n|@uri')" \
      --header "Content-Type: application/octet-stream" \
      --upload-file "$f" --speed-limit 1024 --speed-time 120 >/dev/null || return 1
  done
  # Prove it, from a fresh listing: the upload response alone is not evidence.
  assets=$(_ra_assets "$id") || return 1
  for f in "$@"; do
    name=$(basename "$f")
    existing=$(_ra_asset_named "$assets" "$name")
    if [ -z "$existing" ] || ! _ra_intact "$existing" "$(_ra_size "$f")" "$(_ra_sha256 "$f")"; then
      echo "  ${name}: not attached intact after uploading it" >&2
      return 1
    fi
  done
}

# ra_upload <tag> <file...> — attach files to the DRAFT release <tag>.
ra_upload() {
  local tag="$1" f
  shift
  if [ "$#" -eq 0 ]; then
    echo "::error::ra_upload ${tag}: no files given" >&2
    return 1
  fi
  for f in "$@"; do
    if [ ! -f "$f" ]; then
      echo "::error::ra_upload ${tag}: ${f} is not a file" >&2
      return 1
    fi
  done
  ra_retry "Attaching $# file(s) to the draft release ${tag}" _ra_upload_once "$tag" "$@"
}

_ra_draft_asset_names_once() {
  local rel assets
  rel=$(_ra_the_draft "$1") || return 1
  assets=$(_ra_assets "$(jq -r '.id' <<<"$rel")") || return 1
  jq -r '.[].name' <<<"$assets"
}

# ra_draft_asset_names <tag> — every asset name on the draft <tag>, one per line.
ra_draft_asset_names() {
  ra_retry "Listing the assets of the draft release ${1}" _ra_draft_asset_names_once "$1"
}

# ── Download ────────────────────────────────────────────────────────────────

_ra_download_once() {
  local tag="$1" dir="$2" rels n assets id name size state digest url tmp sha
  rels=$(_ra_releases "$tag") || return 1
  n=$(jq 'length' <<<"$rels") || return 1
  if [ "$n" -ne 1 ]; then
    echo "  expected exactly one release for ${tag}, found ${n}" >&2
    return 1
  fi
  assets=$(_ra_assets "$(jq -r '.[0].id' <<<"$rels")") || return 1
  if [ "$(jq 'length' <<<"$assets")" -eq 0 ]; then
    echo "  ${tag} has no assets attached" >&2
    return 1
  fi
  # digest LAST: tab is IFS whitespace, so an empty field mid-line would collapse
  # and shift every field after it.
  while IFS="$(printf '\t')" read -r id name size state url digest; do
    case "$name" in
      '' | . | .. | */*)
        echo "  refusing an asset name that is not a plain file name: '${name}'" >&2
        return 1
        ;;
    esac
    if [ "$state" != uploaded ]; then
      echo "  ${name}: state is '${state}' — an upload that never finished" >&2
      return 1
    fi
    if [ -f "${dir}/${name}" ] && _ra_intact "$(_ra_asset_named "$assets" "$name")" \
      "$(_ra_size "${dir}/${name}")" "$(_ra_sha256 "${dir}/${name}")"; then
      continue # landed intact on an earlier attempt
    fi
    tmp="${dir}/${name}.part"
    RA_MAX_TIME=1800 RA_ACCEPT=application/octet-stream _ra_api GET "$url" --location \
      --speed-limit 1024 --speed-time 120 >"$tmp" || return 1
    if [ "$(_ra_size "$tmp")" != "$size" ]; then
      echo "  ${name}: downloaded $(_ra_size "$tmp") bytes, GitHub says ${size}" >&2
      return 1
    fi
    sha=$(_ra_sha256 "$tmp")
    if [ -n "$digest" ] && [ "$digest" != "sha256:${sha}" ]; then
      echo "  ${name}: downloaded sha256 ${sha} does not match GitHub's ${digest}" >&2
      return 1
    fi
    mv -f "$tmp" "${dir}/${name}" || return 1
    echo "  ${name}: ${size} bytes, sha256 ${sha}" >&2
  done < <(jq -r '.[] | [.id, .name, .size, .state, .url, (.digest // "")] | @tsv' <<<"$assets")
}

# ra_download <tag> <dir> — every asset of the (single) release <tag>, draft or
# published, into a fresh <dir>, each checked against GitHub's size and digest.
ra_download() {
  local tag="$1" dir="$2"
  rm -rf "$dir" && mkdir -p "$dir" || return 1
  ra_retry "Downloading every asset of the release ${tag}" _ra_download_once "$tag" "$dir"
}

# ── Create / publish / query ────────────────────────────────────────────────

_ra_create_once() {
  local tag="$1" payload="$2" rels id created
  # A POST whose response was lost may still have created a draft: clear every
  # draft for the tag first, so a retry converges on exactly one.
  rels=$(_ra_releases "$tag") || return 1
  for id in $(jq -r '.[] | select(.draft) | .id' <<<"$rels"); do
    echo "  deleting the leftover draft ${tag} (id ${id})" >&2
    _ra_api DELETE "repos/${GITHUB_REPOSITORY}/releases/${id}" >/dev/null || return 1
  done
  created=$(_ra_api POST "repos/${GITHUB_REPOSITORY}/releases" --header "Content-Type: application/json" \
    --data-binary "@${payload}") || return 1
  echo "  created the draft release ${tag} (id $(jq -r .id <<<"$created"))" >&2
}

# ra_create_draft <tag> <title> <notes-file> <target-commitish|""> <prerelease:true|false>
# Replaces any earlier DRAFT for <tag>; refuses (without retrying) if <tag> is
# already published, because a published release is immutable.
ra_create_draft() {
  local tag="$1" title="$2" notes="$3" target="$4" pre="$5" published payload rc=0
  published=$(ra_published_url "$tag") || return 1
  if [ -n "$published" ]; then
    echo "::error::${tag} is already published (${published}) and releases are immutable — not creating a draft over it." >&2
    return 1
  fi
  payload=$(mktemp) || return 1
  jq -n --arg t "$tag" --arg n "$title" --rawfile b "$notes" --arg c "$target" --argjson p "$pre" \
    '{tag_name: $t, name: $n, body: $b, draft: true, prerelease: $p}
     + (if $c == "" then {} else {target_commitish: $c} end)' >"$payload" || {
    rm -f "$payload"
    return 1
  }
  ra_retry "Creating the draft release ${tag}" _ra_create_once "$tag" "$payload" || rc=$?
  rm -f "$payload"
  return "$rc"
}

_ra_publish_once() {
  local tag="$1" latest="$2" rels drafts published id out
  rels=$(_ra_releases "$tag") || return 1
  drafts=$(jq '[.[] | select(.draft)] | length' <<<"$rels") || return 1
  published=$(jq '[.[] | select(.draft | not)] | length' <<<"$rels") || return 1
  if [ "$drafts" -eq 0 ] && [ "$published" -eq 1 ]; then
    # An earlier attempt's PATCH landed and only its response was lost.
    echo "  ${tag} is already published" >&2
    return 0
  fi
  if [ "$drafts" -ne 1 ] || [ "$published" -ne 0 ]; then
    echo "  ${tag}: expected one draft and nothing published, found ${drafts} draft(s) and ${published} published" >&2
    return 1
  fi
  id=$(jq -r '[.[] | select(.draft)][0].id' <<<"$rels")
  out=$(_ra_api PATCH "repos/${GITHUB_REPOSITORY}/releases/${id}" --header "Content-Type: application/json" \
    --data-binary "$(jq -nc --arg l "$latest" '{draft: false, make_latest: $l}')") || return 1
  if [ "$(jq -r '.draft' <<<"$out")" != false ]; then
    echo "  ${tag}: GitHub answered the publish but the release is still a draft" >&2
    return 1
  fi
  echo "  published $(jq -r '.html_url' <<<"$out")" >&2
}

# ra_publish <tag> <make-latest:true|false> — turn the draft <tag> public.
ra_publish() {
  ra_retry "Publishing the release $1" _ra_publish_once "$1" "$2"
}

_ra_published_url_once() {
  local rels
  rels=$(_ra_releases "$1") || return 1
  jq -r '.[] | select(.draft | not) | .html_url' <<<"$rels"
}

# ra_published_url <tag> — the html_url of the published <tag>, empty if there is
# none. A failed lookup FAILS; it never reads as "not published".
ra_published_url() {
  ra_retry "Looking up whether ${1} is published" _ra_published_url_once "$1"
}

# ra_get <path> — one GitHub REST GET, retried; the JSON body on stdout.
ra_get() {
  ra_retry "GET $1" _ra_api GET "$1"
}
