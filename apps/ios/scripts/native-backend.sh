#!/usr/bin/env bash
# Run the Llámenos backend natively on macOS, for the iOS XCUITest suite.
#
# Why this exists (#661): GitHub-hosted macOS runners have no Docker, so the
# compose-based .github/actions/bootstrap-backend exits 125 before a single
# test runs. The Mac mini used for local iOS work has no Docker either. This
# starts the same server the compose `app` service runs — same source, the
# same migration runner the Docker image uses (scripts/run-migrations.ts), the
# same dev-route gates as deploy/docker/docker-compose.test.yml — against a
# Homebrew PostgreSQL 17 (the major version compose pins).
#
# What it deliberately does NOT start, and why that is safe for this suite:
#   - S3 storage (RustFS). No iOS UI test uploads or downloads a file, and a
#     failed hub bucket provisioning is logged and non-fatal
#     (apps/worker/routes/hubs.ts). The server refuses to boot without storage
#     credentials but only connects on use, so they are set and pointed at a
#     port nothing listens on: any storage call fails loudly instead of
#     silently. A test that needs storage must add a real S3 service here.
#   - signal-notifier / sip-bridge sidecars. No iOS UI test exercises them.
#
# Usage (from the repo root):
#   apps/ios/scripts/native-backend.sh start    # returns once /api/health/live answers
#   apps/ios/scripts/native-backend.sh stop
#   apps/ios/scripts/native-backend.sh reclaim  # CI only — see "Leaked backends" below
#
# Requires Homebrew, bun (with `bun install` already run), and the server
# crypto library at packages/crypto/dist/server/libllamenos_core.dylib
# (packages/crypto/scripts/build-server.sh builds it).
#
# ---------------------------------------------------------------------------
# Leaked backends, and why three mechanisms guard the port (#1639)
# ---------------------------------------------------------------------------
# On a persistent self-hosted runner a leaked server is not an untidy process,
# it is an outage. The ports are allocated per RUNNER (ios-e2e.yml, "Allocate
# this runner's backend ports"), so a server that outlives its job holds the
# port that the NEXT job on that runner needs. One leak on one runner failed
# every following shard in ~48s at startup, each failure ejected a merge group,
# each ejection cancelled more jobs, and each cancellation leaked another
# backend. The loop sustained itself for 5h34m against a 65-minute job cap.
#
# `if: always()` teardown is not enough, because the case that leaks is the
# case where nothing in the job runs again: a hard cancellation can kill the
# job before the teardown step is ever reached. So:
#
#   1. `start` puts the server in its own SESSION, so `stop` can signal the
#      whole tree rather than a version-manager shim that leaves the real
#      server running.
#   2. `start` also launches a WATCHDOG that outlives the step and tears the
#      backend down as soon as the runner's job process goes away — the
#      cancellation case, covered without the job having to run anything.
#   3. `reclaim`, run at the START of the next job, frees the port if both of
#      the above somehow failed. This is the layer that actually breaks the
#      loop: it needs nothing of the job that leaked.
#
# None of these may ever match on the binary name. This host is also somebody's
# development machine and their own `bun run dev:server` is a bun process too;
# killing it would destroy their work. Ownership is proved by an argv marker
# this script stamps, or by the process running out of the runner's own work
# tree — and `reclaim` refuses outright to act on the 3000/5432 defaults.
#
# Environment:
#   NATIVE_BACKEND_PORT  HTTP port (default 3000 — BaseUITest's default TEST_HUB_URL)
#   NATIVE_BACKEND_PGPORT  PostgreSQL port (default 5432)
#   NATIVE_BACKEND_DIR   State directory: pgdata, logs, pid (default $RUNNER_TEMP or /tmp)
#   NATIVE_BACKEND_TTL_SECONDS  Watchdog deadline (default 4500 — the shard job cap is 65 min)
#   NATIVE_BACKEND_GUARD_PID    Override the auto-detected job process the watchdog follows
#   ADMIN_PUBKEY         Admin signing pubkey the server seeds (default: the CI test admin)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
# Recorded BEFORE defaulting: everything that kills a process keys off this.
# Unset ports mean a developer running the script by hand, where 3000/5432 are
# very likely their own server and their own PostgreSQL.
PORTS_ALLOCATED=0
if [[ -n "${NATIVE_BACKEND_PORT:-}" && -n "${NATIVE_BACKEND_PGPORT:-}" ]]; then
  PORTS_ALLOCATED=1
