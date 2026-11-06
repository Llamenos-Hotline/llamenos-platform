#!/usr/bin/env bash
set -euo pipefail

# Test reporter library for structured output formatting
# Source this file from test scripts to get reporting functions.
#
# Every step's result is derived from THAT STEP'S OWN OUTPUT (#2494).
# `reporter_run_step "Name" cmd...` writes the command's output to a per-step
# log keyed by the step name (and appends it to the cumulative run log for a
# human to read). `reporter_record_step_results "Name" <kind>` parses only that
# step's log. The cumulative log is never parsed: tailing it once attributed an
# earlier project's "2 failed" to a later project that passed.
#
# A step whose output carries no result summary — no output at all, a crash
# before the runner printed one, a step that never ran — is recorded as an
# ERROR, never as "0 passed, 0 failed". An absent result is not a green one, and
# any ERROR suite turns the run's verdict to FAIL.
#
# Portable to macOS /bin/bash 3.2: no associative arrays, no mapfile, no ${x,,}.

# Colors (disabled if not a terminal or --json mode)
if [[ -t 1 ]] && [[ "${JSON_OUTPUT:-}" != "true" ]]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  DIM='\033[2m'
  RESET='\033[0m'
else
  BOLD='' GREEN='' YELLOW='' RED='' CYAN='' DIM='' RESET=''
fi

# Global state
REPORTER_PLATFORM="${REPORTER_PLATFORM:-unknown}"
REPORTER_START_TIME=""
REPORTER_RUN_DIR=""
REPORTER_LOG_FILE=""
REPORTER_JSON_FILE=""
REPORTER_SUITES=()
# One entry per suite: "ok" (counts are that suite's own, consistent result) or
# "error" (no trustworthy result; the reason is in REPORTER_SUITE_REASONS).
REPORTER_SUITE_STATES=()
# "passed:failed:skipped", or "" when the suite has no counts at all.
REPORTER_SUITE_RESULTS=()
REPORTER_SUITE_REASONS=()
REPORTER_TIMEOUT="${REPORTER_TIMEOUT:-600}"

# Set by every parse_*_results call.
PARSED_PASSED=0
PARSED_FAILED=0
PARSED_SKIPPED=0
PARSED_FOUND=false

# Initialize the reporter for a platform. Each run gets its own directory, so
# two runs started in the same second never share (and append to) one log.
reporter_init() {
  local platform="$1"
  REPORTER_PLATFORM="$platform"
  REPORTER_START_TIME="$(date +%s)"
  local timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  local tmp_root="${TMPDIR:-/tmp}"
  REPORTER_RUN_DIR="$(mktemp -d "${tmp_root%/}/test-${platform}-${timestamp}-XXXXXX")"
  mkdir -p "$REPORTER_RUN_DIR/steps"
  REPORTER_LOG_FILE="$REPORTER_RUN_DIR/all.log"
  REPORTER_JSON_FILE="$REPORTER_RUN_DIR/summary.json"
  : > "$REPORTER_LOG_FILE"
  REPORTER_SUITES=()
  REPORTER_SUITE_STATES=()
  REPORTER_SUITE_RESULTS=()
  REPORTER_SUITE_REASONS=()

  if [[ "${JSON_OUTPUT:-}" != "true" ]]; then
    echo -e "${BOLD}=== Testing: ${CYAN}${platform}${RESET}${BOLD} ===${RESET}"
    echo -e "${DIM}Log: ${REPORTER_LOG_FILE}${RESET}"
    echo ""
  fi
}

_reporter_require_init() {
  if [[ -z "$REPORTER_RUN_DIR" ]] || [[ ! -d "$REPORTER_RUN_DIR/steps" ]]; then
    echo "test-reporter: reporter_init must be called before $1" >&2
    exit 2
  fi
}

# The log file holding ONLY the output of the step with this exact name.
# Usage: reporter_step_log "Step Name"
reporter_step_log() {
  _reporter_require_init reporter_step_log
  local slug
  slug="$(printf '%s' "$1" | LC_ALL=C tr -c 'A-Za-z0-9._-' '_')"
  printf '%s\n' "$REPORTER_RUN_DIR/steps/${slug}.log"
}

