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

# TLS + WSS transports (pjsip.conf transport-tls/transport-wss) and DTLS-SRTP
# read /var/lib/asterisk/keys/asterisk.pem, which lives OUTSIDE /etc/asterisk
# (mounted read-only) and does not exist on a fresh container. Generate a
# self-signed keypair for the container's hostname when none is mounted: dev
# and CI get working TLS/WSS; a production deploy mounts a real certificate
# over this path and the generation is skipped.
keys_dir=/var/lib/asterisk/keys
if [ ! -s "$keys_dir/asterisk.pem" ]; then
  mkdir -p "$keys_dir"
  if ! command -v openssl >/dev/null 2>&1; then
    # The pinned image ships no openssl. Install it for this one-shot
    # generation; a container with no route to the archive skips TLS/WSS (the
    # transports fail to load and are skipped — UDP/TCP keep working). A
    # mounted real certificate never reaches this branch.
    apt-get update >/dev/null 2>&1 && apt-get install -y --no-install-recommends openssl >/dev/null 2>&1 || true
  fi
  if command -v openssl >/dev/null 2>&1; then
    hostname_fqdn="$(hostname -f 2>/dev/null || hostname)"
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$keys_dir/asterisk.pem" \
      -out "$keys_dir/asterisk.pem" \
      -days 3650 -subj "/CN=${hostname_fqdn}" \
      -addext "subjectAltName=DNS:${hostname_fqdn},DNS:localhost,IP:127.0.0.1" \
      >/dev/null 2>&1
    chown asterisk:asterisk "$keys_dir/asterisk.pem"
    chmod 600 "$keys_dir/asterisk.pem"
  else
    echo "llamenos-entrypoint: no openssl and no mounted certificate — TLS/WSS transports will not load" >&2
  fi
fi

# The image's own command (compose clears CMD when it overrides the entrypoint).
exec /usr/sbin/asterisk -vvvdddf -T -W -U asterisk -G asterisk -p
