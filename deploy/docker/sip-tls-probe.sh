#!/bin/sh
# Assert that the SIP edge's TLS listener is BOUND and SERVING TLS.
#
# WHY THIS EXISTS
#
# sip-tls-cert.sh degrades gracefully on purpose: if certificate generation
# fails, the container still comes up and still serves SIP over UDP and TCP,
# because stopping the container would take away the transports that do work.
# That is the right behaviour and this script does not change it.
#
# What was missing is any REPORT of the degradation. A deploy whose TLS
# generation failed came up serving UDP/TCP only, the smoke check said nothing
# about it, and the operator had no signal that encrypted SIP was unavailable —
# while every client that registers over TLS verifies the certificate and has
# no "accept anything" mode, so it fails closed and no volunteer is reachable
# (issue #1636).
#
# WHAT IT REFUSES TO ACCEPT AS HEALTHY
#
# Three false greens, in order of how easy each is to ship:
#
#   1. Reading the config. tls.cfg naming a certificate path proves nothing
#      about whether the daemon loaded it — Kamailio reads TLS material once,
#      at module init, and carries on without the listener if it cannot.
#   2. A plain TCP connect. `nc -z` succeeds against anything that accepts,
#      including a port forward to a dead container and a TCP listener with no
#      TLS behind it at all. This script therefore completes a real handshake
#      and requires a certificate to come back on it.
#   3. A handshake with the WRONG certificate. A client verifies the hostname
#      as well as the chain (RFC 6125), and when the deployment publishes a
#      trust anchor the client verifies against THAT anchor alone. So an
#      expired certificate, one whose SANs do not cover the SIP domain, or one
#      the published anchor cannot vouch for is a failure here even though the
#      handshake itself worked.
#
# Usage:
#   sip-tls-probe.sh --host H --port P [--expect-name N] [--ca-file F]
#                    [--timeout SECONDS]
#
#   --host / --port   the listener to probe. 127.0.0.1 and the SIP TLS port
#                     for a smoke check on the deployed host.
#   --expect-name     a hostname or IP a client may dial for the SIP domain.
#                     The presented certificate must cover it in a SAN (or, for
#                     a certificate with no SANs at all, in its CN). Repeatable.
#   --ca-file         the trust anchor the deployment publishes to clients. The
#                     presented chain must verify against it. Omit only when
#                     the edge serves a publicly-trusted chain and the
#                     deployment publishes no anchor.
#   --timeout         seconds to allow for the handshake (default 10). A port
#                     that accepts and then says nothing is the TCP-with-no-TLS
#                     case, and it is a FAIL once this expires — never a pass
#                     and never a hang.
#
# Exit status: 0 = the listener is bound and serving a certificate that holds
# up; 1 = it is not, or could not be measured. There is no third, quieter exit:
# "could not measure" is reported as a failure, because an absent measurement
# rendering as success is the whole defect class this probe belongs to.
#
# Output: human-readable lines, ending in `RESULT: PASS` or `RESULT: FAIL`
# followed by `DETAIL: <one line>`. Callers read the exit status; the DETAIL
# line is what the smoke summary shows an operator.
set -u

host=''
port=''
ca_file=''
timeout_s=10
expect_names=''

while [ $# -gt 0 ]; do
  case "$1" in
    --host)        host="${2:-}"; shift 2 ;;
    --port)        port="${2:-}"; shift 2 ;;
    --expect-name) expect_names="${expect_names:+$expect_names }${2:-}"; shift 2 ;;
    --ca-file)     ca_file="${2:-}"; shift 2 ;;
    --timeout)     timeout_s="${2:-10}"; shift 2 ;;
    *) echo "sip-tls-probe: unknown argument: $1" >&2; exit 1 ;;
  esac
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT INT TERM

verdict() {
  echo "RESULT: $1"
  echo "DETAIL: $2"
  [ "$1" = PASS ] && exit 0
  exit 1
}

[ -n "$host" ] && [ -n "$port" ] \
  || verdict FAIL "sip-tls-probe needs --host and --port; it measured nothing"

command -v openssl >/dev/null 2>&1 \
  || verdict FAIL "openssl is not installed on this host, so the TLS listener on ${host}:${port} could not be probed at all — install openssl rather than treating an unmeasurable listener as healthy"

