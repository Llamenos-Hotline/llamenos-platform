#!/bin/sh
# Prepare Asterisk's writable state, then start it.
#
# The SIP trunk is not configured here. The app provisions it through ARI
# (POST /api/provider-setup/create-sip-trunk), and sorcery.conf keeps the trunk's
# PJSIP objects in astdb — the directory below, which compose mounts as a volume,
# so a provisioned trunk survives restarts and container re-creation.
#
# Runs as root (compose sets `user: root`) only so it can hand the fresh volume
# to the asterisk user — Docker creates a mount point the image lacks as root.
# Asterisk itself drops to asterisk:asterisk (-U/-G) as it starts.
set -eu

astdb_dir=/var/lib/asterisk/astdb
mkdir -p "$astdb_dir"
chown asterisk:asterisk "$astdb_dir"
chmod 700 "$astdb_dir"

# ARI stores recordings here and does not create the directory itself: without
# it every call recording and voicemail fails with "No such file or directory".
mkdir -p /var/spool/asterisk/recording
chown asterisk:asterisk /var/spool/asterisk/recording

# Operator-uploaded IVR prompts are played straight from the app's URL
# (ARI `sound:http://…/api/ivr-audio/…`). res_http_media_cache downloads each
# into this directory first, and the image lacks it: without it every fetch
# fails with "Failed to create temporary storage" and the caller hears nothing.
mkdir -p /var/cache/asterisk
chown asterisk:asterisk /var/cache/asterisk

# TLS + WSS transports (pjsip.conf transport-tls/transport-wss) read a
# certificate and a key. Their paths are configurable:
#
#   ASTERISK_TLS_CERT_FILE  certificate PEM  (default /var/lib/asterisk/keys/asterisk.pem)
#   ASTERISK_TLS_KEY_FILE   private key PEM  (default: the same file as the
#                                             certificate — a combined PEM)
#
# The defaults reproduce the previous hardcoded paths exactly, so a deployment
# that sets neither behaves byte for byte as before. They are TWO settings
# because a real certificate is two files: Let's Encrypt via Caddy gives
# `<domain>.crt` + `<domain>.key`, certbot `fullchain.pem` + `privkey.pem`, and
# a single path cannot name either pair. See .env.example for the recipe that
# points these at Caddy's Let's Encrypt storage.
#
# The default lives OUTSIDE /etc/asterisk, which is mounted read-only.
# sip-tls-cert.sh generates a self-signed keypair when none is present —
# covering every name in SIP_TLS_SANS, because a client verifies the hostname
# as well as the chain — and exports the PUBLIC trust anchor to the shared
# volume the app serves it from (SIP_TLS_CA_FILE). See that script's header for
# why the anchor travels over the pinned API channel. A certificate that is
# already there is left untouched, permissions included: an ACME certificate is
# mounted read-only and chmod-ing it would abort this entrypoint.
#
# Only the component that terminates the CLIENT's TLS is the one whose anchor
# clients need. In the full deployment that is Kamailio (asterisk publishes no
# ports); in the dev/e2e stack Asterisk is the edge. Each writes its own file
# name so the two never race, and the compose file points SIP_TLS_CA_FILE at
# whichever is the edge.
keys_dir=/var/lib/asterisk/keys
tls_cert_file="${ASTERISK_TLS_CERT_FILE:-$keys_dir/asterisk.pem}"
tls_key_file="${ASTERISK_TLS_KEY_FILE:-$tls_cert_file}"
mkdir -p "$keys_dir"
chown asterisk:asterisk "$keys_dir"
chmod 700 "$keys_dir"
/bin/sh /usr/local/share/llamenos/sip-tls-cert.sh \
  "$tls_cert_file" \
  "$tls_key_file" \
  "${SIP_TLS_ANCHOR_OUT:-/var/lib/llamenos/sip-tls/asterisk.pem}" \
  asterisk:asterisk

# pjsip.conf's transport-tls points ca_list_file at this copy of our own
# certificate. Asterisk hands pjproject an EMPTY ca buffer when no CA list is
# configured, and pjproject logs "Error reading CA certificates from buffer"
# on every inbound TLS connection — noise that reads like a trust failure and
# is not one (clients authenticate with a digest secret, not a client
# certificate; verify_client stays off). A readable, non-empty list silences
# it and states the intent: this transport trusts nothing but us.
#
# `openssl x509` takes the FIRST certificate only, so a fullchain.pem yields
# the leaf and no key material can reach this file. It is written into
# keys_dir, which is always writable, never next to a read-only mounted
# certificate.
ca_list_file="$keys_dir/ca-list.pem"
if [ -s "$tls_cert_file" ] && command -v openssl >/dev/null 2>&1; then
  openssl x509 -in "$tls_cert_file" -out "$ca_list_file" 2>/dev/null || true
  [ -s "$ca_list_file" ] && chown asterisk:asterisk "$ca_list_file" \
    && chmod 644 "$ca_list_file"