# Run a command with tee logging, timeout, and filtered output
# Usage: reporter_run_step "Step Name" command [args...]
# Step names must be unique within a run: the name is what a result is
# attributed by, so a reused name aborts the script rather than mixing outputs.
reporter_run_step() {
  local step_name="$1"
  shift
  _reporter_require_init reporter_run_step
  local step_log
  step_log="$(reporter_step_log "$step_name")"
  if [[ -e "$step_log" ]]; then
    echo "test-reporter: step '${step_name}' already ran in this run (or its name collides with another step's); step names must be unique" >&2
    exit 2
  fi
  : > "$step_log"
  local step_start
  step_start="$(date +%s)"

  if [[ "${JSON_OUTPUT:-}" != "true" ]]; then
    echo -e "${CYAN}--- ${step_name} ---${RESET}"
  fi

  local exit_code=0

  # Set up timeout watcher. The subshell kills its own `sleep` when it is
  # killed: otherwise the orphaned sleep keeps this script's stdout open, and
  # anything reading it through a pipe blocks until the sleep ends — up to 80%
  # of the timeout after the run has already finished.
  local timeout_seconds="${REPORTER_TIMEOUT}"
  local warn_seconds=$(( timeout_seconds * 80 / 100 ))

  (
    sleep_pid=""
    trap 'if [[ -n "$sleep_pid" ]]; then kill "$sleep_pid" 2>/dev/null; fi; exit 0' TERM
    sleep "$warn_seconds" 2>/dev/null &
    sleep_pid=$!
    if wait "$sleep_pid"; then
      echo -e "\n${YELLOW}WARNING: Approaching timeout (${warn_seconds}s / ${timeout_seconds}s)${RESET}" >&2
    fi
  ) &
  local warn_pid=$!

  # Portable timeout: use `timeout` if available, else use background + wait + kill
  local _timeout_cmd=""
  if command -v timeout &>/dev/null; then
    _timeout_cmd="timeout"
  elif command -v gtimeout &>/dev/null; then
    _timeout_cmd="gtimeout"
  fi

  # Run the command, writing its output to this step's own log and appending it
  # to the cumulative run log. `-a` applies to both; the step log is fresh.
  if [[ -n "$_timeout_cmd" ]]; then
    if [[ "${VERBOSE:-}" == "true" ]]; then
      "$_timeout_cmd" "$timeout_seconds" "$@" 2>&1 | tee -a "$REPORTER_LOG_FILE" "$step_log" || exit_code=$?
    else
      "$_timeout_cmd" "$timeout_seconds" "$@" 2>&1 | tee -a "$REPORTER_LOG_FILE" "$step_log" | \
        _filter_output "$REPORTER_PLATFORM" || exit_code=$?
    fi
  else
    # Portable fallback: run in background with manual timeout
    if [[ "${VERBOSE:-}" == "true" ]]; then
      "$@" 2>&1 | tee -a "$REPORTER_LOG_FILE" "$step_log" &
    else
      "$@" 2>&1 | tee -a "$REPORTER_LOG_FILE" "$step_log" | \
        _filter_output "$REPORTER_PLATFORM" &
    fi
    local cmd_pid=$!

    # Wait with timeout
    local elapsed=0
    while kill -0 "$cmd_pid" 2>/dev/null; do
      if [[ "$elapsed" -ge "$timeout_seconds" ]]; then
        kill "$cmd_pid" 2>/dev/null || true
        wait "$cmd_pid" 2>/dev/null || true
        exit_code=124
        break
      fi
      sleep 1
      elapsed=$(( elapsed + 1 ))
    done
    if [[ "$exit_code" -ne 124 ]]; then
      wait "$cmd_pid" 2>/dev/null || exit_code=$?
    fi
  fi

  # Clean up timeout watcher
  kill "$warn_pid" 2>/dev/null || true
  wait "$warn_pid" 2>/dev/null || true

  printf '%s\n' "$exit_code" > "${step_log%.log}.exit"

  local step_end
  step_end="$(date +%s)"
  local step_duration=$(( step_end - step_start ))

  # Handle timeout (exit code 124 from timeout command)
  if [[ "$exit_code" -eq 124 ]]; then
    echo -e "\n${RED}TIMEOUT: ${step_name} exceeded ${timeout_seconds}s${RESET}" >&2
    echo -e "${DIM}Last 50 lines of ${step_name}'s output:${RESET}" >&2
    tail -50 "$step_log" >&2 2>/dev/null || true
    return 1
  fi

  # Check for empty output (common iOS/Android issue)
  if [[ ! -s "$step_log" ]]; then
    echo -e "${YELLOW}WARNING: No output captured for ${step_name}${RESET}" >&2
  fi

  if [[ "$exit_code" -ne 0 ]]; then
    if [[ "${VERBOSE:-}" != "true" ]] && [[ "${JSON_OUTPUT:-}" != "true" ]]; then
      echo -e "\n${RED}FAILED: ${step_name} (exit code: ${exit_code}, ${step_duration}s)${RESET}"
      echo -e "${DIM}Last 30 lines of ${step_name}'s output:${RESET}"
      tail -30 "$step_log" 2>/dev/null || true
    fi
    return "$exit_code"
  fi

  if [[ "${JSON_OUTPUT:-}" != "true" ]]; then
    echo -e "${GREEN}OK${RESET} ${step_name} (${step_duration}s)"
  fi

  return 0
}

