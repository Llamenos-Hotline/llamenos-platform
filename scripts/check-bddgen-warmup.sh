#!/usr/bin/env bash
# check-bddgen-warmup.sh — Fail if any bddgen invocation skips the transform-
# cache warm-up.
#
# Why: bddgen generates every BDD project at once (one in the main thread,
# the rest in worker threads) and Playwright's TS transform cache is written
# non-atomically, so on a cold cache a thread can read a step file another
# thread is still writing — it loads empty (steps come out "missing") or
# truncated (bddgen crashes). Measured on cold caches: 4/22 bare runs failed,
# 0/25 with the warm-up. See the build job's comment in
# .github/workflows/ci.yml for the full writeup.
#
# The fix is always the same one-line, single-`run:`-step form:
#   bunx bddgen export > /dev/null && bunx bddgen
# This script only recognizes that exact form. It has been missed twice
# already (#1211, then desktop-e2e.yml) — this rail exists so a third bare
# call site fails CI instead of flaking in the wild.
#
# Scope: only the surfaces that actually execute bddgen (workflows, scripts,
# lefthook, package.json) — not docs or historical plans, which can describe
# bddgen without invoking it.
#
# Exit code: 0 = pass, 1 = bare invocation found

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FILES=(
  .github/workflows/*.yml
  scripts/*.sh
  lefthook.yml
  package.json
)

VIOLATIONS=()

for pattern in "${FILES[@]}"; do
  for file in $pattern; do
    [ -f "$file" ] || continue
    # Skip this script itself — it necessarily mentions the bare form in comments/patterns.
    [ "$file" = "scripts/check-bddgen-warmup.sh" ] && continue

    while IFS=: read -r lineno content; do
      # A line invoking bddgen without also warming the cache on the same
      # line is a bare call. `bddgen export` (warm-up) and the canonical
      # `bddgen export > /dev/null && bunx bddgen` both contain the
      # substring "bddgen export", so neither trips this check.
      if [[ "$content" == *"bunx bddgen"* ]] && [[ "$content" != *"bddgen export"* ]]; then
        VIOLATIONS+=("$file:$lineno: $content")
      fi
    done < <(grep -n "bunx bddgen" "$file" || true)
  done
done

if [ ${#VIOLATIONS[@]} -gt 0 ]; then
  echo "::error::Bare 'bunx bddgen' invocation(s) found — missing the transform-cache warm-up:"
  for v in "${VIOLATIONS[@]}"; do
    echo "  $v"
  done
  echo ""
  echo "Fix: replace with the canonical warm-up form:"
  echo "  bunx bddgen export > /dev/null && bunx bddgen"
  exit 1
fi

echo "No bare bddgen invocations found."
exit 0
