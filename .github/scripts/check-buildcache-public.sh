#!/usr/bin/env bash
# Proves the registry build cache is anonymously pullable, or fails loudly.
#
# Usage: check-buildcache-public.sh <registry/owner/repo> [tag]
#   e.g. check-buildcache-public.sh ghcr.io/llamenos-hotline/llamenos-platform buildcache
#
# Why (#2628): every Docker-building CI job imports `<image>:buildcache`
# ANONYMOUSLY (no login step, by design — see docker-buildcache.yml). When the
# package is not public, BuildKit logs "failed to fetch anonymous token ... 401"
# and quietly rebuilds from scratch, so the producer kept succeeding for weeks
# while no consumer could read what it pushed. Cache import is a soft
# dependency, so nothing else reports it. This is the one place that can: the
# producer just pushed the tag, so "exists but not anonymously readable" is a
# fact here, not a guess.
#
# It does exactly what a consumer's BuildKit does — request an anonymous pull
# token, then fetch the tag's manifest with it — and exits non-zero if either
# step is refused. No credential is ever sent.
set -euo pipefail

image="${1:?usage: $0 <registry/owner/repo> [tag]}"
tag="${2:-buildcache}"
host="${image%%/*}"
repo="${image#*/}"

fail() {
  echo "::error title=Build cache is not anonymously pullable::$1"
  cat >&2 <<MSG

${image}:${tag} cannot be read without credentials, so every CI job that
imports it (backend-bdd, e2e, android-e2e, image-smoke, release) silently
rebuilds from scratch. This is NOT fixed by anything in this repository:

  Operator action: GitHub -> Llamenos-Hotline -> Packages -> ${repo##*/}
    -> Package settings -> Change visibility -> Public.

Check it from outside CI:
  curl -s -o /dev/null -w '%{http_code}' \\
    'https://${host}/token?scope=repository%3A${repo//\//%2F}%3Apull&service=${host}'
  # 200 = pullable, 401 = not.

If the package must stay private instead, consumers have to authenticate
(packages: read) and this check must be replaced, not deleted.
MSG
  exit 1
}

# One request returning "<body>\n<status>" so a refusal is read, not guessed at.
token_response="$(curl -sS --max-time 30 -w '\n%{http_code}' \
  "https://${host}/token?scope=repository:${repo}:pull&service=${host}")" \
  || fail "the anonymous token request to ${host} failed to complete"
token_status="${token_response##*$'\n'}"
token_body="${token_response%$'\n'*}"

[ "$token_status" = "200" ] \
  || fail "anonymous token request for ${repo} returned HTTP ${token_status} (expected 200)"

token="$(printf '%s' "$token_body" | jq -r '.token // empty')"
[ -n "$token" ] || fail "the token endpoint returned 200 but no token"

manifest_status="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${token}" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
  "https://${host}/v2/${repo}/manifests/${tag}")" \
  || fail "the manifest request to ${host} failed to complete"

[ "$manifest_status" = "200" ] \
  || fail "anonymous manifest fetch of ${repo}:${tag} returned HTTP ${manifest_status} (expected 200)"

echo "${image}:${tag} is anonymously pullable (token 200, manifest 200)."
