#!/usr/bin/env bash
# scripts/check-image-trust-store.sh — verify the TLS trust stores inside a built image (#2582).
#
# Usage: scripts/check-image-trust-store.sh <image> <bun|node|os>
#
# The second argument names the store the image's outbound TLS clients ACTUALLY verify
# against, which is not always the distro bundle:
#   bun   Bun's compiled-in root store. Bun's fetch/WebSocket/TLS ignore
#         /etc/ssl/certs, so for a Bun service the Bun release IS the trust store.
#         Upgrading ca-certificates changes nothing for it.
#   node  Node's compiled-in root store (same reasoning).
#   os    the distro bundle /etc/ssl/certs/ca-certificates.crt (OpenSSL in Asterisk,
#         Go's crypto/x509 in Caddy).
#
# Every check below fails the run:
#
#  1. Known distrust events. EVERY trust store present in the image (the distro bundle if
#     there is one, plus Bun's/Node's compiled-in store if that binary is there) must
#     reject every chain under deploy/docker/distrusted-tls-chains/*/chains. A positive
#     control re-verifies each chain against only its own distrusted root, so a rejection
#     cannot come from a fixture that has expired or broken. Verification runs at a fixed
#     time inside the fixtures' validity window.
#
#  2. Currency, judged by the kind of store:
#     - compiled-in store (bun/node, when it is the effective store): every root it
#       trusts must still be in Mozilla's CURRENT root store, using curl.se's extract of
#       NSS, fetched now. A runtime release freezes its store. A root Mozilla has removed
#       since, whether for compromise or attrition, is a trust decision nobody would make
#       today. This is the check that goes red when the runtime needs a bump, before
#       anyone has heard of the incident.
#     - distro bundle (every image that has one): the installed ca-certificates must be
#       the version the distro archive publishes NOW. Stable distros legitimately lag
#       Mozilla (Debian trixie keeps ~40 roots Mozilla has dropped), so "current" for a
#       distro bundle means "what the distro ships today". That is how its security
#       removals, such as the eMudhra one (20250419+deb13u1), arrive.
#
# Needs: docker, openssl, curl, sha256sum, awk. Network access: curl.se and the distro
# archive. A fetch failure fails the check; nothing here treats "could not look" as "fine".
set -euo pipefail

