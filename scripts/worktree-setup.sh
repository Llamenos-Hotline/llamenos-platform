#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()    { echo -e "  ${GREEN}OK${NC}    $1"; }
warn()  { echo -e "  ${YELLOW}WARN${NC}  $1"; }
fail()  { echo -e "  ${RED}FAIL${NC}  $1"; exit 1; }
info()  { echo -e "  ${BLUE}INFO${NC}  $1"; }

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=false
BUILD_IOS=false
BUILD_ANDROID=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    --ios) BUILD_IOS=true ;;
    --android) BUILD_ANDROID=true ;;
  esac
done

if [[ "$BUILD_IOS" == false && "$BUILD_ANDROID" == false ]]; then
  if git -C "$PROJECT_ROOT" rev-parse --git-dir &>/dev/null; then
    branch=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [[ "$branch" == feat/ios* || "$branch" == feat/mobile* || "$branch" == fix/ios* || "$branch" == fix/mobile* ]]; then
      BUILD_IOS=true
      info "Auto-enabled iOS build from branch name: $branch"
    fi
    if [[ "$branch" == feat/android* || "$branch" == feat/mobile* || "$branch" == fix/android* || "$branch" == fix/mobile* ]]; then
      BUILD_ANDROID=true
      info "Auto-enabled Android build from branch name: $branch"
    fi
  fi
fi

check_upstream_sync() {
  info "Checking upstream sync..."

  if ! git -C "$PROJECT_ROOT" rev-parse --git-dir &>/dev/null; then
    warn "Not a git repository — skipping upstream sync check"
    return 0
  fi

  if ! git -C "$PROJECT_ROOT" rev-parse --verify origin/main &>/dev/null; then
    warn "origin/main not found — skipping upstream sync check"
    return 0
  fi

  local local_head
  local remote_head
  local_head=$(git -C "$PROJECT_ROOT" rev-parse HEAD)
  remote_head=$(git -C "$PROJECT_ROOT" rev-parse origin/main)

  if [[ "$local_head" == "$remote_head" ]]; then
    ok "Up to date with origin/main"
    return 0
  fi

  if git -C "$PROJECT_ROOT" merge-base --is-ancestor "$local_head" "$remote_head"; then
    fail "Your branch is behind origin/main. Run 'git pull' first."
  else
    warn "Your branch has diverged from origin/main"
  fi
}

needs_rebuild() {
  local sources="$1"
  local outputs="$2"

  if [[ "$FORCE" == true ]]; then
    return 0
  fi

  if [[ ! -e "$outputs" ]]; then
    return 0
  fi
  
  local newest_source
  local newest_output
  newest_source=$(find $sources -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1)
  newest_output=$(find $outputs -type f -printf '%T@\n' 2>/dev/null | sort -n | tail -1)

  if [[ -z "$newest_source" || -z "$newest_output" ]]; then
    return 0
  fi

  if (( $(echo "$newest_source > $newest_output" | bc -l) )); then
    return 0
  fi

  return 1
}

run_codegen() {
  info "Running protocol codegen..."
  cd "$PROJECT_ROOT"
  bun run codegen
  ok "Protocol codegen complete"
}

run_i18n_codegen() {
  info "Running i18n codegen..."
  cd "$PROJECT_ROOT"
  bun run i18n:codegen
  ok "i18n codegen complete"
}

build_crypto_server() {
  local crypto_dir="$PROJECT_ROOT/packages/crypto"
  local target_dir="$crypto_dir/target"

  if ! needs_rebuild "$crypto_dir/src $crypto_dir/Cargo.toml" "$target_dir"; then
    ok "Server crypto build is up to date — skipping"
    return 0
  fi

  info "Building server crypto..."
  cd "$crypto_dir"
  cargo build --release
  ok "Server crypto built"
}

can_build_ios() {
  [[ "$(uname)" == "Darwin" ]] && \
  command -v xcodebuild &>/dev/null && \
  rustup target list --installed 2>/dev/null | grep -q "aarch64-apple-ios"
}

can_build_android() {
  command -v cargo &>/dev/null && \
  cargo ndk --version &>/dev/null 2>&1 && \
  {
    [[ -n "${ANDROID_NDK_HOME:-}" ]] || {
      local ndk_candidates=(
        "$HOME/Android/Sdk/ndk"
        "$HOME/Library/Android/sdk/ndk"
        "/usr/local/lib/android/sdk/ndk"
        "${ANDROID_HOME:-/nonexistent}/ndk"
        "${ANDROID_SDK_ROOT:-/nonexistent}/ndk"
      )
      for base in "${ndk_candidates[@]}"; do
        if [[ -d "$base" ]]; then
          return 0
        fi
      done
      return 1
    }
  }
}

