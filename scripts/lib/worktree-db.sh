# shellcheck shell=bash
#
# The ONE place local development composes DATABASE_URL.
#
# Sourced by the server launcher (scripts/dev-bun.sh) and the test launcher
# (scripts/test-backend-bdd.sh), so the server and TestDB (tests/db-helpers.ts)
# resolve the same database by construction; the TestDB identity check then
# has nothing to disagree about. Resolution, identical for every caller:
#
#   1. DATABASE_URL already set — in the environment or in the checkout's .env —
#      is used as-is. An explicit choice always wins (CI sets one per job).
#   2. Otherwise the worktree's choice, from `bun scripts/worktree-db.ts resolve`:
#        isolated  its own database, llamenos_wt_<dir>_<hash> (scripts/worktree-db.ts)
#        shared    the shared `llamenos` database — the worktree opted out
#        unset     the shared `llamenos` database, with a warning every time: a
#                  worktree mid-task is never switched without asking
#
# In a manual shell (e.g. running `bunx playwright test` directly), inside the worktree:
#   source scripts/lib/worktree-db.sh && worktree_db_export
#
# DATABASE_URL carries PG_PASSWORD. Never echo it — log worktree_db_redact output only.
# Works when sourced from bash or zsh.

_worktree_db_log() { printf '[worktree-db] %s\n' "$*" >&2; }

# Value of the last KEY=... line in FILE, surrounding quotes stripped. Empty if absent.
_worktree_db_dotenv() {
  [[ -f "$2" ]] || return 0
  sed -n -E "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" "$2" \
    | tail -n 1 \
    | sed -E "s/[[:space:]]+\$//; s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/"
}

_worktree_db_urlencode() {
  # Byte-wise, so a non-ASCII password is encoded as its UTF-8 bytes.
  local LC_ALL=C s="$1" out="" c i
  for (( i = 0; i < ${#s}; i++ )); do
    c="${s:$i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *) out+="$(printf '%%%02X' "'$c")" ;;
    esac
  done
  printf '%s' "$out"
}

# postgresql://user:secret@host/db → postgresql://user:***@host/db
worktree_db_redact() {
  printf '%s' "$1" | sed -E 's#(://[^:/@]+:)[^@]*@#\1***@#'
}

# worktree_db_export [--ensure | --shared]
#   --ensure  server launcher: create / forward-migrate this worktree's database first
#   --shared  the server under test is not this worktree's (e.g. the containerised
#             app in scripts/test-integration-full.sh, which always uses `llamenos`)
worktree_db_export() {
  local flag="${1:-}" root line mode db user host port password
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    _worktree_db_log "ERROR: not inside a git worktree"
    return 1
  }

  if [[ -z "${DATABASE_URL:-}" ]]; then
    local from_dotenv
    from_dotenv="$(_worktree_db_dotenv DATABASE_URL "$root/.env")"
    if [[ -n "$from_dotenv" ]]; then DATABASE_URL="$from_dotenv"; fi
  fi
  if [[ -n "${DATABASE_URL:-}" ]]; then
    export DATABASE_URL
    _worktree_db_log "DATABASE_URL set explicitly — using it as-is: $(worktree_db_redact "$DATABASE_URL")"
    return 0
  fi

  line="$(bun "$root/scripts/worktree-db.ts" resolve)" || return 1
  read -r mode db user host port <<<"$line"
  if [[ "$flag" == "--ensure" && "$mode" == "isolated" ]]; then
    bun "$root/scripts/worktree-db.ts" ensure || return 1
  fi
  if [[ "$flag" == "--shared" ]]; then
    mode=shared
    db=llamenos
  fi

  case "$mode" in
    isolated)
      _worktree_db_log "database: $db (this worktree's own)" ;;
    shared)
      _worktree_db_log "database: llamenos (SHARED with every worktree that has not opted in)" ;;
    *)
      _worktree_db_log "WARNING: this worktree has not chosen a database, so it is on the SHARED 'llamenos'"
      _worktree_db_log "         database, which every other worktree's test-reset wipes. Nothing was switched."
      _worktree_db_log "         Use its own:  bun scripts/worktree-db.ts use-isolated"
      _worktree_db_log "         Stay shared:  bun scripts/worktree-db.ts use-shared   (silences this warning)"
      ;;
  esac

  password="${PG_PASSWORD:-$(_worktree_db_dotenv PG_PASSWORD "$root/.env")}"
  password="$(_worktree_db_urlencode "${password:-dev}")"
  export DATABASE_URL="postgresql://${user}:${password}@${host}:${port}/${db}"
}
