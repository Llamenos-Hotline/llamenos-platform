#!/bin/sh
# Start Kamailio with a TLS certificate in place.
#
# The TLS listener (kamailio.cfg listen=tls:…:5061) needs a certificate and a
# key. Kamailio is the SIP edge in the full deployment — asterisk publishes no
# ports — so this is the certificate a volunteer's client actually verifies,
# and the one whose public trust anchor the app publishes in
# /api/telephony/sip-token. sip-tls-cert.sh generates it (covering every name
# in SIP_TLS_SANS, since the client checks the hostname too) and exports that
# anchor. A missing openssl leaves the TLS listener unbound and Kamailio still
# serves UDP/TCP.
#
# CONFIGURABLE PATHS
#
#   KAMAILIO_TLS_CERT_FILE  certificate PEM         (default /etc/kamailio/cert.pem)
#   KAMAILIO_TLS_KEY_FILE   private key PEM         (default: same file as the
#                                                    certificate — a combined
#                                                    cert+key PEM)
#
# The defaults reproduce the previous hardcoded behaviour byte for byte. Point
# them at a real certificate to serve one instead — in particular at the
# Let's Encrypt material Caddy already holds for DOMAIN, which is the
# encouraged production arrangement:
#
#   KAMAILIO_TLS_CERT_FILE=/etc/llamenos/sip-tls/certificates/\
#     acme-v02.api.letsencrypt.org-directory/<domain>/<domain>.crt
#   KAMAILIO_TLS_KEY_FILE=…/<domain>.key
#   SIP_TLS_CA_FILE=            # publish no anchor; the chain is public
#
# See .env.example ("Telephony: SIP TLS trust") for the full recipe, including
# the read-only mount and why a renewal needs `kamcmd tls.reload`.
#
# tls.cfg is RENDERED, not mounted: it holds the two paths literally and has no
# variable expansion of its own, so the values can only reach Kamailio by
# substitution. /etc/kamailio is the image's own directory (only individual
# files are bind-mounted into it), so writing there is fine.
set -eu

cert_file="${KAMAILIO_TLS_CERT_FILE:-/etc/kamailio/cert.pem}"
key_file="${KAMAILIO_TLS_KEY_FILE:-$cert_file}"

/bin/sh /usr/local/share/llamenos/sip-tls-cert.sh \
  "$cert_file" \
  "$key_file" \
  "${SIP_TLS_ANCHOR_OUT:-/var/lib/llamenos/sip-tls/kamailio.pem}"

# Substitution is done with `sed` rather than `envsubst`: the pinned image
# ships no gettext-base, and a missing envsubst would silently emit a tls.cfg
# with empty paths. The `|` delimiter keeps absolute paths readable, and paths
# containing `|` are not a case worth supporting.
template=/usr/local/share/llamenos/tls.cfg.template
rendered=/etc/kamailio/tls.cfg
sed -e "s|@KAMAILIO_TLS_CERT_FILE@|${cert_file}|g" \
    -e "s|@KAMAILIO_TLS_KEY_FILE@|${key_file}|g" \
    "$template" >"$rendered"
chmod 644 "$rendered"
echo "llamenos-sip-tls: Kamailio TLS certificate=$cert_file key=$key_file" >&2

# The image's own command (compose clears CMD when it overrides the entrypoint).
exec kamailio -DD -E -m "${SHM_MEMORY:-64}" -M "${PKG_MEMORY:-8}" -f /etc/kamailio/kamailio.cfg