build_crypto_ios() {
  if [[ "$BUILD_IOS" == false ]]; then
    return 0
  fi

  if ! can_build_ios; then
    warn "iOS toolchain not available — skipping iOS crypto build"
    return 0
  fi

  local crypto_dir="$PROJECT_ROOT/packages/crypto"
  local dist_dir="$crypto_dir/dist/ios"

  if ! needs_rebuild "$crypto_dir/src $crypto_dir/Cargo.toml" "$dist_dir"; then
    ok "iOS crypto build is up to date — skipping"
    return 0
  fi

  info "Building iOS crypto..."
  cd "$crypto_dir"
  bash scripts/build-mobile.sh ios
  ok "iOS crypto built"
}

build_crypto_android() {
  if [[ "$BUILD_ANDROID" == false ]]; then
    return 0
  fi

  if ! can_build_android; then
    warn "Android toolchain not available — skipping Android crypto build"
    return 0
  fi

  local crypto_dir="$PROJECT_ROOT/packages/crypto"
  local dist_dir="$crypto_dir/dist/android"

  if ! needs_rebuild "$crypto_dir/src $crypto_dir/Cargo.toml" "$dist_dir"; then
    ok "Android crypto build is up to date — skipping"
    return 0
  fi

  info "Building Android crypto..."
  cd "$crypto_dir"
  bash scripts/build-mobile.sh android
  ok "Android crypto built"
}

copy_ios_artifacts() {
  if [[ "$BUILD_IOS" == false ]]; then
    return 0
  fi

  if ! can_build_ios; then
    return 0
  fi

  local crypto_dist="$PROJECT_ROOT/packages/crypto/dist/ios"
  local ios_dir="$PROJECT_ROOT/apps/ios"

  if [[ ! -d "$crypto_dist/LlamenosCoreFFI.xcframework" ]]; then
    warn "iOS XCFramework not found in dist — skipping copy"
    return 0
  fi

  info "Copying iOS artifacts..."
  rm -rf "$ios_dir/LlamenosCoreFFI.xcframework"
  cp -R "$crypto_dist/LlamenosCoreFFI.xcframework" "$ios_dir/"
  cp "$crypto_dist/LlamenosCore.swift" "$ios_dir/Sources/Generated/LlamenosCore.swift"
  ok "iOS artifacts copied"
}

copy_android_artifacts() {
  if [[ "$BUILD_ANDROID" == false ]]; then
    return 0
  fi

  if ! can_build_android; then
    return 0
  fi

  local debug_dist="$PROJECT_ROOT/packages/crypto/dist/android/jniLibs-debug"
  local release_dist="$PROJECT_ROOT/packages/crypto/dist/android/jniLibs-release"
  local android_debug_jni="$PROJECT_ROOT/apps/android/app/src/debug/jniLibs"
  local android_release_jni="$PROJECT_ROOT/apps/android/app/src/release/jniLibs"

  local copied=false
  if [[ -d "$debug_dist" ]]; then
    info "Copying Android debug artifacts..."
    mkdir -p "$android_debug_jni"
    cp -R "$debug_dist"/* "$android_debug_jni/"
    copied=true
  fi
  if [[ -d "$release_dist" ]]; then
    info "Copying Android release artifacts..."
    mkdir -p "$android_release_jni"
    cp -R "$release_dist"/* "$android_release_jni/"
    copied=true
  fi

  if [[ "$copied" == true ]]; then
    ok "Android artifacts copied"
  else
    warn "Android JNI libs not found in dist — skipping copy"
  fi
}

# One PostgreSQL database per worktree, on the one dev Postgres (scripts/worktree-db.ts).
# Running setup is how a worktree opts in; the sweep then drops databases whose
# worktree is gone. The database step never fails setup: the server launcher
# (scripts/dev-bun.sh) runs the same ensure and refuses to start without it.
setup_worktree_database() {
  cd "$PROJECT_ROOT"
  if [[ -n "${CI:-}" ]]; then
    info "CI — skipping the per-worktree database (each CI job has its own Postgres)"
    return 0
  fi

  info "Provisioning this worktree's PostgreSQL database..."
  local rc=0
  bun scripts/worktree-db.ts ensure --opt-in || rc=$?
  if [[ $rc -eq 0 ]]; then
    ok "Worktree database ready"
  elif [[ $rc -eq 3 ]]; then
    warn "Dev Postgres not usable (see above) — 'bun run dev:server' retries provisioning at start"
    return 0
  else
    warn "Worktree database NOT ready (see above) — 'bun run dev:server' will refuse to start until it is"
  fi

  info "Sweeping databases of removed worktrees..."
  if bun scripts/worktree-db.ts sweep --drop --quiet; then
    ok "Sweep complete"
  else
    warn "Sweep failed (see above)"
  fi
}

main() {
  echo "Worktree Setup"
  echo "==============="
  echo ""

  check_upstream_sync
  run_codegen
  run_i18n_codegen
  build_crypto_server
  build_crypto_ios
  build_crypto_android
  copy_ios_artifacts
  copy_android_artifacts
  setup_worktree_database

  echo ""
  ok "Workspace setup complete!"
}

main "$@"
