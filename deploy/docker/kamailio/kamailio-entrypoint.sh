#!/bin/sh
# Start Kamailio with a TLS certificate in place.
#
# The TLS listener (kamailio.cfg listen=tls:…:5061) needs a certificate at
# /etc/kamailio/cert.pem, the tls module's default path. Kamailio is the SIP
# edge in the full deployment — asterisk publishes no ports — so this is the
# certificate a volunteer's client actually verifies, and the one whose public
# trust anchor the app publishes in /api/telephony/sip-token. sip-tls-cert.sh
# generates it (covering every name in SIP_TLS_SANS, since the client checks
# the hostname too) and exports that anchor. A missing openssl leaves the TLS
# listener unbound and Kamailio still serves UDP/TCP.
set -eu

/bin/sh /usr/local/share/llamenos/sip-tls-cert.sh \
  /etc/kamailio/cert.pem \
  "${SIP_TLS_ANCHOR_OUT:-/var/lib/llamenos/sip-tls/kamailio.pem}"

# The image's own command (compose clears CMD when it overrides the entrypoint).
exec kamailio -DD -E -m "${SHM_MEMORY:-64}" -M "${PKG_MEMORY:-8}" -f /etc/kamailio/kamailio.cfg
