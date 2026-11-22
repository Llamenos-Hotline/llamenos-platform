#!/usr/bin/env bash
# A `gh` stand-in for the reopen carrier guard. Answers from files in $FAKE_GH:
#   rules.json       — body of GET …/rules/branches/<branch>
#   checkruns.json   — body of GET …/commits/<sha>/check-runs
#   fail-rules / fail-checkruns — present: that read fails
set -euo pipefail
jq_expr=""; path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq_expr="$2"; shift 2 ;;
    --paginate|--silent) shift ;;
    api) shift ;;
    *) path="$1"; shift ;;
  esac
done
echo "GET $path" >> "$FAKE_GH/calls.log"
emit() { if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$1"; else cat "$1"; fi; }
case "$path" in
  repos/*/rules/branches/*)
    if [ -e "$FAKE_GH/fail-rules" ]; then echo "gh: HTTP 502 Bad Gateway" >&2; exit 1; fi
    emit "$FAKE_GH/rules.json" ;;
  repos/*/commits/*/check-runs*)
    if [ -e "$FAKE_GH/fail-checkruns" ]; then echo "gh: HTTP 502 Bad Gateway" >&2; exit 1; fi
    emit "$FAKE_GH/checkruns.json" ;;
  *) echo "fake gh: unexpected call: $path" >&2; exit 1 ;;
esac
