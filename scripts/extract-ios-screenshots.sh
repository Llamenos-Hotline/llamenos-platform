#!/usr/bin/env bash
# extract-ios-screenshots.sh
#
# Extracts XCTest attachment screenshots from the derived data directory produced
# by running ScreenshotAuditTests and copies them into site/public/screenshots/ios/.
#
# Usage:
#   ./scripts/extract-ios-screenshots.sh [DERIVED_DATA_PATH] [OUTPUT_DIR]
#
# Defaults:
#   DERIVED_DATA_PATH = /tmp/llamenos-screenshots
#   OUTPUT_DIR        = site/public/screenshots/ios
#
# Run tests first (pin the simulator by UDID, never by name — #2861; the UDID
# comes from `bash scripts/ios-build.sh status`, or `xcrun simctl list devices`):
#   xcodebuild test \
#     -scheme Llamenos \
#     -destination "platform=iOS Simulator,id=<udid>" \
#     -only-testing:LlamenosUITests/ScreenshotAuditTests \
#     -derivedDataPath /tmp/llamenos-screenshots \
#     2>&1 | xcbeautify
#
# Then extract:
#   ./scripts/extract-ios-screenshots.sh

set -euo pipefail

DERIVED_DATA="${1:-/tmp/llamenos-screenshots}"
OUTPUT_DIR="${2:-site/public/screenshots/ios}"

if [ ! -d "$DERIVED_DATA" ]; then
  echo "ERROR: Derived data directory not found: $DERIVED_DATA"
  echo "  Run xcodebuild test first."
  exit 1
fi

mkdir -p "$OUTPUT_DIR"

# XCTest attachments are stored as .png inside the test result bundle.
# They live at paths like:
#   <derived-data>/Logs/Test/*.xcresult/*/Attachments/*.png
# The attachment filename matches the name set in XCTAttachment.name, prefixed
# with something like "Screenshot-<name>-" by the runner.
COUNT=0
while IFS= read -r -d '' file; do
  filename=$(basename "$file")
  # Strip XCTest runner prefix (e.g. "Screenshot-01a-login-1.png") and keep
  # the meaningful name part. We just copy everything — duplicates from retries
  # get a numeric suffix so they don't overwrite.
  dest="$OUTPUT_DIR/$filename"
  if [ -e "$dest" ]; then
    base="${filename%.*}"
    ext="${filename##*.}"
    dest="$OUTPUT_DIR/${base}-retry.$ext"
  fi
  cp "$file" "$dest"
  COUNT=$((COUNT + 1))
done < <(find "$DERIVED_DATA" -name "*.png" -path "*/Attachments/*" -print0)

echo "Extracted $COUNT screenshot(s) → $OUTPUT_DIR"
ls -1 "$OUTPUT_DIR" | head -40