if [ $# -ne 2 ] || ! [[ $2 =~ ^(bun|node|os)$ ]]; then
  echo "usage: $0 <image> <bun|node|os>" >&2
  exit 2
fi
image=$1
effective=$2

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fixtures="$repo/deploy/docker/distrusted-tls-chains"
# 2026-11-01T00:00:00Z — after every fixture leaf was issued, before any expires.
attime=1793491200

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0
fail() { echo "  FAIL: $*"; failures=$((failures + 1)); }

in_image() { docker run --rm --user 0 --entrypoint sh "$image" -c "$1"; }

# One "SHA256-fingerprint<TAB>subject" line per certificate in a PEM bundle.
fingerprints() {
  local bundle=$1 dir
  dir=$(mktemp -d "$work/split.XXXXXX")
  awk -v d="$dir" '
    /-----BEGIN CERTIFICATE-----/ { n++; f = sprintf("%s/%05d.pem", d, n); inside = 1 }
    inside { print > f }
    /-----END CERTIFICATE-----/ { inside = 0; close(f) }
  ' "$bundle"
  local f
  for f in "$dir"/*.pem; do
    [ -e "$f" ] || continue
    printf '%s\t%s\n' \
      "$(openssl x509 -in "$f" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d :)" \
      "$(openssl x509 -in "$f" -noout -subject -nameopt oneline | sed 's/^subject= *//')"
  done
}

echo "== $image (effective store: $effective)"
echo "   image id: $(docker image inspect --format '{{.Id}}' "$image")"

# ── Collect every trust store present in the image ─────────────────────────────
stores=()
if in_image 'test -s /etc/ssl/certs/ca-certificates.crt'; then
  in_image 'cat /etc/ssl/certs/ca-certificates.crt' > "$work/os.pem"
  stores+=(os)
fi
if in_image 'command -v bun >/dev/null'; then
  echo "   bun $(in_image 'bun --version')"
  in_image 'bun -e "process.stdout.write(require(\"node:tls\").rootCertificates.join(\"\\n\") + \"\\n\")"' > "$work/bun.pem"
  stores+=(bun)
fi
# Bun images ship a `node` shim that is Bun itself; only a real Node is a separate store.
if in_image 'command -v node >/dev/null && node -e "process.exit(process.versions.bun ? 1 : 0)"' 2>/dev/null; then
  echo "   node $(in_image 'node --version')"
  in_image 'node -e "process.stdout.write(require(\"node:tls\").rootCertificates.join(\"\\n\") + \"\\n\")"' > "$work/node.pem"
  stores+=(node)
fi

for s in "${stores[@]}"; do
  n=$(grep -c -- '-----BEGIN CERTIFICATE-----' "$work/$s.pem" || true)
  echo "   store $s: $n certificates"
  # An empty dump would reject every chain and "pass"; absent is not fine.
  [ "$n" -gt 0 ] || fail "store '$s' is present but dumped zero certificates"
done
if ! printf '%s\n' "${stores[@]}" | grep -qx "$effective"; then
  fail "declared effective store '$effective' is not present in the image (found: ${stores[*]:-none})"
fi

# ── 1. Known distrust events ───────────────────────────────────────────────────
event_count=0
for event in "$fixtures"/*/; do
  # An event documented without its chains would otherwise be skipped once any other
  # event exists, and its distrust would silently stop being checked.
  if [ ! -d "$event/chains" ]; then
    fail "distrust event $(basename "$event") has no chains/ directory"
    continue
  fi
  event_count=$((event_count + 1))
  cat "$event"/control-roots/*.pem > "$work/control.pem"
  echo "   distrust event: $(basename "$event")"
  for chain in "$event"/chains/*.pem; do
    name=$(basename "$chain" .pem)
    if ! openssl verify -attime "$attime" -CAfile "$work/control.pem" -untrusted "$chain" "$chain" >/dev/null 2>&1; then
      fail "positive control: $name does not verify even against its own distrusted root — the fixture is broken, so its rejections prove nothing"
      continue
    fi
    line="     $name:"
    for s in "${stores[@]}"; do
      if openssl verify -attime "$attime" -CAfile "$work/$s.pem" -untrusted "$chain" "$chain" >/dev/null 2>&1; then
        line+=" $s=ACCEPTS"
        fail "store '$s' still trusts the distrusted chain $name"
      else
        line+=" $s=rejects"
      fi
    done
    echo "$line"
  done
done
[ "$event_count" -gt 0 ] || fail "no distrust fixtures found under $fixtures"

# ── 2a. Compiled-in store currency: a subset of Mozilla's current store ─────────
if [ "$effective" = bun ] || [ "$effective" = node ]; then
  curl -fsSL --retry 3 https://curl.se/ca/cacert.pem -o "$work/mozilla.pem"
  want=$(curl -fsSL --retry 3 https://curl.se/ca/cacert.pem.sha256 | awk '{print $1}')
  got=$(sha256sum "$work/mozilla.pem" | awk '{print $1}')
  if [ -z "$want" ] || [ "$want" != "$got" ]; then
    fail "could not fetch an intact Mozilla root store from curl.se (sha256 '$got' vs published '$want')"
  else
    echo "   Mozilla store: $(grep -m1 'Certificate data from Mozilla as of' "$work/mozilla.pem" | sed 's/^## //')"
    fingerprints "$work/mozilla.pem" | cut -f1 | sort -u > "$work/mozilla.fp"
    fingerprints "$work/$effective.pem" | sort -u > "$work/effective.fp"
    stale=$(awk -F'\t' 'NR == FNR { keep[$1] = 1; next } !($1 in keep) { print "       " $2 }' \
      "$work/mozilla.fp" "$work/effective.fp")
    if [ -n "$stale" ]; then
      fail "the $effective runtime trusts $(printf '%s\n' "$stale" | wc -l) root(s) Mozilla no longer does — bump the runtime release:"
      printf '%s\n' "$stale"
    else
      echo "   $effective store: every root is in Mozilla's current store"
    fi
  fi
fi

# ── 2b. Distro bundle currency: installed ca-certificates = archive's current ───
if printf '%s\n' "${stores[@]}" | grep -qx os; then
  if in_image 'command -v apt-get >/dev/null'; then
    policy=$(in_image 'apt-get update -qq >/dev/null 2>&1 && apt-cache policy ca-certificates') \
      || fail "apt-get update failed inside the image; cannot judge ca-certificates currency"
    installed=$(printf '%s\n' "$policy" | awk '/Installed:/ {print $2}')
    candidate=$(printf '%s\n' "$policy" | awk '/Candidate:/ {print $2}')
    echo "   ca-certificates (dpkg): installed=${installed:-?} archive=${candidate:-?}"
    if [ -z "$installed" ] || [ "$installed" = "(none)" ] || [ -z "$candidate" ] || [ "$candidate" = "(none)" ]; then
      fail "the distro bundle is not managed by an installed ca-certificates package"
    elif [ "$installed" != "$candidate" ]; then
      fail "ca-certificates $installed is stale; the archive now publishes $candidate — rebuild the image"
    fi
  elif in_image 'command -v apk >/dev/null'; then
    installed=$(in_image 'apk list -I ca-certificates 2>/dev/null' | awk '{print $1}')
    upgradable=$(in_image 'apk update -q >/dev/null && apk list -u ca-certificates 2>/dev/null') \
      || fail "apk update failed inside the image; cannot judge ca-certificates currency"
    echo "   ca-certificates (apk): installed=${installed:-?}"
    if [ -z "$installed" ]; then
      fail "the distro bundle is not managed by an installed ca-certificates package"
    elif [ -n "$upgradable" ]; then
      fail "ca-certificates is stale; the archive now publishes: $upgradable — rebuild the image"
    fi
  else
    fail "image has a distro bundle but neither apt nor apk to judge its currency"
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "== $image: $failures failure(s)"
  exit 1
fi
echo "== $image: OK"