fi
PORT="${NATIVE_BACKEND_PORT:-3000}"
PGPORT="${NATIVE_BACKEND_PGPORT:-5432}"
STATE_DIR="${NATIVE_BACKEND_DIR:-${RUNNER_TEMP:-/tmp}/llamenos-native-backend}"
PGDATA="$STATE_DIR/pgdata"
SERVER_LOG="$STATE_DIR/server.log"
SERVER_PID="$STATE_DIR/server.pid"
WATCHDOG_LOG="$STATE_DIR/watchdog.log"
WATCHDOG_PID="$STATE_DIR/watchdog.pid"
PG_FORMULA="postgresql@17"
CRYPTO_LIB="$ROOT/packages/crypto/dist/server/libllamenos_core.dylib"
DATABASE_URL="postgresql://llamenos@127.0.0.1:${PGPORT}/llamenos"
# Same value as TEST_ADMIN_PUBKEY in ci.yml / desktop-e2e.yml.
ADMIN_PUBKEY="${ADMIN_PUBKEY:-79215a4c04f08fcd817c6f820c87169beb8cddf96dfa590a1315556b78af9183}"
# Stamped into the server's argv by `start` and looked for by `reclaim`. The
# server ignores argv entirely, so this is a label and nothing else.
MARKER="llamenos-native-backend"
# Comfortably past a legitimate shard (65-minute job cap) and nowhere near the
# 5h34m a leak survived with no deadline at all.
TTL="${NATIVE_BACKEND_TTL_SECONDS:-4500}"
# Ports this script will never kill anything on, whatever else it concludes.
# They are the conventional defaults a person's own `bun run dev:server` and
# local PostgreSQL use, and this runner host is also a development machine.
PROTECTED_PORTS="3000 5432"

log() { echo "[native-backend] $*"; }
warn() { echo "[native-backend] WARNING: $*" >&2; }
die() { echo "[native-backend] ERROR: $*" >&2; exit 1; }

pg_bin() {
  echo "$(brew --prefix "$PG_FORMULA")/bin"
}

# --- process and port inspection (identical idioms on macOS and Linux) ------

port_listener_pids() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
}

port_in_use() {
  [[ -n "$(port_listener_pids "$1")" ]]
}

# Read for MATCHING only, never printed. A run log on a public repo is public:
# a stranger's argv can carry their credentials, and even our own carries the
# runner's absolute paths and therefore its user account.
pid_argv() { ps -p "$1" -o command= 2>/dev/null || true; }

# Enough to tell a reader WHICH process is in the way — program and age — and
# nothing that identifies the host or its owner.
pid_description() {
  local comm etime
  comm="$(ps -p "$1" -o comm= 2>/dev/null || true)"
  etime="$(ps -p "$1" -o etime= 2>/dev/null | tr -d ' ' || true)"
  echo "${comm##*/}, running for ${etime:-an unknown time}"
}

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

pid_pgid() { ps -p "$1" -o pgid= 2>/dev/null | tr -d ' ' || true; }

wait_pid_gone() {
  local pid=$1 secs=$2
  for _ in $(seq 1 "$secs"); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 1
  done
  ! kill -0 "$pid" 2>/dev/null
}

wait_port_free() {
  local port=$1 secs=$2
  for _ in $(seq 1 "$secs"); do
    port_in_use "$port" || return 0
    sleep 1
  done
  ! port_in_use "$port"
}

# --- ownership ---------------------------------------------------------------

