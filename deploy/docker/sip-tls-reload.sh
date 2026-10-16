#!/bin/sh
# Reload the SIP edge's TLS certificate after an ACME renewal.
#
# WHY THIS IS NOT OPTIONAL
#
# Let's Encrypt certificates live 90 days and Caddy renews at ~60. Neither
# Kamailio nor Asterisk notices: both read the certificate once, at module
# init, and hold the parsed material for the life of the process. So a
# deployment that points KAMAILIO_TLS_CERT_FILE at Caddy's storage and stops
# there works perfectly for two months and then starts serving an EXPIRED
# certificate, while the file on disk is valid and every log looks healthy.
# Clients verify the chain (verification is never off), so SIP registration
# fails closed: no calls reach any volunteer. That failure is strictly worse
# than the self-signed default, which never expires in under ten years.
#
# This script closes that gap. It is cheap and idempotent, so it is safe to run
# on a short timer: it reloads ONLY when the certificate on disk has actually
# changed, keyed on a hash of the file.
#
# Both reloads are in-process and do not drop existing calls:
#   * Kamailio `tls.reload` re-reads tls.cfg and the certificates it names.
#   * Asterisk `module reload res_pjsip.so` rebuilds the transports.
# Established TLS connections keep their negotiated session; the new
# certificate is served to connections made after the reload. A registered
# client re-registers on its own expiry cycle, so no client action is needed.
#
# Usage:  sip-tls-reload.sh [compose-dir]
#
#   compose-dir  directory holding the docker-compose.yml whose `kamailio` and
#                `asterisk` services should be reloaded. Defaults to this
#                script's own directory.
#
# Environment:
#   SIP_TLS_WATCH_FILE  the certificate to watch. Default: the first of
#                       KAMAILIO_TLS_CERT_FILE / ASTERISK_TLS_CERT_FILE that is
#                       set. Required if neither is.
#   SIP_TLS_STAMP_FILE  where the last-seen hash is recorded.
#                       Default /var/lib/llamenos/sip-tls-reload.stamp
#   COMPOSE_PROJECT_NAME, and any other compose variables, are honoured as
#                       usual — this shells out to `docker compose`.
set -eu

compose_dir="${1:-$(dirname "$0")}"
watch_file="${SIP_TLS_WATCH_FILE:-${KAMAILIO_TLS_CERT_FILE:-${ASTERISK_TLS_CERT_FILE:-}}}"
stamp_file="${SIP_TLS_STAMP_FILE:-/var/lib/llamenos/sip-tls-reload.stamp}"

log() { echo "llamenos-sip-tls-reload: $*" >&2; }

if [ -z "$watch_file" ]; then
  log "no certificate to watch (set SIP_TLS_WATCH_FILE, KAMAILIO_TLS_CERT_FILE"
  log "or ASTERISK_TLS_CERT_FILE). Nothing to do — a self-signed certificate"
  log "generated in-container never needs this."
  exit 0
fi

if [ ! -s "$watch_file" ]; then
  # Not an error worth failing a timer over: the path may legitimately not
  # exist yet on a first boot, before Caddy has completed its first issuance.
  log "certificate $watch_file is missing or empty — skipping"
  exit 0
fi

# Hash the PUBLIC certificate only. Never the key: this value is written to a
# stamp file and may appear in journal output.
hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

current="$(hash_of "$watch_file")"
previous=''
[ -s "$stamp_file" ] && previous="$(cat "$stamp_file")"

if [ "$current" = "$previous" ]; then
  exit 0
fi

log "certificate $watch_file changed — reloading the SIP edge"

# `docker compose ps -q` is empty for a service that is absent or stopped, so
# each reload is attempted only where the service is actually running. A
# reload failure is reported but does not abort the other service's reload:
# half a reload beats none, and the timer retries.
reload_rc=0
compose() { docker compose --project-directory "$compose_dir" "$@"; }

if [ -n "$(compose ps -q kamailio 2>/dev/null || true)" ]; then
  if compose exec -T kamailio kamcmd tls.reload >/dev/null 2>&1; then
    log "kamailio: tls.reload ok"
  else
    log "kamailio: tls.reload FAILED — it is still serving the old certificate"
    reload_rc=1
  fi
fi

if [ -n "$(compose ps -q asterisk 2>/dev/null || true)" ]; then
  if compose exec -T asterisk asterisk -rx 'module reload res_pjsip.so' >/dev/null 2>&1; then
    log "asterisk: res_pjsip reloaded"
  else
    log "asterisk: res_pjsip reload FAILED — it is still serving the old certificate"
    reload_rc=1
  fi
fi

# The stamp advances only on a clean reload, so a failure is retried on the
# next tick rather than being recorded as done.
if [ "$reload_rc" -eq 0 ]; then
  mkdir -p "$(dirname "$stamp_file")"
  printf '%s\n' "$current" >"$stamp_file"
  chmod 644 "$stamp_file"
fi
exit "$reload_rc"
