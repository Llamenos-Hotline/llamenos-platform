#!/bin/sh
# Render the SIP trunk from the environment, then start Asterisk.
#
# Asterisk cannot read environment variables in its config files, so the trunk
# that pjsip.conf #includes is written here at container start (the ARI
# password gets the same treatment via the compose `ari_credentials` config).
#
#   SIP_PROVIDER   carrier host[:port] — required for any PSTN call to route
#   SIP_USERNAME   } optional: set both for a registration trunk with digest
#   SIP_PASSWORD   } auth; leave both unset for an IP-authenticated trunk
#
# Volunteer phones are rung as PJSIP/<number>@trunk, and inbound calls from the
# carrier are matched to the `trunk` endpoint by source address and land in the
# [from-trunk] dialplan context.
set -eu

trunk_conf=/var/lib/asterisk/pjsip-trunk.conf
: "${SIP_PROVIDER:=}"
: "${SIP_USERNAME:=}"
: "${SIP_PASSWORD:=}"

if [ -z "$SIP_PROVIDER" ]; then
  echo "WARNING: SIP_PROVIDER is not set — Asterisk has no SIP trunk. No inbound call can reach the hotline and no volunteer phone can be rung." >&2
  : > "$trunk_conf"
elif [ -n "$SIP_USERNAME" ] && [ -z "$SIP_PASSWORD" ] || [ -z "$SIP_USERNAME" ] && [ -n "$SIP_PASSWORD" ]; then
  echo "FATAL: set both SIP_USERNAME and SIP_PASSWORD (registration trunk) or neither (IP-authenticated trunk)." >&2
  exit 1
else
  provider_host=${SIP_PROVIDER%%:*}
  {
    echo "[trunk]"
    echo "type = aor"
    echo "contact = sip:$SIP_PROVIDER"
    echo "qualify_frequency = 60"
    echo
    echo "[trunk]"
    echo "type = endpoint"
    echo "context = from-trunk"
    echo "disallow = all"
    echo "allow = ulaw,alaw"
    echo "aors = trunk"
    echo "direct_media = no"
    echo "rtp_symmetric = yes"
    echo "force_rport = yes"
    echo "rewrite_contact = yes"
    echo "dtmf_mode = rfc4733"
    if [ -n "$SIP_USERNAME" ]; then
      echo "outbound_auth = trunk-auth"
      echo "from_user = $SIP_USERNAME"
      echo "from_domain = $provider_host"
    fi
    echo
    echo "[trunk]"
    echo "type = identify"
    echo "endpoint = trunk"
    echo "match = $provider_host"
    if [ -n "$SIP_USERNAME" ]; then
      echo
      echo "[trunk-auth]"
      echo "type = auth"
      echo "auth_type = userpass"
      echo "username = $SIP_USERNAME"
      echo "password = $SIP_PASSWORD"
      echo
      echo "[trunk]"
      echo "type = registration"
      echo "outbound_auth = trunk-auth"
      echo "server_uri = sip:$SIP_PROVIDER"
      echo "client_uri = sip:$SIP_USERNAME@$SIP_PROVIDER"
      echo "contact_user = $SIP_USERNAME"
      echo "retry_interval = 60"
    fi
  } > "$trunk_conf"
  chmod 600 "$trunk_conf"
  echo "SIP trunk configured for $provider_host ($([ -n "$SIP_USERNAME" ] && echo registration || echo IP-authenticated))" >&2
fi

# ARI stores recordings here and does not create the directory itself: without
# it every call recording and voicemail fails with "No such file or directory".
mkdir -p /var/spool/asterisk/recording

# The image's own command (compose clears CMD when it overrides the entrypoint).
exec /usr/sbin/asterisk -vvvdddf -T -W -U asterisk -p