# Succeeds, printing WHY, only when PID is provably a backend this workflow
# started and then leaked. Deliberately never considers the program name: the
# operator's own `bun run dev:server` is a bun too, and killing it would
# destroy their work. Prints a reason, never a path or an argv.
reclaim_proof() {
  local pid=$1 argv cwd root
  argv="$(pid_argv "$pid")"
  case "$argv" in
    # Our own argv marker — definitive, and the normal case.
    *"$MARKER"*) echo "it carries this script's argv marker"; return 0 ;;
    # Our PostgreSQL, named by the data directory this job would use.
    *"-D $PGDATA"*) echo "it is a PostgreSQL serving this job's own data directory"; return 0 ;;
  esac
  # Anything running out of the runner's own work tree: a backend leaked by a
  # job that predates the marker, or a helper it spawned. A developer's
  # checkout is never under the runner work tree, which is what makes this
  # safe on a shared host.
  cwd="$(pid_cwd "$pid")"
  [[ -n "$cwd" ]] || return 1
  for root in "${RUNNER_WORKSPACE:-}" "${RUNNER_TEMP:-}"; do
    [[ -n "$root" ]] || continue
    if [[ "$cwd" == "$root"/* || "$cwd" == "$root" ]]; then
      echo "it is running out of the runner's own work tree"
      return 0
    fi
  done
  return 1
}

# --- reclaim -----------------------------------------------------------------

reclaim_port() {
  local port=$1 label=$2 pids pid proof protected
  for protected in $PROTECTED_PORTS; do
    [[ "$port" == "$protected" ]] && die "refusing to reclaim port $port: it is the conventional default for a developer's own server, and this host is shared"
  done

  pids="$(port_listener_pids "$port")"
  [[ -n "$pids" ]] || return 0

  for pid in $pids; do
    if ! proof="$(reclaim_proof "$pid")"; then
      die "$label port $port is held by a process this workflow did not start, and will NOT be killed.
  holder: pid $pid ($(pid_description "$pid"))
  No test has run yet, so this is a port conflict at job startup and NOT a test
  failure. Do not look at the suite.
  If it is a backend leaked by an earlier cancelled job on ${RUNNER_NAME:-this runner},
  it predates the argv marker this script stamps — stop that pid by hand, once.
  Otherwise this runner's allocated port has collided with an unrelated server:
  see 'Allocate this runner's backend ports' in .github/workflows/ios-e2e.yml."
    fi
    # The SPECIFIC pid, never its process group. A process leaked by an earlier
    # job may still sit in the runner agent's own process group, and
    # `kill -<sig> -<pgid>` against that takes the whole runner offline — a
    # host lost an hour of capacity to exactly that mistake. A group kill is
    # correct only in stop_server, which first proves the group is one we
    # created.
    log "reclaiming leaked $label backend on port $port: pid $pid ($(pid_description "$pid")) — $proof"
    kill -TERM "$pid" 2>/dev/null || true
    if ! wait_pid_gone "$pid" 15; then
      warn "pid $pid ignored SIGTERM after 15s — escalating to SIGKILL on that pid only"
      kill -KILL "$pid" 2>/dev/null || true
      wait_pid_gone "$pid" 10 || die "pid $pid survived SIGKILL — port $port cannot be reclaimed"
    fi
    # GitHub surfaces this in the run's annotations, so a leak stays visible
    # even though it no longer fails anything. A silent self-heal would hide
    # how often cancellation leaks.
    echo "::warning::reclaimed a leaked $label backend (pid $pid) holding port $port on ${RUNNER_NAME:-this runner} — left behind by an earlier cancelled or killed job (#1639)"
  done

  # The port, not the pid, is what the next step needs.
  wait_port_free "$port" 15 \
    || die "killed the process(es) holding $label port $port but the port is still listening 15s later"
}

cmd_reclaim() {
  [[ "$PORTS_ALLOCATED" == 1 ]] || die "reclaim requires NATIVE_BACKEND_PORT and NATIVE_BACKEND_PGPORT to be set explicitly.
  It will not act on the $PORT/$PGPORT defaults: on a shared host those are a
  developer's own server and their own PostgreSQL."
  log "reclaim: checking http $PORT / pg $PGPORT on ${RUNNER_NAME:-this host}"
  reclaim_port "$PGPORT" postgres
  reclaim_port "$PORT" http
  # A PostgreSQL killed outright leaves its lock file behind, and pg_ctl then
  # refuses to start ("another server might be running"). Only safe once we
  # know nothing is listening on the port, which reclaim_port just proved.
  if [[ -f "$PGDATA/postmaster.pid" ]] && ! port_in_use "$PGPORT"; then
    log "removing stale $PGDATA/postmaster.pid"
    rm -f "$PGDATA/postmaster.pid"
  fi
  log "reclaim: http $PORT and pg $PGPORT are free"
}

# --- watchdog ----------------------------------------------------------------

# PID of the runner's per-job worker process, found by walking up our own
# parent chain. That process exists for exactly as long as the job does and
# exits when the job is cancelled or killed, which is the signal an `always()`
# step cannot give us. Best effort: empty on a hosted runner or a developer's
# Mac, where the TTL is then the only deadline.
find_job_guard_pid() {
  local pid="$PPID" depth=0 argv
  while [[ -n "$pid" && "$pid" -gt 1 && "$depth" -lt 20 ]]; do
    argv="$(pid_argv "$pid")"
    case "$argv" in
      *Runner.Worker*) echo "$pid"; return 0 ;;
    esac
    pid="$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ' || true)"
    depth=$((depth + 1))
  done
  return 1
}

# Launch CMD... as the leader of a brand new session with its output appended
# to LOGFILE, and print its pid. The redirect belongs to the child and not to
# this function: redirecting our own stdout would send the pid to the log
# instead of to the caller, and would leave the child holding the caller's
# command-substitution pipe open forever.
# macOS ships no setsid(1); perl's POSIX is core on both macOS and Linux.
spawn_session_leader() {
  local logfile=$1 pid
  shift
  perl -e 'use POSIX (); POSIX::setsid(); exec @ARGV or die "exec: $!"' -- "$@" >>"$logfile" 2>&1 &
  pid=$!
  # setsid() happens a moment after fork, so the group id is not ours yet.
  for _ in $(seq 1 20); do
    [[ "$(pid_pgid "$pid")" == "$pid" ]] && break
    sleep 0.1
  done
  echo "$pid"
}

launch_watchdog() {
  local server_pid=$1 guard pid
  guard="${NATIVE_BACKEND_GUARD_PID:-$(find_job_guard_pid || true)}"
  if [[ -z "$guard" ]]; then
    log "watchdog: no runner job process found — falling back to the ${TTL}s deadline alone"
  fi
  pid="$(
    NATIVE_BACKEND_PORT="$PORT" \
    NATIVE_BACKEND_PGPORT="$PGPORT" \
    NATIVE_BACKEND_DIR="$STATE_DIR" \
    NATIVE_BACKEND_TTL_SECONDS="$TTL" \
    NATIVE_BACKEND_WATCHDOG_SERVER_PID="$server_pid" \
    NATIVE_BACKEND_WATCHDOG_GUARD_PID="$guard" \
      spawn_session_leader "$WATCHDOG_LOG" bash "$SELF" _watchdog
  )"
  echo "$pid" >"$WATCHDOG_PID"
  log "watchdog started (pid $pid, job process ${guard:-none}, ttl ${TTL}s, log: $WATCHDOG_LOG)"
}

cmd_watchdog() {
  local server_pid="${NATIVE_BACKEND_WATCHDOG_SERVER_PID:?}"
  local guard="${NATIVE_BACKEND_WATCHDOG_GUARD_PID:-}"
  local deadline=$((SECONDS + TTL)) reason=""
  log "watchdog up: server pid $server_pid, job process ${guard:-none}, ttl ${TTL}s"
  while :; do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      log "watchdog: server pid $server_pid is already gone — nothing to reclaim"
      exit 0
    fi
    if [[ -n "$guard" ]] && ! kill -0 "$guard" 2>/dev/null; then
      reason="the runner's job process ($guard) exited — the job was cancelled, killed or finished without running its teardown"
      break
    fi
    if (( SECONDS >= deadline )); then
      reason="the ${TTL}s deadline elapsed, which is longer than any legitimate shard"
      break
    fi
    sleep 5
  done
  log "watchdog: tearing the backend down because $reason"
  teardown
}

# --- start / stop ------------------------------------------------------------

cmd_start() {
  [[ "$(uname -s)" == "Darwin" ]] || die "macOS only — on Linux use deploy/docker/docker-compose.dev.yml"
  [[ -f "$CRYPTO_LIB" ]] || die "missing $CRYPTO_LIB — run packages/crypto/scripts/build-server.sh"
  if [[ "$PORTS_ALLOCATED" == 1 ]]; then
    # Idempotent: the job already ran this before installing anything, so
    # normally there is nothing to do. Repeated here so a hand-run `start` on
    # the runner gets the same protection.
    cmd_reclaim
  else
    # Hand-run with the defaults. Reclaim is off by design, so the only safe
    # answer is to refuse: health-checking someone else's server would run the
    # whole suite against the wrong database.
    port_in_use "$PORT" && die "port $PORT is already listening — stop that server or set NATIVE_BACKEND_PORT"
    port_in_use "$PGPORT" && die "port $PGPORT is already listening — stop that server or set NATIVE_BACKEND_PGPORT"
  fi

  mkdir -p "$STATE_DIR"

  if ! brew list --versions "$PG_FORMULA" >/dev/null 2>&1; then
    log "Installing $PG_FORMULA..."
    HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install "$PG_FORMULA"
  fi
  local bin
  bin="$(pg_bin)"

  if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    log "Initialising $PGDATA"
    "$bin/initdb" -D "$PGDATA" -U llamenos --auth=trust --encoding=UTF8 --locale=C >/dev/null
  fi
  log "Starting PostgreSQL on 127.0.0.1:$PGPORT"
  "$bin/pg_ctl" -D "$PGDATA" -l "$STATE_DIR/postgres.log" \
    -o "-p $PGPORT -k $STATE_DIR -c listen_addresses=127.0.0.1 -c max_connections=200" -w start
  if ! "$bin/psql" -h 127.0.0.1 -p "$PGPORT" -U llamenos -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = 'llamenos'" | grep -q 1; then
    "$bin/createdb" -h 127.0.0.1 -p "$PGPORT" -U llamenos llamenos
  fi

  log "Applying migrations"
  (cd "$ROOT" && DATABASE_URL="$DATABASE_URL" bun scripts/run-migrations.ts)

  log "Starting server on 127.0.0.1:$PORT (log: $SERVER_LOG)"
  # Env mirrors the compose `app` service under docker-compose.test.yml.
  local pid
  pid="$(
    cd "$ROOT"
    export PLATFORM=bun
    export PORT
    export DATABASE_URL
    export PG_POOL_SIZE=10
    export ADMIN_PUBKEY
    # X25519 HPKE recipient from the same test seed. The server refuses to boot
    # with ADMIN_PUBKEY set and this missing (#1283).
    export ADMIN_DECRYPTION_PUBKEY="${ADMIN_DECRYPTION_PUBKEY:-27f9c3be4b64aa793509386bc20da41a1ce70df8f360d574f20035a17726a177}"
    export HOTLINE_NAME="Llámenos"
    export ENVIRONMENT=development
    export DEV_ROUTES_ENABLED=true
    export DEV_RESET_SECRET=test-reset-secret
    export TOKEN_MAX_AGE_MS=3600000
    export TRUST_PROXY_HEADERS=true
    HMAC_SECRET="$(openssl rand -hex 32)"
    export HMAC_SECRET
    export SERVER_SECRET=0000000000000000000000000000000000000000000000000000000000000001
    export LLAMENOS_CRYPTO_LIB="$CRYPTO_LIB"
    export STORAGE_ENDPOINT=http://127.0.0.1:9
    export STORAGE_ACCESS_KEY=ios-e2e-no-storage
    export STORAGE_SECRET_KEY=ios-e2e-no-storage
    export STORAGE_BUCKET=llamenos-files
    # Its own session, for two reasons: `stop` can then signal the whole tree
    # (`kill $!` alone can hit a version-manager shim and leave the real server
    # running), and the recorded pid is also the process-group id, which
    # stop_server asserts before it signals any group.
    #
    # The trailing argument is the ownership MARKER the next job's reclaim
    # looks for. The server ignores argv.
    spawn_session_leader "$SERVER_LOG" bun src/server/index.ts "--${MARKER}-port=$PORT"
  )"
  echo "$pid" >"$SERVER_PID"

  local pgid
  pgid="$(pid_pgid "$pid")"
  [[ "$pgid" == "$pid" ]] || die "server pid $pid did not become its own process-group leader (pgid '${pgid:-gone}').
  Refusing to continue: the teardown's group kill is only safe while that holds,
  and a group kill aimed at the wrong group takes the whole runner offline."

  launch_watchdog "$pid"

  for _ in $(seq 1 90); do
    if curl -sf "http://127.0.0.1:$PORT/api/health/live" >/dev/null 2>&1; then
      log "Server is live (pid $pid, process group $pgid)"
      # The first dev-route request on a fresh database seeds default roles and
      # settings; on a CI runner that took 49s, past BaseUITest's 15s hub-creation
      # timeout, so whichever test class ran first had no hub. Pay it here.
      local started=$SECONDS
      curl -sf --max-time 300 -X POST "http://127.0.0.1:$PORT/api/test-create-hub" \
        -H "Content-Type: application/json" -H "X-Test-Secret: test-reset-secret" \
        -d '{"name":"native-backend-warmup"}' >/dev/null \
        || { cat "$SERVER_LOG" >&2; die "warm-up hub creation failed"; }
      log "Warm-up hub created in $((SECONDS - started))s"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$SERVER_LOG" >&2 || true
      die "server exited during startup"
    fi
    sleep 1
  done
  cat "$SERVER_LOG" >&2 || true
  die "server did not answer /api/health/live within 90s"
}

stop_server() {
  [[ -f "$SERVER_PID" ]] || return 0
  local pid pgid
  pid="$(cat "$SERVER_PID" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    pgid="$(pid_pgid "$pid")"
    if [[ "$pgid" == "$pid" ]]; then
      # Safe BECAUSE of that equality: a process group whose id is this very
      # pid is the session `start` created, and contains nothing but the server
      # and whatever it spawned. Never signal a group this script did not
      # create — on a persistent runner the Actions agent is itself a
      # process-group leader, and a `kill -<sig> -<pgid>` aimed there takes the
      # runner offline for as long as nobody notices.
      log "Stopping server process group $pgid"
      kill -TERM "-$pgid" 2>/dev/null || true
      if ! wait_pid_gone "$pid" 10; then
        kill -KILL "-$pgid" 2>/dev/null || true
      fi
    else
      warn "server pid $pid is not its own group leader (pgid '${pgid:-gone}') — signalling that pid alone"
      kill -TERM "$pid" 2>/dev/null || true
      wait_pid_gone "$pid" 10 || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  rm -f "$SERVER_PID"
}

stop_postgres() {
  if [[ -f "$PGDATA/postmaster.pid" ]]; then
    log "Stopping PostgreSQL"
    "$(pg_bin)/pg_ctl" -D "$PGDATA" -m fast -w stop || true
  fi
}

# Everything except the watchdog, so the watchdog can call it without killing
# itself mid-teardown.
teardown() {
  stop_server
  stop_postgres
}

cmd_stop() {
  if [[ -f "$WATCHDOG_PID" ]]; then
    local wpid
    wpid="$(cat "$WATCHDOG_PID" 2>/dev/null || true)"
    # That pid and nothing else: the watchdog has no children but a sleep, and
    # a group kill here would be a group this invocation did not create.
    if [[ -n "$wpid" ]] && kill -0 "$wpid" 2>/dev/null; then
      log "Stopping watchdog (pid $wpid)"
      kill -TERM "$wpid" 2>/dev/null || true
      wait_pid_gone "$wpid" 5 || kill -KILL "$wpid" 2>/dev/null || true
    fi
    rm -f "$WATCHDOG_PID"
  fi
  teardown
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  reclaim) cmd_reclaim ;;
  _watchdog) cmd_watchdog ;;
  *) die "usage: $0 start|stop|reclaim" ;;
esac