# Record a suite result from counts the caller determined itself
# Usage: reporter_record_suite "SuiteName" passed failed skipped
reporter_record_suite() {
  local name="$1"
  local passed="${2:-0}"
  local failed="${3:-0}"
  local skipped="${4:-0}"
  REPORTER_SUITES+=("$name")
  REPORTER_SUITE_STATES+=("ok")
  REPORTER_SUITE_RESULTS+=("${passed}:${failed}:${skipped}")
  REPORTER_SUITE_REASONS+=("")
}

# Record a suite that has no trustworthy result.
# Usage: reporter_record_error "SuiteName" "reason" ["passed:failed:skipped"]
reporter_record_error() {
  REPORTER_SUITES+=("$1")
  REPORTER_SUITE_STATES+=("error")
  REPORTER_SUITE_REASONS+=("$2")
  REPORTER_SUITE_RESULTS+=("${3:-}")
}

# Record a suite from the PARSED_* values the last parse_*_results call set.
# A parse that found no result summary records an ERROR, never zeros.
# Usage: reporter_record_parsed "SuiteName" "<what was parsed, for the reason>"
reporter_record_parsed() {
  if [[ "$PARSED_FOUND" == "true" ]]; then
    reporter_record_suite "$1" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
  else
    reporter_record_error "$1" "no result summary found in ${2:-its output}"
  fi
}

# Record the result of a step run by reporter_run_step, parsed from THAT STEP'S
# OWN log and checked against its exit code.
# Usage: reporter_record_step_results "Step Name" playwright|cargo|xcodebuild
reporter_record_step_results() {
  local name="$1"
  local kind="$2"
  case "$kind" in
    playwright|cargo|xcodebuild) ;;
    *) echo "test-reporter: unknown result kind '${kind}'" >&2; exit 2 ;;
  esac
  local step_log
  step_log="$(reporter_step_log "$name")"
  local exit_file="${step_log%.log}.exit"
  if [[ ! -f "$exit_file" ]]; then
    reporter_record_error "$name" "step never ran, so it has no result"
    return 0
  fi
  local step_exit
  step_exit="$(cat "$exit_file")"

  "parse_${kind}_results" "$step_log"

  if [[ "$PARSED_FOUND" != "true" ]]; then
    local what="its output"
    [[ -s "$step_log" ]] || what="its output (the step printed nothing)"
    reporter_record_error "$name" "no ${kind} result summary in ${what}; exit code ${step_exit}"
  elif [[ "$step_exit" -ne 0 ]] && [[ "$PARSED_FAILED" -eq 0 ]]; then
    reporter_record_error "$name" "exit code ${step_exit}, but its summary reports no failed tests" \
      "${PARSED_PASSED}:${PARSED_FAILED}:${PARSED_SKIPPED}"
  else
    reporter_record_suite "$name" "$PARSED_PASSED" "$PARSED_FAILED" "$PARSED_SKIPPED"
  fi
}

