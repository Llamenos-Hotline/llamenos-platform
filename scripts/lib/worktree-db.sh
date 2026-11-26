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
#        isolated  its own database, llamenos_wt_<dir>_<hash> (scripts/worktree-db.ts).
#                  Every linked worktree is isolated by default and provisioned on
#                  first use; a fleet worker's worktree is isolated always (#2659)
#        shared    the shared `llamenos` database — a linked worktree that opted out
#                  with LLAMENOS_ALLOW_SHARED_DB=1 in its environment
#        unset     the primary checkout only: the shared `llamenos` database, with a
#                  warning every time — a checkout mid-task is never switched silently
#
# Before resolving, the dev cluster is secured (`worktree-db.ts secure-shared`, #2705):
# the well-known role `llamenos` — PG_PASSWORD, the one every worktree and every
# hand-typed URL uses — is READ-ONLY on the shared database, enforced by Postgres
# itself. Only the primary checkout resolves the shared database as `llamenos_owner`,
# with the password from its git dir (never .env, which every worktree symlinks).
#
# Whatever the URL came from — environment, .env, --shared, the resolver — it passes
# `worktree-db.ts check-url` before it is exported: a linked worktree that names the
# shared dev database is refused (a fleet worker's, unconditionally). A refusal is
# non-zero and exports nothing; there is no fallback to anything else.
#
# In a manual shell (e.g. running `bunx playwright test` directly), inside the worktree:
#   source scripts/lib/worktree-db.sh && worktree_db_export
#
# DATABASE_URL carries PG_PASSWORD or the owner secret. Never echo it — log
# worktree_db_redact output only.
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

# worktree_db_export [--ensure | --shared | --require-explicit]
#   --ensure  server launcher: create / forward-migrate this worktree's database first
#   --shared  the server under test is not this worktree's (e.g. the containerised
#             app in scripts/test-integration-full.sh, which always uses `llamenos`)
#   --require-explicit
#             the caller POINTED the suite at a particular server (TEST_HUB_URL),
#             so nothing here knows which database that server writes to. Refuse
#             to resolve one: DATABASE_URL must have been given (environment or
#             the checkout's .env). Resolving one would hand the suite THIS
#             machine's database while the server wrote to the target's, and
#             every direct-database assertion would then pass or fail for
#             reasons unrelated to what is under test. The worktree resolver is
#             a convenience for the server this machine started; aimed anywhere
#             else it is a false-green generator.
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
    DATABASE_URL="$DATABASE_URL" worktree_db_check_allowed DATABASE_URL || return 1
    export DATABASE_URL
    _worktree_db_log "DATABASE_URL set explicitly — using it as-is: $(worktree_db_redact "$DATABASE_URL")"
    return 0
  fi

  if [[ "$flag" == "--require-explicit" ]]; then
    _worktree_db_log "ERROR: DATABASE_URL is not set, and the suite was pointed at a specific"
    _worktree_db_log "       server. Refusing to resolve this worktree's database: the suite asserts"
    _worktree_db_log "       persisted state straight from PostgreSQL, so a database this machine"
    _worktree_db_log "       chose would make every one of those assertions meaningless against a"
    _worktree_db_log "       server that writes somewhere else."
    _worktree_db_log "       Set DATABASE_URL to the database THAT server writes to. For a deployed"
    _worktree_db_log "       target that means a tunnel to its PostgreSQL —"
    _worktree_db_log "       see docs/deploy/E2E_AGAINST_A_DEPLOYMENT.md."
    return 1
  fi

  # Secure the dev cluster BEFORE resolving: the resolver hands the primary checkout
  # the owner role only once the owner secret exists, which the first conversion
  # writes. A Postgres that is down or rejects PG_PASSWORD (exit 3) is reported and
  # left to the caller's own connection to fail on; anything else is fatal.
  if [[ "$flag" != "--shared" ]]; then
    local src=0
    bun "$root/scripts/worktree-db.ts" secure-shared --quiet || src=$?
    if [[ $src -eq 3 ]]; then
      _worktree_db_log "WARNING: could not check the shared database's boundary (see above)"
    elif [[ $src -ne 0 ]]; then
      return 1
    fi
  fi

  line="$(bun "$root/scripts/worktree-db.ts" resolve)" || return 1
  local how
  read -r mode db user host port how <<<"$line"
  # Provision when asked to, and whenever the database exists only because the
  # worktree's policy chose it (no marker yet): first use of a fresh worktree must
  # land on a working database of its own, not on the shared one.
  if [[ "$flag" != "--shared" && "$mode" == "isolated" && ( "$flag" == "--ensure" || "${how:-marker}" != "marker" ) ]]; then
    bun "$root/scripts/worktree-db.ts" ensure || return 1
  fi
  if [[ "$flag" == "--shared" ]]; then
    # The containerised app's database, in its own stack: that stack's one role.
    mode=shared
    db=llamenos
    user=llamenos
  fi

  case "$mode" in
    isolated)
      _worktree_db_log "database: $db (this worktree's own)" ;;
    shared)
      if [[ "$user" == "llamenos_owner" ]]; then
        _worktree_db_log "database: llamenos (SHARED; this primary checkout writes it as llamenos_owner)"
      else
        _worktree_db_log "database: llamenos (SHARED, as role $user — READ-ONLY on a secured dev cluster, #2705)"
      fi ;;
    *)
      _worktree_db_log "WARNING: this primary checkout has not chosen a database, so it is on the SHARED"
      _worktree_db_log "         'llamenos' database (as $user). Nothing was switched."
      _worktree_db_log "         Use its own:  bun scripts/worktree-db.ts use-isolated"
      _worktree_db_log "         Stay shared:  bun scripts/worktree-db.ts use-shared   (silences this warning)"
      ;;
  esac

  if [[ "$user" == "llamenos_owner" ]]; then
    # Same file as ownerSecretPath() in worktree-db.ts: the primary's git dir.
    local secret_file
    secret_file="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/llamenos-dev-db-owner"
    password="$(tr -d '[:space:]' <"$secret_file")" || {
      _worktree_db_log "ERROR: cannot read the owner credential ($secret_file)"
      return 1
    }
  else
    password="${PG_PASSWORD:-$(_worktree_db_dotenv PG_PASSWORD "$root/.env")}"
    password="${password:-dev}"
  fi
  password="$(_worktree_db_urlencode "$password")"
  local resolved="postgresql://${user}:${password}@${host}:${port}/${db}"
  DATABASE_URL="$resolved" worktree_db_check_allowed DATABASE_URL || return 1
  export DATABASE_URL="$resolved"
}

# worktree_db_check_allowed [VAR]
#   Refuse (non-zero, with the reason) when the URL in $VAR (default DATABASE_URL) names
#   the shared dev database and this worktree may not use it. The URL goes to the checker
#   in the environment, never argv: it carries the password.
worktree_db_check_allowed() {
  local var="${1:-DATABASE_URL}" root rc=0
  root="$(git rev-parse --show-toplevel 2>/dev/null)" || return 0   # no git: nothing to protect
  bun "$root/scripts/worktree-db.ts" check-url --env "$var" || rc=$?
  return "$rc"
}