fi

# NAT media and signalling addresses for the transports (pjsip.conf #includes
# this directory last, so `(+)` extends the categories defined there).
#
# Asterisk otherwise advertises the address it sees on its own interface — a
# container address in any compose deployment. Signalling then succeeds through
# Kamailio while `c=` names an address the volunteer cannot route to, so media
# silently never arrives. Setting SIP_EXTERNAL_ADDRESS to the deployment's
# public SIP address is what makes the media leg reachable at all; unset leaves
# the transports exactly as pjsip.conf declares them, which is correct only
# when the PBX shares a flat network with its clients.
#
# The RTP ports themselves are bounded by rtp.conf (10000-10199) and must be
# open in the host firewall; the address here is useless without them.
#
# The file is written unconditionally — a comment-only placeholder when
# SIP_EXTERNAL_ADDRESS is unset. Asterisk's #include treats a glob that matches
# nothing as an ERROR ("was listed as a #include but it does not exist"), once
# per module that reads pjsip.conf, so an absent file would mean a dozen error
# lines on every boot of every deployment that does not set it.
pjsip_frag_dir=/var/lib/asterisk/pjsip.d
rm -rf "$pjsip_frag_dir"
mkdir -p "$pjsip_frag_dir"
{
  echo "; Generated by asterisk-entrypoint.sh from SIP_EXTERNAL_ADDRESS. Do not edit."
  if [ -n "${SIP_EXTERNAL_ADDRESS:-}" ]; then
    for transport in transport-udp transport-tcp transport-tls transport-wss; do
      echo "[$transport](+)"
      echo "external_media_address = ${SIP_EXTERNAL_ADDRESS}"
      echo "external_signaling_address = ${SIP_EXTERNAL_ADDRESS}"
      # Peers inside these ranges are reached directly; everyone else gets the
      # external address. Defaults to the RFC 1918 space compose networks use.
      for net in ${SIP_LOCAL_NETS:-10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}; do
        echo "local_net = $net"
      done
      echo
    done
  else
    echo "; SIP_EXTERNAL_ADDRESS is unset: the transports advertise the address"
    echo "; Asterisk sees on its own interface. Correct only where the PBX shares"
    echo "; a flat network with its clients."
  fi
} >"$pjsip_frag_dir/nat.conf"

# TLS certificate/key paths for the two TLS transports.
#
# These live in a generated fragment rather than literally in pjsip.conf for
# one reason: /etc/asterisk is mounted READ-ONLY, so pjsip.conf cannot be
# rendered in place, and the `#include` of this directory is the mechanism the
# file already uses for exactly this (see nat.conf above). pjsip.conf therefore
# declares the transports and this fragment supplies their key material — the
# ONLY place either option is set, so there is no override-precedence question
# about which assignment wins.
#
# When no certificate exists (no openssl, nothing mounted) the options are
# written anyway and point at a path that is not there: the TLS transport fails
# to load and is skipped, while UDP/TCP keep serving. That is the documented
# pre-existing behaviour, and sip-tls-cert.sh has already logged why.
{
  echo "; Generated by asterisk-entrypoint.sh from ASTERISK_TLS_CERT_FILE/"
  echo "; ASTERISK_TLS_KEY_FILE. Do not edit."
  for transport in transport-tls transport-wss; do
    echo "[$transport](+)"
    echo "cert_file = ${tls_cert_file}"
    echo "priv_key_file = ${tls_key_file}"
    # ca_list_file only for the native-SIP transport, and only when the file is
    # really there. Naming a path that does not exist is worse than naming
    # none: the whole point of the option is to stop pjproject complaining
    # about CA material, and it cannot be built without openssl. transport-wss
    # is fronted by Caddy in production and never needed it.
    if [ "$transport" = transport-tls ] && [ -s "$ca_list_file" ]; then
      echo "ca_list_file = ${ca_list_file}"
    fi
    echo
  done
} >"$pjsip_frag_dir/tls.conf"
echo "llamenos-sip-tls: Asterisk TLS certificate=$tls_cert_file key=$tls_key_file" >&2

chown -R asterisk:asterisk "$pjsip_frag_dir"
chmod 644 "$pjsip_frag_dir/nat.conf" "$pjsip_frag_dir/tls.conf"
if [ -n "${SIP_EXTERNAL_ADDRESS:-}" ]; then
  echo "llamenos-entrypoint: advertising ${SIP_EXTERNAL_ADDRESS} for SIP media and signalling" >&2
fi

# The image's own command (compose clears CMD when it overrides the entrypoint).
exec /usr/sbin/asterisk -vvvdddf -T -W -U asterisk -G asterisk -p