# ── 1. The handshake ──────────────────────────────────────────────────────
#
# `-showcerts` so the whole presented chain is available for verification, and
# `</dev/null` so s_client sends its ClientHello and then stops rather than
# waiting on a terminal. No `-verify_return_error`: s_client exits non-zero for
# a self-signed certificate even on a perfectly completed handshake, and the
# self-signed certificate is the DEFAULT for a self-hoster. The chain is
# verified below, against the anchor clients actually use, where a verdict can
# be made from the right trust root instead of the host's CA bundle.
#
# `timeout` is what turns "the port accepted a TCP connection and then said
# nothing" — a forward to a dead container, or a TCP listener with no TLS
# behind it — into a failure instead of a hang.
hs="$work/handshake.txt"
# SNI carries the first expected name, but only when it is a hostname: an SNI
# extension holding an IP literal is forbidden (RFC 6066 §3) and a strict
# server will reject the handshake over it.
sni=''
first="${expect_names%% *}"
case "$first" in
  ''|*:*)    sni='' ;;
  *[!0-9.]*) sni="$first" ;;
  *)         sni='' ;;
esac
if command -v timeout >/dev/null 2>&1; then
  timeout "$timeout_s" openssl s_client -connect "${host}:${port}" \
    ${sni:+-servername "$sni"} -showcerts </dev/null >"$hs" 2>&1
  rc=$?
else
  openssl s_client -connect "${host}:${port}" \
    ${sni:+-servername "$sni"} -showcerts </dev/null >"$hs" 2>&1
  rc=$?
fi

if ! grep -q 'BEGIN CERTIFICATE' "$hs"; then
  # Distinguish the three ways this happens, because the operator action
  # differs: nothing listening, something listening that is not TLS, and a
  # TLS listener that rejected the handshake.
  if [ "$rc" = 124 ]; then
    verdict FAIL "${host}:${port} accepted a TCP connection but never completed a TLS handshake within ${timeout_s}s — something is listening there, but it is not serving TLS. SIP over TLS is unavailable and every client that registers over TLS fails closed"
  fi
  if grep -qiE 'connect:errno|Connection refused|No route to host' "$hs"; then
    verdict FAIL "nothing is listening on ${host}:${port} — the SIP TLS listener did not bind. Encrypted SIP is unavailable. Check the SIP edge's startup log for a certificate failure: Asterisk's entrypoint keeps serving UDP/TCP without TLS (sip-tls-cert.sh degrades on purpose and says so on stderr), whereas Kamailio does NOT — its tls module fails child init on an unreadable certificate and the daemon exits, taking UDP and TCP with it (measured: \"load_cert:error:...system lib\", then \"error in init_child(PROC_INT) -- exiting\")"
  fi
  verdict FAIL "the TLS handshake with ${host}:${port} presented no certificate (openssl exit ${rc}): $(grep -m1 -iE 'alert|error|failure' "$hs" | tr -d '\r' | cut -c1-160)"
fi

# A certificate came back, so a TLS server is there. Require a negotiated
# cipher as well: a certificate in the transcript with no cipher means the
# handshake was abandoned part-way.
cipher="$(sed -n 's/^.*Cipher *is *\(.*\)$/\1/p' "$hs" | head -1 | tr -d '\r ')"
case "$cipher" in
  ''|'(NONE)') verdict FAIL "${host}:${port} sent a certificate but negotiated no cipher — the TLS handshake did not complete" ;;
esac

# ── 2. The certificate it presented ───────────────────────────────────────
# Split the chain. The FIRST certificate is the leaf the client validates the
# hostname against; the rest are intermediates for the verify step.
awk '/BEGIN CERTIFICATE/{n++} n>0{print > ("'"$work"'/cert-" n ".pem")} /END CERTIFICATE/{}' "$hs"
leaf="$work/cert-1.pem"
[ -s "$leaf" ] || verdict FAIL "could not read the certificate ${host}:${port} presented out of the handshake transcript"

subject="$(openssl x509 -in "$leaf" -noout -subject 2>/dev/null || echo '(unreadable)')"

