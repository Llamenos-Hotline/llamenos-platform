#!/usr/bin/env bash
#
# Parallel Android E2E test runner.
#
# Splits Cucumber BDD feature files across multiple emulators (+ any connected
# physical device), each backed by its own isolated Docker Compose backend.
#
# Usage:
#   scripts/android-parallel-e2e.sh          # 4 emulator shards (default)
#   scripts/android-parallel-e2e.sh 2        # 2 emulator shards
#   scripts/android-parallel-e2e.sh --emulators-only   # Start emulators, no tests
#   scripts/android-parallel-e2e.sh --stop              # Kill emulators + Docker stacks
#
# Requirements:
#   - Android SDK with emulator + system images (run scripts/setup-android-sdk.sh)
#   - AVDs created: test-emu-0..N (created by setup-android-sdk.sh)
#   - Docker Compose (for backend stacks)
#   - KVM for hardware acceleration (recommended)
#
set -euo pipefail

# ── Configuration ────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$PROJECT_ROOT/apps/android"
DOCKER_DIR="$PROJECT_ROOT/deploy/docker"
FEATURE_DIR="$PROJECT_ROOT/packages/test-specs/features"

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
# Auto-detect Java on Mac
if [[ -d "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home" ]]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
fi
export PATH="${JAVA_HOME:-}/bin:/usr/bin:/bin:/usr/sbin:/sbin:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:/opt/homebrew/bin:$PATH"

NUM_EMU_SHARDS=3         # Default; 3 emulators for 16GB RAM (2GB each + headroom)
BASE_EMU_PORT=5554       # Emulator ports: 5554, 5556, 5558, ...
BASE_APP_PORT=3001       # Docker backend ports: 3001, 3002, 3003, ...
DOCKER_PROJECT_PREFIX="llamenos-test"
TEST_ADMIN_PUBKEY="79215a4c04f08fcd817c6f820c87169beb8cddf96dfa590a1315556b78af9183"
# The X25519 HPKE recipient derived from the same seed. Required whenever
# ADMIN_PUBKEY is set (#1283) — the two are different keys for different algorithms.
TEST_ADMIN_DECRYPTION_PUBKEY="27f9c3be4b64aa793509386bc20da41a1ce70df8f360d574f20035a17726a177"
AVD_PREFIX="llamenos_e2e"  # AVDs: llamenos_e2e_1, llamenos_e2e_2, llamenos_e2e_3
BOOT_TIMEOUT=300         # Seconds to wait for emulator boot
BACKEND_TIMEOUT=120      # Seconds to wait for Docker backend health

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
shard() { echo -e "${BLUE}[SHARD $1]${NC} ${@:2}"; }

# ── Cleanup ──────────────────────────────────────────────────
cleanup() {
    info "Cleaning up..."
    kill_emulators
    stop_docker_stacks
    info "Cleanup complete"
}

kill_emulators() {
    info "Killing emulators..."
    for i in $(seq 0 $((NUM_EMU_SHARDS - 1))); do
        local serial="emulator-$((BASE_EMU_PORT + i * 2))"
        adb -s "$serial" emu kill 2>/dev/null || true
    done
    # Give emulators a moment to shut down
    sleep 2
    # Force kill any remaining emulator processes
    pkill -f "emulator.*${AVD_PREFIX}" 2>/dev/null || true
}

stop_docker_stacks() {
    info "Stopping Docker Compose test stacks..."
    for i in $(seq 0 $((NUM_EMU_SHARDS + 4))); do  # Extra range for physical device shards
        local project="${DOCKER_PROJECT_PREFIX}-${i}"
        cd "$DOCKER_DIR"
        docker compose -p "$project" -f docker-compose.yml -f docker-compose.test.yml down -v 2>/dev/null || true
    done
    cd "$PROJECT_ROOT"
}

