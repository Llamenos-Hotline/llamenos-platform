#!/usr/bin/env bash
# The ban-list hash key (BAN_HASH_KEY) is a secret FILE, never an environment
# variable: the server refuses it in the environment (apps/worker/lib/config.ts),
# so it can never land in .env, a `docker compose config` dump or a config backup.
# Local and test launchers create one with this helper and point the server at it
# with BAN_HASH_KEY_FILE (or mount it at /run/secrets/ban-hash-key).
#
# Never prints the key. Idempotent: an existing non-empty file is kept, so the
# bans a persistent dev database holds keep matching across restarts.

# ensure_ban_hash_key_file <path> [mode]
#   mode defaults to 0600 (the server runs as the same user). Pass 0444 for a file
#   that is bind-mounted into a container whose uid is not the owner's.
ensure_ban_hash_key_file() {
  local file="$1" mode="${2:-0600}" tmp
  if [ -s "$file" ]; then
    return 0
  fi
  # A directory this creates is 0700, so a file made world-readable (0444, for a
  # container uid that is not the owner) is still unreachable to other host users;
  # the Docker daemon (root) bind-mounts it regardless. An existing directory keeps
  # whatever mode its owner gave it.
  if [ ! -d "$(dirname "$file")" ]; then
    (umask 077; mkdir -p "$(dirname "$file")")
  fi
  tmp="$(umask 077; mktemp "$file.XXXXXX")"
  openssl rand -hex 32 > "$tmp"
  chmod "$mode" "$tmp"
  # mv is atomic: two launchers racing to create it both end up with one valid file.
  mv -f "$tmp" "$file"
}
