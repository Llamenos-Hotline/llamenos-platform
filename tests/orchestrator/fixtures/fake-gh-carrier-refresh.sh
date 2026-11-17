#!/usr/bin/env bash
set -euo pipefail
method=GET; jq_expr=""; path=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    --jq) jq_expr="$2"; shift 2 ;;
    --paginate|--silent) shift ;;
    api) shift ;;
    *) path="$1"; shift ;;
  esac
done
echo "$method $path" >> "$FAKE_GH/calls.log"
emit() { if [ -n "$jq_expr" ]; then jq -r "$jq_expr" "$1"; else cat "$1"; fi; }
case "$method $path" in
  "GET repos/"*"/commits/"*"/check-runs"*)
    if [ -e "$FAKE_GH/fail-checkruns" ]; then echo "gh: HTTP 502 Bad Gateway" >&2; exit 1; fi
    emit "$FAKE_GH/checkruns.json" ;;
  "GET repos/"*"/actions/jobs/"*)
    id="${path##*/}"; emit "$FAKE_GH/job-$id.json" ;;
  "GET repos/"*"/actions/runs/"*)
    id="${path##*/}"; f="$FAKE_GH/run-$id.status"; status=completed
    if [ -e "$f" ]; then
      status="$(head -n 1 "$f")"
      if [ "$(wc -l < "$f")" -gt 1 ]; then tail -n +2 "$f" > "$f.next" && mv "$f.next" "$f"; fi
    fi
    jq --arg s "$status" '.status = $s' "$FAKE_GH/run-$id.json" > "$FAKE_GH/run-$id.now"
    emit "$FAKE_GH/run-$id.now" ;;
  "POST repos/"*"/actions/runs/"*"/rerun")
    id="${path%/rerun}"; id="${id##*/}"; f="$FAKE_GH/rerun-refusals-$id"
    if [ -e "$f" ] && [ "$(cat "$f")" -gt 0 ]; then
      echo $(( $(cat "$f") - 1 )) > "$f"
      echo "gh: This workflow is already running (HTTP 403)" >&2; exit 1
    fi
    echo '{}' ;;
  *) echo "fake gh: unexpected call: $method $path" >&2; exit 1 ;;
esac