# Print the final summary block.
# Returns 1 when the verdict is FAIL: the caller's overall_result, or any suite
# recorded without a trustworthy result.
reporter_summary() {
  local overall_result="${1:-pass}"
  local end_time
  end_time="$(date +%s)"
  local duration=$(( end_time - REPORTER_START_TIME ))

  local error_count=0
  local i
  for i in "${!REPORTER_SUITES[@]}"; do
    if [[ "${REPORTER_SUITE_STATES[$i]}" == "error" ]]; then
      error_count=$(( error_count + 1 ))
    fi
  done
  if [[ "$error_count" -gt 0 ]]; then
    overall_result="fail"
  fi

  if [[ "${JSON_OUTPUT:-}" == "true" ]]; then
    _print_json_summary "$overall_result" "$duration"
  else
    echo ""
    echo -e "${BOLD}=== Test Results: ${REPORTER_PLATFORM} ===${RESET}"

    for i in "${!REPORTER_SUITES[@]}"; do
      local name="${REPORTER_SUITES[$i]}"
      local result="${REPORTER_SUITE_RESULTS[$i]}"
      local passed="" failed="" skipped=""
      if [[ -n "$result" ]]; then
        IFS=':' read -r passed failed skipped <<< "$result"
      fi

      if [[ "${REPORTER_SUITE_STATES[$i]}" == "error" ]]; then
        local counts=""
        [[ -z "$result" ]] || counts=" (${passed} passed, ${failed} failed, ${skipped} skipped)"
        echo -e "  ${name}: ${RED}ERROR${RESET} — ${REPORTER_SUITE_REASONS[$i]}${counts}"
        continue
      fi

      local status_color="$GREEN"
      if [[ "$failed" -gt 0 ]]; then
        status_color="$RED"
      fi
      echo -e "  ${name}: ${status_color}${passed} passed${RESET}, ${failed} failed, ${skipped} skipped"
    done

    if [[ "${#REPORTER_SUITES[@]}" -eq 0 ]]; then
      echo "  (no suite results recorded)"
    fi
    if [[ "$error_count" -gt 0 ]]; then
      echo -e "  ${RED}${error_count} suite(s) have no trustworthy result — see ERROR above${RESET}"
    fi

    echo -e "  ${DIM}Duration: ${duration}s${RESET}"
    echo -e "  ${DIM}Full log: ${REPORTER_LOG_FILE}${RESET}"
    echo -e "  ${DIM}Per-step logs: ${REPORTER_RUN_DIR}/steps/${RESET}"

    if [[ "$overall_result" == "pass" ]]; then
      echo -e "${BOLD}=== RESULT: ${GREEN}PASS${RESET}${BOLD} ===${RESET}"
    else
      echo -e "${BOLD}=== RESULT: ${RED}FAIL${RESET}${BOLD} ===${RESET}"
    fi
  fi

  [[ "$overall_result" == "pass" ]]
}

# Filter output based on platform
_filter_output() {
  local platform="$1"
  case "$platform" in
    ios)
      grep --line-buffered -E '(Test Case|Test Suite|Executed|error:|warning:|Build Succeeded|Build Failed|FAILED|PASSED|Compiling)' || true
      ;;
    android)
      grep --line-buffered -E '(> Task|BUILD|FAILED|PASSED|tests completed|Test .* FAILED|test.*PASSED|Error|Exception)' || true
      ;;
    desktop)
      grep --line-buffered -E '(PASS|FAIL|ERROR|✓|✗|tests? passed|test results|Running|Timed out)' || true
      ;;
    worker)
      grep --line-buffered -E '(PASS|FAIL|ERROR|✓|✗|Tests|test results|Running)' || true
      ;;
    crypto)
      grep --line-buffered -E '(test .* \.\.\.|test result:|running|FAILED|ok$|error\[)' || true
      ;;
    *)
      cat
      ;;
  esac
}

# Escape a string for a JSON string literal.
_json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

# Print JSON summary (also written to $REPORTER_JSON_FILE)
_print_json_summary() {
  local result="$1"
  local duration="$2"
  local timestamp
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local suites_json="["
  local i
  for i in "${!REPORTER_SUITES[@]}"; do
    local name="${REPORTER_SUITES[$i]}"
    local suite_result="${REPORTER_SUITE_RESULTS[$i]}"
    local passed=null failed=null skipped=null
    if [[ -n "$suite_result" ]]; then
      IFS=':' read -r passed failed skipped <<< "$suite_result"
    fi
    if [[ "$i" -gt 0 ]]; then
      suites_json+=","
    fi
    local reason=null
    [[ -z "${REPORTER_SUITE_REASONS[$i]}" ]] || reason="$(_json_str "${REPORTER_SUITE_REASONS[$i]}")"
    suites_json+="{\"name\":$(_json_str "$name"),\"status\":\"${REPORTER_SUITE_STATES[$i]}\",\"passed\":${passed},\"failed\":${failed},\"skipped\":${skipped},\"reason\":${reason}}"
  done
  suites_json+="]"

  cat > "$REPORTER_JSON_FILE" <<ENDJSON
{
  "platform": $(_json_str "$REPORTER_PLATFORM"),
  "timestamp": "${timestamp}",
  "duration_seconds": ${duration},
  "suites": ${suites_json},
  "result": "${result}",
  "log_file": $(_json_str "$REPORTER_LOG_FILE"),
  "steps_dir": $(_json_str "$REPORTER_RUN_DIR/steps")
}
ENDJSON

  cat "$REPORTER_JSON_FILE"
}

# Strip ANSI colour codes (FORCE_COLOR runs) — BSD and GNU sed alike.
_reporter_strip_ansi() {
  local esc=$'\033'
  sed "s/${esc}\[[0-9;]*[A-Za-z]//g" "$1"
}

