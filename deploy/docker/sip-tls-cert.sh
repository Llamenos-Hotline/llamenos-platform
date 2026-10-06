#!/bin/sh
# Shared TLS material for the SIP edge (Asterisk's transport-tls, Kamailio's
# TLS listener), plus the trust anchor the app publishes to clients.
#
# WHY THIS EXISTS
#
# A volunteer's client registers over TLS and MUST verify the certificate the
# SIP edge presents — `verifyServerCertificates` stays on, there is no
# "accept anything" mode. But a self-hoster has no publicly-signed certificate
# for their PBX, so there is nothing in the device trust store that can vouch
# for it.
#
# The resolution: the client does not have to trust the device store at all.
# It already talks to the app's HTTPS API over a pinned chain, and
# `GET /api/telephony/sip-token` is authenticated. So the SIP edge's trust
# anchor travels to the client over that already-pinned channel, and the client
# verifies the SIP leg against that anchor alone (`sip.tlsTrustAnchorPem` in
# the token response). Trust in the PBX leg therefore derives from the API pin
# — no trust-on-first-use, no reliance on 150-odd public CAs for SIP.
#
# This script's job is the server half of that: put a usable keypair in place
# and export its PUBLIC half (never the key) where the app can read it.
#
# Usage:  sip-tls-cert.sh <keypair-path> <anchor-out-path> [owner]
#
#   keypair-path     combined cert+key PEM the SIP daemon reads. Generated
#                    self-signed when absent; a mounted real certificate is
#                    left untouched.
#   anchor-out-path  where the public trust anchor is written for the app
#                    (SIP_TLS_CA_FILE). Its directory is created.
#   owner            optional `user:group` to chown the keypair to.
#
# Environment:
#   SIP_TLS_SANS   comma-separated hostnames/IPs the certificate must cover —
#                  every address a client may use for the SIP domain. Entries
#                  that parse as IPv4/IPv6 become IP: SANs, the rest DNS:.
#                  Defaults to the container hostname. `localhost`/`127.0.0.1`
#                  are always added so in-container probes work.
#   SIP_TLS_ANCHOR_SOURCE
#                  path to an operator-supplied trust anchor (the ROOT of the
#                  chain a real certificate was issued under). When set and
#                  non-empty it is exported verbatim instead of the leaf, so
#                  clients keep working across certificate renewals.
set -eu

keypair="${1:?usage: sip-tls-cert.sh <keypair-path> <anchor-out-path> [owner]}"
anchor_out="${2:?usage: sip-tls-cert.sh <keypair-path> <anchor-out-path> [owner]}"
owner="${3:-}"

log() { echo "llamenos-sip-tls: $*" >&2; }

ensure_openssl() {
  command -v openssl >/dev/null 2>&1 && return 0
  # Some pinned images ship no openssl. Install it for this one-shot
  # generation; where the archive is unreachable the caller is told, the TLS
  # transport does not load, and UDP/TCP keep working.
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update >/dev/null 2>&1 \
      && apt-get install -y --no-install-recommends openssl >/dev/null 2>&1 || true
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache openssl >/dev/null 2>&1 || true
  fi
  command -v openssl >/dev/null 2>&1
}

# "pbx.example.org, 10.0.2.2" -> "DNS:pbx.example.org,IP:10.0.2.2"
san_list() {
  hostname_fqdn="$(hostname -f 2>/dev/null || hostname)"
  names="${SIP_TLS_SANS:-}"
  [ -n "$names" ] && names="$names,"
  names="${names}${hostname_fqdn},localhost"
  out=''
  ips='127.0.0.1'
  old_ifs="$IFS"; IFS=','
  for raw in $names; do
    IFS="$old_ifs"
    name="$(printf '%s' "$raw" | tr -d '[:space:]')"
    [ -z "$name" ] && { IFS=','; continue; }
    case "$name" in
      # Bare IPv4 / IPv6 literals belong in an IP: SAN; a DNS: SAN holding an
      # address matches nothing (RFC 6125 §6.4).
      *:*)       entry="IP:$name" ;;
      *[!0-9.]*) entry="DNS:$name" ;;
      *)         entry="IP:$name" ;;
    esac
    case ",$out," in *",$entry,"*) IFS=','; continue ;; esac
    out="${out:+$out,}$entry"
    IFS=','
  done
  IFS="$old_ifs"
  for ip in $ips; do
    case ",$out," in *",IP:$ip,"*) continue ;; esac
    out="${out:+$out,}IP:$ip"
  done
  printf '%s' "$out"
}

# ── 1. Keypair ────────────────────────────────────────────────────────────
if [ ! -s "$keypair" ]; then
  mkdir -p "$(dirname "$keypair")"
  if ensure_openssl; then
    sans="$(san_list)"
    cn="${SIP_TLS_SANS:-}"
    cn="${cn%%,*}"
    cn="$(printf '%s' "$cn" | tr -d '[:space:]')"
    [ -z "$cn" ] && cn="$(hostname -f 2>/dev/null || hostname)"
    log "generating a self-signed SIP edge certificate for $sans"
    umask 077
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$keypair" -out "$keypair" \
      -days 3650 -subj "/CN=${cn}" -addext "subjectAltName=${sans}" \
      >/dev/null 2>&1 \
      || log "openssl failed — the TLS listener will not bind"
  else
    log "no openssl and no mounted certificate — the TLS listener will not bind"
  fi
fi
if [ -s "$keypair" ]; then
  [ -n "$owner" ] && chown "$owner" "$keypair"
  chmod 600 "$keypair"
fi

# ── 2. Trust anchor for clients (public half only) ────────────────────────
mkdir -p "$(dirname "$anchor_out")"
anchor_source="${SIP_TLS_ANCHOR_SOURCE:-}"
if [ -n "$anchor_source" ] && [ -s "$anchor_source" ]; then
  # A real certificate's issuing root: pinning that, not the leaf, keeps
  # clients working when the leaf is renewed.
  cp "$anchor_source" "$anchor_out"
elif [ -s "$keypair" ] && command -v openssl >/dev/null 2>&1; then
  # `openssl x509` emits the certificate and nothing else, so the private key
  # in the combined PEM cannot leak into the published anchor. A self-signed
  # certificate is its own anchor; for a CA-issued one set
  # SIP_TLS_ANCHOR_SOURCE instead.
  openssl x509 -in "$keypair" -out "$anchor_out" 2>/dev/null \
    || log "could not export the trust anchor from $keypair"
else
  log "no certificate to export — clients will fall back to the device trust store"
fi
if [ -s "$anchor_out" ]; then
  chmod 644 "$anchor_out"
  if grep -q 'PRIVATE KEY' "$anchor_out"; then
    # Refuse to publish a file holding key material, whatever produced it.
    log "FATAL: $anchor_out contains a private key — refusing to publish it"
    rm -f "$anchor_out"
    exit 1
  fi
  log "published SIP edge trust anchor to $anchor_out"
fi
