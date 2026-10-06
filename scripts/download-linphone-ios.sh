#!/usr/bin/env bash
# Download the Linphone iOS SDK release zip pinned in apps/ios/Frameworks/LINPHONE_VERSION.
#
# STATUS (#1188 item 6): the SDK is NOT linked into the iOS app, and this script does
# not link it. No workflow calls it, and apps/ios/project.yml has no Linphone
# dependency, so `#if canImport(linphonesw)` is false in every build.
#
# The 5.3.x zip does not contain a single `linphone-sdk.xcframework`. It ships ~19
# separate xcframeworks (linphone, mediastreamer2, belle-sip, bctoolbox, ortp, …) under
# linphone-sdk/apple-darwin/XCFrameworks/, and the `linphonesw` Swift API as SOURCE
# (linphone-sdk/apple-darwin/share/linphonesw/LinphoneWrapper.swift) that must be built
# into its own `linphonesw` module. Linking therefore needs project.yml changes (a
# linphonesw framework target + every xcframework), the `voip` background mode and
# PushKit/CallKit wiring noted in project.yml, and verification on a real device.
#
# Until that lands this script only fetches and unpacks the release so it can be
# inspected or compiled against. It fails loudly if the layout is not what it expects —
# it never reports an install that did not happen.
set -euo pipefail

VERSION=$(tr -d '[:space:]' < apps/ios/Frameworks/LINPHONE_VERSION)
DEST="apps/ios/Frameworks/linphone-sdk-${VERSION}"
URL="https://download.linphone.org/releases/ios/linphone-sdk-ios-${VERSION}.zip"

if [ -d "$DEST" ]; then
  echo "Linphone SDK ${VERSION} already unpacked at ${DEST}."
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "Downloading Linphone iOS SDK ${VERSION} from ${URL}..."
if ! curl -L --fail --retry 3 -o "$WORK/linphone-ios.zip" "$URL"; then
  echo "ERROR: download failed. Check that ${VERSION} exists at https://download.linphone.org/releases/ios/" >&2
  exit 1
fi
unzip -q "$WORK/linphone-ios.zip" -d "$WORK/unpacked"

SDK_ROOT="$WORK/unpacked/linphone-sdk/apple-darwin"
if [ ! -d "$SDK_ROOT/XCFrameworks/linphone.xcframework" ] \
  || [ ! -f "$SDK_ROOT/share/linphonesw/LinphoneWrapper.swift" ]; then
  echo "ERROR: unexpected SDK layout — linphone.xcframework or LinphoneWrapper.swift missing under ${SDK_ROOT}." >&2
  exit 1
fi

mkdir -p "$DEST"
cp -R "$SDK_ROOT/XCFrameworks" "$DEST/XCFrameworks"
mkdir -p "$DEST/linphonesw"
cp "$SDK_ROOT/share/linphonesw/LinphoneWrapper.swift" "$DEST/linphonesw/"
echo "Linphone SDK ${VERSION} unpacked at ${DEST}. It is NOT linked into the app (see header)."