# ── Parsers ────────────────────────────────────────────────────────────────
# Each takes ONE step's log and sets PARSED_PASSED / PARSED_FAILED /
# PARSED_SKIPPED, plus PARSED_FOUND=true only when the log carries the runner's
# result summary. A missing or summary-less log leaves PARSED_FOUND=false and
# the counts at 0 — callers must record that as an error, never as a pass
# (reporter_record_step_results and reporter_record_parsed both do).

_reporter_parse_reset() {
  PARSED_PASSED=0
  PARSED_FAILED=0
  PARSED_SKIPPED=0
  PARSED_FOUND=false
}

# cargo test: one "test result:" line per test binary; summed.
parse_cargo_results() {
  local log_file="$1"
  _reporter_parse_reset
  [[ -r "$log_file" ]] || return 0

  local result_line
  while IFS= read -r result_line; do
    PARSED_FOUND=true
    local p f s
    p="$(echo "$result_line" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)"
    f="$(echo "$result_line" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)"
    s="$(echo "$result_line" | grep -oE '[0-9]+ ignored' | grep -oE '[0-9]+' || echo 0)"
    PARSED_PASSED=$(( PARSED_PASSED + p ))
    PARSED_FAILED=$(( PARSED_FAILED + f ))
    PARSED_SKIPPED=$(( PARSED_SKIPPED + s ))
  done < <(_reporter_strip_ansi "$log_file" | grep "test result:" || true)
}

# Playwright list/line reporters end with a summary block of two-space-indented
# count lines (playwright/lib/runner: generateSummaryMessage):
#     2 failed            <- followed by 4-space-indented test titles
#     1 interrupted
#     1 flaky
#     3 skipped
#     1 did not run
#    10 passed (1.2m)
# Only those exact lines are read, so test output that merely mentions
# "N passed" is not mistaken for the summary. flaky counts as passed (Playwright
# itself exits 0 on flaky), interrupted as failed, did-not-run as skipped.
parse_playwright_results() {
  local log_file="$1"
  _reporter_parse_reset
  [[ -r "$log_file" ]] || return 0

  local line n kind
  local re='^  ([0-9]+) (failed|interrupted|flaky|skipped|did not run|passed)( \([^)]*\))?[[:space:]]*$'
  while IFS= read -r line; do
    [[ "$line" =~ $re ]] || continue
    n="${BASH_REMATCH[1]}"
    kind="${BASH_REMATCH[2]}"
    PARSED_FOUND=true
    case "$kind" in
      passed|flaky) PARSED_PASSED=$(( PARSED_PASSED + n )) ;;
      failed|interrupted) PARSED_FAILED=$(( PARSED_FAILED + n )) ;;
      skipped|"did not run") PARSED_SKIPPED=$(( PARSED_SKIPPED + n )) ;;
    esac
  done < <(_reporter_strip_ansi "$log_file")
}

parse_xcodebuild_results() {
  local log_file="$1"
  _reporter_parse_reset
  [[ -r "$log_file" ]] || return 0

  # xcodebuild: "Executed N tests, with M failures" -- sum all lines
  local executed_line
  while IFS= read -r executed_line; do
    PARSED_FOUND=true
    local total failures
    total="$(echo "$executed_line" | grep -oE '[0-9]+ test' | head -1 | grep -oE '[0-9]+' || echo 0)"
    failures="$(echo "$executed_line" | grep -oE '[0-9]+ failure' | head -1 | grep -oE '[0-9]+' || echo 0)"
    PARSED_PASSED=$(( PARSED_PASSED + total - failures ))
    PARSED_FAILED=$(( PARSED_FAILED + failures ))
  done < <(_reporter_strip_ansi "$log_file" | grep "Executed" || true)
}

# If run directly, show help
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "Test Reporter Library"
  echo "Source this file from test scripts:"
  echo '  source "$(dirname "$0")/lib/test-reporter.sh"'
  echo ""
  echo "Functions:"
  echo "  reporter_init <platform>"
  echo "  reporter_run_step <name> <command> [args...]"
  echo "  reporter_record_step_results <name> <playwright|cargo|xcodebuild>"
  echo "  reporter_record_suite <name> <passed> <failed> <skipped>"
  echo "  reporter_record_parsed <name> [description]"
  echo "  reporter_record_error <name> <reason> [passed:failed:skipped]"
  echo "  reporter_summary <pass|fail>   (returns 1 on a FAIL verdict)"
fi