# ── Handle flags ─────────────────────────────────────────────
case "${1:-}" in
    --stop)
        stop_docker_stacks
        kill_emulators
        exit 0
        ;;
    --emulators-only)
        NUM_EMU_SHARDS="${2:-4}"
        # Fall through to start emulators, then exit
        ;;
    [0-9]*)
        NUM_EMU_SHARDS="$1"
        ;;
esac

# ── Detect Physical Devices ─────────────────────────────────
detect_physical_devices() {
    local devices=()
    while IFS= read -r line; do
        local serial
        serial=$(echo "$line" | awk '{print $1}')
        local state
        state=$(echo "$line" | awk '{print $2}')
        # Skip emulators and offline devices
        if [[ "$serial" != emulator-* ]] && [[ "$state" == "device" ]]; then
            devices+=("$serial")
        fi
    done < <(adb devices | tail -n +2 | grep -v "^$")
    echo "${devices[@]}"
}

# ── Start Docker Backend ────────────────────────────────────
start_docker_backend() {
    local shard_idx="$1"
    local port=$((BASE_APP_PORT + shard_idx))
    local project="${DOCKER_PROJECT_PREFIX}-${shard_idx}"

    shard "$shard_idx" "Starting Docker backend on port ${port} (project: ${project})"

    cd "$DOCKER_DIR"

    # Create per-shard .env
    local env_file=".env.shard-${shard_idx}"
    cat > "$env_file" << ENV
ADMIN_PUBKEY=${TEST_ADMIN_PUBKEY}
ADMIN_DECRYPTION_PUBKEY=${TEST_ADMIN_DECRYPTION_PUBKEY}
DOMAIN=localhost
PG_PASSWORD=test-shard-${shard_idx}
HMAC_SECRET=$(openssl rand -hex 32)
STORAGE_ACCESS_KEY=testaccess${shard_idx}
STORAGE_SECRET_KEY=testsecret123456${shard_idx}
HOTLINE_NAME=Llamenos-Shard-${shard_idx}
BRIDGE_SECRET=test-bridge-${shard_idx}
ARI_PASSWORD=test-ari-${shard_idx}
SERVER_SECRET=$(openssl rand -hex 32)
APP_PORT=${port}
ENV

    APP_PORT="$port" docker compose \
        -p "$project" \
        --env-file "$env_file" \
        -f docker-compose.yml \
        -f docker-compose.test.yml \
        up -d --build --wait app 2>&1 | while read -r line; do
            shard "$shard_idx" "$line"
        done

    cd "$PROJECT_ROOT"

    # Wait for health
    local elapsed=0
    while [ $elapsed -lt $BACKEND_TIMEOUT ]; do
        if curl -sf "http://localhost:${port}/api/health" > /dev/null 2>&1; then
            shard "$shard_idx" "Backend healthy on port ${port}"
            return 0
        fi
        sleep 2
        elapsed=$((elapsed + 2))
    done

    error "Backend on port ${port} did not become healthy within ${BACKEND_TIMEOUT}s"
    return 1
}

# ── Start Emulator ──────────────────────────────────────────
start_emulator() {
    local shard_idx="$1"
    local avd_name="${AVD_PREFIX}_$((shard_idx + 1))"
    local port=$((BASE_EMU_PORT + shard_idx * 2))
    local serial="emulator-${port}"

    shard "$shard_idx" "Starting emulator ${avd_name} on port ${port}"

    # Launch emulator in background
    # -read-only allows multiple emulators to share system image
    # -no-snapshot-save prevents snapshot writes (read-only mode)
    "$ANDROID_HOME/emulator/emulator" \
        -avd "$avd_name" \
        -port "$port" \
        -no-window \
        -no-audio \
        -no-boot-anim \
        -no-snapshot-load \
        -no-snapshot-save \
        -read-only \
        -gpu swiftshader_indirect \
        -memory 2048 \
        -camera-back none \
        -camera-front none \
        </dev/null &>/tmp/emulator-${shard_idx}.log &

    # Wait for boot — initial delay to let emulator process start
    sleep 5
    local elapsed=5
    while [ $elapsed -lt $BOOT_TIMEOUT ]; do
        if adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; then
            shard "$shard_idx" "Emulator ${avd_name} booted (${elapsed}s)"

            # Disable animations for deterministic tests
            adb -s "$serial" shell settings put global window_animation_scale 0.0
            adb -s "$serial" shell settings put global transition_animation_scale 0.0
            adb -s "$serial" shell settings put global animator_duration_scale 0.0

            return 0
        fi
        sleep 3
        elapsed=$((elapsed + 3))
    done

    error "Emulator ${avd_name} did not boot within ${BOOT_TIMEOUT}s"
    cat /tmp/emulator-${shard_idx}.log | tail -20
    return 1
}

