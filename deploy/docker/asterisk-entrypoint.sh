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

# The image's own command (compose clears CMD when it overrides the entrypoint).
exec /usr/sbin/asterisk -vvvdddf -T -W -U asterisk -G asterisk -p
