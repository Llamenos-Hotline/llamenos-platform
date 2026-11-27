#!/usr/bin/env bash
# Per-runner Rust toolchain for the self-hosted Mac iOS runners (#3115).
#
#   mac-rust-toolchain.sh setup
#   mac-rust-toolchain.sh verify <target>[,<target>...]
#
# WHY. The Mac's PATH (every runner's `.path`) starts with the asdf shims, and
# asdf's rust plugin exports RUSTUP_HOME and CARGO_HOME as the plugin's one
# install directory (~/.asdf/installs/rust/<version>) every time a shim runs.
# So `dtolnay/rust-toolchain` with `targets: aarch64-apple-ios,...` did not
# install into a job-private place: each iOS job ran `rustup target add` against
# the SAME toolchain directory. Two jobs overlapping lose a rename race there
# ("could not rename 'component' file ... rolling back changes"), and the loser
# fails at "Install Rust stable" with nothing wrong in its PR. That ejected a
# fully green PR from the merge queue (#3107, run 46058840510).
#
# FIX. `setup` gives each RUNNER its own rustup home and cargo home, outside the
# asdf tree, and puts that cargo/bin AHEAD of the shims. A runner runs one job at
# a time, so nothing else writes there; two runners write to two directories.
# The first job on a runner bootstraps rustup into it; every later job finds it
# warm and the toolchain step downloads nothing. Env vars alone would not do:
# the asdf shim overwrites RUSTUP_HOME/CARGO_HOME on every call, so the isolated
# `rustup` has to be found on PATH before the shim is.
#
# `verify` runs after the toolchain step and FAILS LOUDLY when the isolation did
# not hold (rustup home is not this runner's, rustc is a shim) or a requested
# target is missing, instead of letting a later step discover it as a linker
# error. It is the check the issue asks for beside any pre-installed targets.
#
# There is deliberately no retry anywhere here: a retry that only succeeds
# because it ran alone would hide the race this exists to remove.
set -euo pipefail

root="${MAC_RUST_ROOT:-$HOME/.ci-rust}"

fail() {
  echo "::error title=mac-rust-toolchain::$*" >&2
  exit 1
}

runner_dir() {
  [ -n "${RUNNER_NAME:-}" ] || fail "RUNNER_NAME is empty: cannot name this runner's own toolchain directory"
  # The runner name is operator-chosen; keep it to one safe path component.
  local safe="${RUNNER_NAME//[^A-Za-z0-9._-]/_}"
  case "$safe" in '' | . | ..) fail "RUNNER_NAME '$RUNNER_NAME' does not make a usable directory name" ;; esac
  printf '%s/%s' "$root" "$safe"
}

cmd_setup() {
  local dir rustup_home cargo_home
  dir="$(runner_dir)"
  rustup_home="$dir/rustup"
  cargo_home="$dir/cargo"
  mkdir -p "$rustup_home" "$cargo_home/bin"

  export RUSTUP_HOME="$rustup_home" CARGO_HOME="$cargo_home"
  # Absolute path: never the asdf shim, which would redirect both homes.
  if [ ! -x "$cargo_home/bin/rustup" ]; then
    echo "First job on runner '$RUNNER_NAME': bootstrapping rustup into $dir"
    # No toolchain yet: the next step installs the one it asks for. The path
    # check is skipped because the shims put a `rustc` on PATH on purpose.
    RUSTUP_INIT_SKIP_PATH_CHECK=yes \
      sh -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain none"
    [ -x "$cargo_home/bin/rustup" ] || fail "rustup bootstrap finished but $cargo_home/bin/rustup is not there"
  fi

  if [ -n "${GITHUB_ENV:-}" ]; then
    {
      echo "RUSTUP_HOME=$rustup_home"
      echo "CARGO_HOME=$cargo_home"
    } >>"$GITHUB_ENV"
  fi
  # GITHUB_PATH PREPENDS for later steps, which is what puts this ahead of the
  # asdf shims.
  if [ -n "${GITHUB_PATH:-}" ]; then
    echo "$cargo_home/bin" >>"$GITHUB_PATH"
  fi
  echo "rustup home:  $rustup_home"
  echo "cargo home:   $cargo_home"
}

cmd_verify() {
  local want="${1:-}" dir rustup_home cargo_home actual rustc_path installed target
  [ -n "$want" ] || fail "verify needs a comma-separated list of targets"
  dir="$(runner_dir)"
  rustup_home="$dir/rustup"
  cargo_home="$dir/cargo"

  actual="$(rustup show home 2>/dev/null || true)"
  [ "$actual" = "$rustup_home" ] ||
    fail "rustup home is '${actual:-unknown}', not this runner's '$rustup_home': the job is still sharing a toolchain with other runners (#3115)"

  rustc_path="$(command -v rustc || true)"
  case "$rustc_path" in
    "$cargo_home"/bin/*) ;;
    *) fail "rustc resolves to '${rustc_path:-nothing}', not under '$cargo_home/bin': a shim or a shared install is ahead of this runner's toolchain" ;;
  esac

  installed="$(rustup target list --installed)"
  IFS=',' read -r -a targets <<<"$want"
  for target in "${targets[@]}"; do
    grep -qx "$target" <<<"$installed" ||
      fail "target '$target' is not installed in $rustup_home (installed: $(tr '\n' ' ' <<<"$installed"))"
  done
  echo "toolchain ok: $(rustc --version) | targets: $want | home: $rustup_home"
}

case "${1:-}" in
  setup) cmd_setup ;;
  verify) shift && cmd_verify "$@" ;;
  *) echo "usage: $0 setup | verify <target>[,<target>...]" >&2; exit 2 ;;
esac
