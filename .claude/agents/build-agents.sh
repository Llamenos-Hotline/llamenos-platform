#!/usr/bin/env bash
set -euo pipefail

# Assembles self-contained supervisor agent definitions from:
#   1. Domain-specific fragment  (.claude/agents/fragments/<name>.md)
#   2. Shared worker rules       (.claude/agents/fragments/_worker-rules.md — every lane, one copy)
#   3. Shared supervisor skill   (.claude/agents/shared/SKILL.md)
#   4. Model routing guide       (.claude/agents/shared/model-routing.md)
#   5. Llamenos project rules    (.claude/agents/shared/prompt-rules-llamenos.md)
#   6. Worker prompt template    (.claude/agents/shared/prompt-template.md)
#
# Every input is in this repo — see .claude/agents/shared/README.md. There is
# deliberately no $HOME fallback: the operator's own skill copy carries machine-local
# paths and private tooling notes, so building from it either fails the leak check
# below or publishes them, and a build nobody else can run is a build nobody re-runs
# (#2559: #2557 changed _worker-rules.md and the six outputs silently kept the old rules).
#
# Output: .claude/agents/<name>.md (overwritten each run)
#
# Usage: bash .claude/agents/build-agents.sh          # regenerate in place
#        bash .claude/agents/build-agents.sh --check  # exit 1 if a committed output is stale
#        Run after editing any fragment or shared source file.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FRAGMENTS_DIR="$SCRIPT_DIR/fragments"
SHARED_FRAGMENT="$FRAGMENTS_DIR/_worker-rules.md"
SKILL_DIR="$SCRIPT_DIR/shared"
CHECK_MODE=0
case "${1:-}" in
  "") ;;
  --check) CHECK_MODE=1 ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

# Verify shared worker-rules fragment exists — it is folded into every lane, so a
# missing file must hard-fail the build rather than silently ship lanes without it.
if [[ ! -f "$SHARED_FRAGMENT" ]]; then
  echo "ERROR: Shared worker-rules fragment not found: $SHARED_FRAGMENT" >&2
  exit 1
fi

SUPERVISORS=(
  desktop-supervisor
  ios-supervisor
  android-supervisor
  backend-supervisor
  shared-supervisor
  infra-supervisor
)

# Verify every shared source exists — no fallback to a machine-local copy
for required in SKILL.md model-routing.md prompt-rules-llamenos.md prompt-template.md; do
  if [[ ! -f "$SKILL_DIR/$required" ]]; then
    echo "ERROR: Shared source not found: $SKILL_DIR/$required" >&2
    echo "It must be vendored in-repo — see .claude/agents/shared/README.md" >&2
    exit 1
  fi
done

# Verify fragments directory exists
if [[ ! -d "$FRAGMENTS_DIR" ]]; then
  echo "ERROR: Fragments directory not found: $FRAGMENTS_DIR" >&2
  exit 1
fi

BUILD_DIR="$SCRIPT_DIR"
if [[ "$CHECK_MODE" == "1" ]]; then
  BUILD_DIR="$(mktemp -d)"
  trap 'rm -rf "$BUILD_DIR"' EXIT
fi

built=0
for name in "${SUPERVISORS[@]}"; do
  fragment="$FRAGMENTS_DIR/$name.md"
  output="$BUILD_DIR/$name.md"

  if [[ ! -f "$fragment" ]]; then
    echo "SKIP: No fragment for $name at $fragment" >&2
    continue
  fi

  {
    # 1. Domain-specific fragment (includes YAML frontmatter)
    cat "$fragment"

    echo ""
    # 2. Shared worker rules (identical for every lane — one file, no per-lane copies)
    cat "$SHARED_FRAGMENT"

    echo ""
    echo "---"
    echo ""
    echo "# Supervisor Operating Manual"
    echo ""
    echo "Everything below is your complete operating manual. Do NOT read any other"
    echo "files or invoke any skills before starting work — everything you need is here."
    echo ""

    # 3. Core supervisor skill (strip a leading YAML frontmatter block only — a range
    #    sed over every `---` pair would also delete body text between two rules)
    echo "## Core Dispatch Protocol"
    echo ""
    awk 'NR == 1 && /^---$/ { fm = 1; next } fm && /^---$/ { fm = 0; next } !fm' "$SKILL_DIR/SKILL.md"

    echo ""
    echo "---"
    echo ""

    # 4. Model routing
    echo "## Model Routing Reference"
    echo ""
    cat "$SKILL_DIR/model-routing.md"

    echo ""
    echo "---"
    echo ""

    # 5. Llamenos project rules (for embedding in worker prompts)
    echo "## Llamenos Worker Rules (paste into every worker prompt)"
    echo ""
    cat "$SKILL_DIR/prompt-rules-llamenos.md"

    echo ""
    echo "---"
    echo ""

    # 6. Worker prompt template
    echo "## Worker Prompt Template"
    echo ""
    cat "$SKILL_DIR/prompt-template.md"

  } > "$output"

  # Assembled output is committed to a public repo. Two of its inputs live outside
  # it (~/.claude/skills/...), so a hardcoded operator home/checkout path in one of
  # them would silently re-leak the OS username on the next rebuild. Fail loudly.
  if leak="$(grep -nE '/(home|Users)/[A-Za-z0-9._-]+/|/media/[A-Za-z0-9._-]+/' "$output")"; then
    echo "ERROR: $output contains an operator-specific absolute path:" >&2
    echo "$leak" >&2
    echo "Fix it at its source (a fragment, or a file under $SKILL_DIR) — use \$DISPATCH_REPO / \$WORKTREE_BASE / ~." >&2
    exit 1
  fi

  built=$((built + 1))
  if [[ "$CHECK_MODE" != "1" ]]; then
    echo "BUILT: $output"
  fi
done

if [[ "$CHECK_MODE" == "1" ]]; then
  drift=0
  for name in "${SUPERVISORS[@]}"; do
    committed="$SCRIPT_DIR/$name.md"
    generated="$BUILD_DIR/$name.md"
    [[ -f "$generated" ]] || continue
    if [[ ! -f "$committed" ]]; then
      echo "DRIFT DETECTED: $committed does not exist." >&2
      drift=1
    elif ! diff -u "$committed" "$generated" >&2; then
      echo "DRIFT DETECTED: $committed is out of sync with its sources (diff above)." >&2
      drift=1
    fi
  done
  if [[ "$drift" == "1" ]]; then
    echo "Run: bun run agents:build" >&2
    exit 1
  fi
  echo "Check passed: $built agent definitions match their sources."
  exit 0
fi

echo ""
echo "Done. $built agent definitions assembled."
