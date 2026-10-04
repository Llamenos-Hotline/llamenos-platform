#!/bin/sh
# Start Kamailio with a TLS certificate in place.
#
# The TLS listener (kamailio.cfg listen=tls:…:5061) needs a certificate at
# /etc/kamailio/cert.pem, the tls module's default path. Generate a
# self-signed keypair when the operator has not mounted a real one — the same
# arrangement as the Asterisk entrypoint's /var/lib/asterisk/keys. A missing
# openssl leaves the TLS listener unbound and Kamailio still serves UDP/TCP.
set -eu

cert=/etc/kamailio/cert.pem
if [ ! -s "$cert" ]; then
  hostname_fqdn="$(hostname -f 2>/dev/null || hostname)"
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$cert" \
    -out "$cert" \
    -days 3650 -subj "/CN=${hostname_fqdn}" \
    -addext "subjectAltName=DNS:${hostname_fqdn},DNS:localhost,IP:127.0.0.1" \
    >/dev/null 2>&1 \
    || echo "kamailio-entrypoint: no certificate and openssl failed — the TLS listener will not bind" >&2
fi

# The image's own command (compose clears CMD when it overrides the entrypoint).
exec kamailio -DD -E -m "${SHM_MEMORY:-64}" -M "${PKG_MEMORY:-8}" -f /etc/kamailio/kamailio.cfg