# ── Install APKs ────────────────────────────────────────────
install_apks() {
    local serial="$1"
    local shard_idx="$2"

    local app_apk="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
    local test_apk="$ANDROID_DIR/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk"

    shard "$shard_idx" "Installing APKs on ${serial}"
    adb -s "$serial" install -r -t "$app_apk" 2>&1 | tail -1
    adb -s "$serial" install -r -t "$test_apk" 2>&1 | tail -1
    shard "$shard_idx" "APKs installed on ${serial}"
}

# ── Collect Feature Files ───────────────────────────────────
collect_android_features() {
    # Find all .feature files that have @android tag
    local features=()
    while IFS= read -r file; do
        if grep -q "@android" "$file"; then
            # Convert to asset-relative path: features/admin/foo.feature
            # Cucumber on Android looks in the assets dir; features are under features/
            local rel="features/${file#$FEATURE_DIR/}"
            features+=("$rel")
        fi
    done < <(find "$FEATURE_DIR" -name "*.feature" -type f | sort)
    echo "${features[@]}"
}

# ── Shard Features ──────────────────────────────────────────
shard_features() {
    local -n _features=$1
    local num_shards=$2
    local shard_idx=$3

    local total=${#_features[@]}
    local result=()

    for ((i = shard_idx; i < total; i += num_shards)); do
        result+=("${_features[$i]}")
    done

    echo "${result[@]}"
}

# ── Run Tests on Device ─────────────────────────────────────
run_tests_on_device() {
    local serial="$1"
    local shard_idx="$2"
    local hub_url="$3"
    local feature_files="$4"  # Space-separated list of feature paths

    if [ -z "$feature_files" ]; then
        shard "$shard_idx" "No features assigned to this shard, skipping"
        return 0
    fi

    # Convert space-separated feature paths to comma-separated for Cucumber
    local cucumber_features
    cucumber_features=$(echo "$feature_files" | tr ' ' ',')

    local result_dir="/tmp/android-e2e-results/shard-${shard_idx}"
    mkdir -p "$result_dir"

    shard "$shard_idx" "Running tests on ${serial} (hub: ${hub_url})"
    shard "$shard_idx" "Features: ${cucumber_features}"

    # Clear app data before test run for clean state
    adb -s "$serial" shell pm clear org.llamenos.hotline.debug 2>/dev/null || true

    # Run Cucumber instrumented tests via am instrument
    # Pass testHubUrl and cucumber.features as instrumentation args
    # testApplicationId is "org.llamenos.hotline" (explicit in build.gradle.kts, no debug suffix)
    # targetPackage is "org.llamenos.hotline.debug" (app applicationId with debug suffix)
    local exit_code=0
    local test_secret="${E2E_TEST_SECRET:-test-reset-secret}"
    adb -s "$serial" shell am instrument -w \
        -e testHubUrl "$hub_url" \
        -e testSecret "$test_secret" \
        -e cucumber.features "$cucumber_features" \
        org.llamenos.hotline/org.llamenos.hotline.CucumberHiltRunner \
        2>&1 | tee "$result_dir/output.txt" || exit_code=$?

    # Pull test results
    adb -s "$serial" pull /storage/emulated/0/Android/data/org.llamenos.hotline/files/ \
        "$result_dir/" 2>/dev/null || true

    # Check for test failures in output (am instrument returns 0 even on test failures)
    local failures=0
    if grep -q "FAILURES!!!" "$result_dir/output.txt" 2>/dev/null; then
        failures=$(grep "Tests run:" "$result_dir/output.txt" | tail -1 | sed 's/.*Failures: \([0-9]*\).*/\1/')
        local total=$(grep "Tests run:" "$result_dir/output.txt" | tail -1 | sed 's/Tests run: \([0-9]*\).*/\1/')
        local passed=$((total - failures))
        error "Shard ${shard_idx} FAILED on ${serial} — ${passed}/${total} passed, ${failures} failures"
        exit_code=1
    elif grep -q "INSTRUMENTATION_CODE: 0" "$result_dir/output.txt" 2>/dev/null && \
         grep -q "Process crashed" "$result_dir/output.txt" 2>/dev/null; then
        error "Shard ${shard_idx} CRASHED on ${serial}"
        exit_code=1
    elif [ $exit_code -ne 0 ]; then
        error "Shard ${shard_idx} FAILED on ${serial} (exit code: ${exit_code})"
    else
        local total=$(grep "Tests run:" "$result_dir/output.txt" | tail -1 | sed 's/Tests run: \([0-9]*\).*/\1/' 2>/dev/null || echo "?")
        shard "$shard_idx" "PASSED on ${serial} — ${total} tests passed"
    fi

    return $exit_code
}

# ── Main ────────────────────────────────────────────────────
main() {
    info "=== Android Parallel E2E Test Runner ==="
    info "Emulator shards: ${NUM_EMU_SHARDS}"
    info "Project root: ${PROJECT_ROOT}"

    # Register cleanup trap
    trap cleanup EXIT

    # Detect physical devices
    read -ra PHYSICAL_DEVICES <<< "$(detect_physical_devices)"
    local num_physical=${#PHYSICAL_DEVICES[@]}
    if [ $num_physical -gt 0 ]; then
        info "Physical devices detected: ${PHYSICAL_DEVICES[*]}"
    else
        info "No physical devices connected"
    fi

    local total_shards=$((NUM_EMU_SHARDS + num_physical))
    info "Total shards: ${total_shards} (${NUM_EMU_SHARDS} emulators + ${num_physical} physical)"

    # ── Step 1: Build APKs ───────────────────────────────────
    info ""
    info "=== Building APKs ==="
    cd "$ANDROID_DIR"
    ./gradlew assembleDebug assembleDebugAndroidTest
    cd "$PROJECT_ROOT"

    # ── Step 2: Start Docker backends (parallel) ─────────────
    info ""
    info "=== Starting Docker backends ==="
    local backend_pids=()
    for i in $(seq 0 $((total_shards - 1))); do
        start_docker_backend "$i" &
        backend_pids+=($!)
    done

    # Wait for all backends
    local backend_failed=false
    for pid in "${backend_pids[@]}"; do
        if ! wait "$pid"; then
            backend_failed=true
        fi
    done

    if [ "$backend_failed" = true ]; then
        error "One or more backends failed to start"
        exit 1
    fi
    info "All ${total_shards} backends healthy"

    # ── Step 3: Start emulators (parallel) ───────────────────
    info ""
    info "=== Starting emulators ==="
    local emu_pids=()
    for i in $(seq 0 $((NUM_EMU_SHARDS - 1))); do
        start_emulator "$i" &
        emu_pids+=($!)
    done

    if [ "${1:-}" = "--emulators-only" ]; then
        # Wait for emulators but don't run tests
        for pid in "${emu_pids[@]}"; do
            wait "$pid" || true
        done
        info "Emulators started. Press Ctrl+C to stop."
        trap - EXIT
        wait
        exit 0
    fi

    # Wait for all emulators
    local emu_failed=false
    for pid in "${emu_pids[@]}"; do
        if ! wait "$pid"; then
            emu_failed=true
        fi
    done

    if [ "$emu_failed" = true ]; then
        error "One or more emulators failed to boot"
        exit 1
    fi
    info "All ${NUM_EMU_SHARDS} emulators booted"

    # ── Step 4: Install APKs on all devices ──────────────────
    info ""
    info "=== Installing APKs ==="

    # Build serial -> shard mapping
    declare -a ALL_SERIALS=()
    declare -a ALL_HUB_URLS=()

    # Emulators
    for i in $(seq 0 $((NUM_EMU_SHARDS - 1))); do
        local port=$((BASE_EMU_PORT + i * 2))
        ALL_SERIALS+=("emulator-${port}")
        # Emulators use 10.0.2.2 (host loopback alias)
        ALL_HUB_URLS+=("http://10.0.2.2:$((BASE_APP_PORT + i))")
    done

    # Physical devices
    for i in $(seq 0 $((num_physical - 1))); do
        local shard_idx=$((NUM_EMU_SHARDS + i))
        ALL_SERIALS+=("${PHYSICAL_DEVICES[$i]}")
        # Physical devices use the host LAN IP
        local host_ip
        host_ip=$(hostname -I | awk '{print $1}')
        ALL_HUB_URLS+=("http://${host_ip}:$((BASE_APP_PORT + shard_idx))")
    done

    # Install APKs in parallel
    local install_pids=()
    for i in $(seq 0 $((total_shards - 1))); do
        install_apks "${ALL_SERIALS[$i]}" "$i" &
        install_pids+=($!)
    done
    for pid in "${install_pids[@]}"; do
        wait "$pid" || true
    done

    # ── Step 5: Collect and shard features ───────────────────
    info ""
    info "=== Sharding features ==="
    read -ra ALL_FEATURES <<< "$(collect_android_features)"
    local num_features=${#ALL_FEATURES[@]}
    info "Total @android features: ${num_features}"
    info "Features per shard: ~$((num_features / total_shards))"

    # ── Step 6: Run tests in parallel ────────────────────────
    info ""
    info "=== Running tests ==="
    rm -rf /tmp/android-e2e-results
    mkdir -p /tmp/android-e2e-results

    local test_pids=()
    local test_exit_files=()

    for i in $(seq 0 $((total_shards - 1))); do
        local shard_features
        shard_features=$(shard_features ALL_FEATURES "$total_shards" "$i")
        local exit_file="/tmp/android-e2e-results/exit-${i}"

        (
            set +e  # Disable errexit so echo runs even when tests fail
            run_tests_on_device "${ALL_SERIALS[$i]}" "$i" "${ALL_HUB_URLS[$i]}" "$shard_features"
            echo $? > "$exit_file"
        ) &
        test_pids+=($!)
        test_exit_files+=("$exit_file")
    done

    # Wait for all test shards
    for pid in "${test_pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done

    # ── Step 7: Report results ───────────────────────────────
    info ""
    info "=== Test Results ==="
    local any_failed=false
    for i in $(seq 0 $((total_shards - 1))); do
        local exit_file="${test_exit_files[$i]}"
        local exit_code=1
        if [ -f "$exit_file" ]; then
            exit_code=$(cat "$exit_file")
        fi

        local device_type="emulator"
        if [ "$i" -ge "$NUM_EMU_SHARDS" ]; then
            device_type="physical"
        fi

        if [ "$exit_code" = "0" ]; then
            shard "$i" "${GREEN}PASSED${NC} (${device_type}: ${ALL_SERIALS[$i]})"
        else
            shard "$i" "${RED}FAILED${NC} (${device_type}: ${ALL_SERIALS[$i]})"
            any_failed=true
        fi
    done

    info ""
    info "Results saved to: /tmp/android-e2e-results/"

    if [ "$any_failed" = true ]; then
        error "Some shards failed!"
        exit 1
    else
        info "All shards passed!"
        exit 0
    fi
}

main "$@"
