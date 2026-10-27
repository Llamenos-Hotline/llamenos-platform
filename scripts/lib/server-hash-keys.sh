#!/usr/bin/env bash
# The server's hash keys are secret FILES, never environment variables: the server
# refuses them in the environment (apps/worker/lib/config.ts), so they can never land
# in .env, a `docker compose config` dump or a config backup. There are two, each
# keying one hash and nothing else:
#
#   ban-hash-key        BAN_HASH_KEY        the ban-list hash
#   messaging-hash-key  MESSAGING_HASH_KEY  the per-hub messaging-thread hash
#
# Local and test launchers create them with this helper and point the server at them
# with BAN_HASH_KEY_FILE / MESSAGING_HASH_KEY_FILE (or mount them at /run/secrets/<name>).
# A launcher that supplied one key and forgot the other would boot into the config
# check's refusal, so every launcher goes through these functions and not through its
# own openssl call.
#
# Never prints a key. Idempotent: an existing non-empty file is kept, so the bans and
# threads a persistent dev database holds keep matching across restarts.

# The file name of each key, which is also its /run/secrets name.
HASH_KEY_NAMES=(ban-hash-key messaging-hash-key)

# ensure_hash_key_file <path> [mode]
#   Create one key file if it is missing or empty. mode defaults to 0600 (the server
#   runs as the same user). Pass 0444 for a file that is bind-mounted into a container
#   whose uid is not the owner's.
ensure_hash_key_file() {
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

# ensure_hash_key_files <dir> [mode]
#   Create every key file in <dir> (the compose `secrets/` directory, the CI secrets
#   directory). Both are created together so a launcher cannot supply only one.
ensure_hash_key_files() {
  local dir="$1" mode="${2:-0600}" name
  for name in "${HASH_KEY_NAMES[@]}"; do
    ensure_hash_key_file "$dir/$name" "$mode"
  done
}

# export_hash_key_files <dir>
#   For a server run directly on the host (dev, the native-backend scripts): point
#   BAN_HASH_KEY_FILE and MESSAGING_HASH_KEY_FILE at <dir>/<name> unless the caller
#   already set them, export them, and create the files.
export_hash_key_files() {
  local dir="$1" name var path
  for name in "${HASH_KEY_NAMES[@]}"; do
    var="$(printf '%s_FILE' "$name" | tr 'a-z-' 'A-Z_')"
    path="${!var:-$dir/$name}"
    export "$var=$path"
    ensure_hash_key_file "$path"
  done
}