if ! openssl x509 -in "$leaf" -noout -checkend 0 >/dev/null 2>&1; then
  not_after="$(openssl x509 -in "$leaf" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')"
  verdict FAIL "the certificate on ${host}:${port} EXPIRED on ${not_after:-an unknown date} (${subject}) — every client verifies the chain, so each one fails the handshake closed and no volunteer is reachable over TLS"
fi

# ── 3. Hostname coverage ──────────────────────────────────────────────────
# A client verifies the name as well as the chain, so a certificate that does
# not cover the name a volunteer dials is rejected however it is anchored.
if [ -n "$expect_names" ]; then
  # `openssl x509 -ext` prints a header line ("X509v3 Subject Alternative
  # Name:") before the entries; drop it so the SAN list in a failure message is
  # the SANs and nothing else. Entries are `type:value`, and the type openssl
  # prints for an IP is `IP Address` — WITH a space, which is why the spaces go
  # before the split and the filter keys off the header text rather than a
  # whitelist of type names.
  sans="$(openssl x509 -in "$leaf" -noout -ext subjectAltName 2>/dev/null \
            | grep -v 'Subject Alternative Name' | tr -d ' \r' | tr ',' '\n' \
            | sed '/^$/d' || true)"
  cn="$(printf '%s' "$subject" | sed -n 's/.*CN *= *\([^,/]*\).*/\1/p' | tr -d ' ')"
  for want in $expect_names; do
    matched=no
    if [ -n "$sans" ]; then
      for entry in $sans; do
        value="${entry#*:}"
        [ "$(printf '%s' "$value" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$want" | tr 'A-Z' 'a-z')" ] && { matched=yes; break; }
        # A wildcard SAN matches exactly one label (RFC 6125 §6.4.3).
        case "$value" in
          '*.'*)
            suffix="${value#\*.}"
            stem="${want%%.*}"
            [ "$want" != "$stem" ] && [ "${want#*.}" = "$suffix" ] && { matched=yes; break; }
            ;;
        esac
      done
    elif [ -n "$cn" ] && [ "$(printf '%s' "$cn" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$want" | tr 'A-Z' 'a-z')" ]; then
      # Only consulted when there are NO SANs at all: a certificate that has
      # SANs is matched on those alone, which is what every modern TLS stack
      # does.
      matched=yes
    fi
    if [ "$matched" = no ]; then
      verdict FAIL "the certificate on ${host}:${port} does not cover \"${want}\" (${subject}; SANs: $(printf '%s' "$sans" | tr '\n' ' ' | sed 's/ $//')) — a client verifies the hostname as well as the chain, so it will reject this certificate however it is anchored. Add the name to kamailio_tls_sans and regenerate"
    fi
  done
fi

# ── 4. The anchor clients actually use ────────────────────────────────────
# The app publishes this anchor to clients in the authenticated /sip-token
# response and they verify the SIP leg against it ALONE. So verifying against
# the host's CA bundle would measure the wrong trust root; this verifies
# against the file the clients get.
if [ -n "$ca_file" ]; then
  [ -s "$ca_file" ] \
    || verdict FAIL "the deployment publishes a SIP trust anchor at ${ca_file}, but that file is missing or empty — clients receive no anchor and cannot verify the SIP edge, so they fail closed even though the listener is up"
  untrusted=''
  for extra in "$work"/cert-[2-9].pem; do
    [ -s "$extra" ] || continue
    cat "$extra" >>"$work/untrusted.pem"
  done
  [ -s "$work/untrusted.pem" ] && untrusted="-untrusted $work/untrusted.pem"
  # shellcheck disable=SC2086
  if ! verify_out="$(openssl verify -CAfile "$ca_file" $untrusted "$leaf" 2>&1)"; then
    verdict FAIL "the certificate on ${host}:${port} does NOT verify against the trust anchor this deployment publishes to clients (${ca_file}): $(printf '%s' "$verify_out" | tr -d '\r' | tr '\n' ' ' | cut -c1-200). Clients verify against that anchor alone, so every TLS registration fails"
  fi
  verdict PASS "TLS listener bound on ${host}:${port}, ${cipher}, certificate ${subject} verifies against the published anchor ${ca_file}"
fi

verdict PASS "TLS listener bound on ${host}:${port}, ${cipher}, certificate ${subject} (no anchor published — clients verify against their own trust store)"
