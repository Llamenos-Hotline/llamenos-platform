#!/usr/bin/env bash
# check-i18n-codegen-output.sh — did `bun run i18n:codegen` actually DELIVER?
#
# Every other i18n check (validate-strings.ts, `i18n:validate`) reads
# packages/i18n/locales/*.json and the platform SOURCE files. None reads the
# generated output the apps really load, so a skipped, partial or mis-named
# codegen run passes all of them while shipping an app with missing strings:
#
#   - iOS:     NSLocalizedString returns the KEY when no .lproj has it, so the
#              user sees `dashboard_active_calls`, and nothing fails.
#   - Android: a locale whose values-*/ directory is missing silently falls back
#              to English; only a missing DEFAULT values/strings.xml fails (aapt2).
#
# This guard asserts the delivery contract, independent of the locale-code maps
# inside i18n-codegen.ts (so a wrong map entry cannot hide itself):
#   1. there is exactly one iOS .lproj and one Android values* dir per locale file;
#   2. every one holds a non-empty strings file;
#   3. every locale carries the SAME number of strings as English.
#
# Run AFTER `bun run i18n:codegen`. Exits non-zero with every violation listed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCALES_DIR="$ROOT/packages/i18n/locales"
IOS_DIR="$ROOT/apps/ios/Resources/Localizable"
ANDROID_RES="$ROOT/apps/android/app/src/main/res"

errors=0
fail() { echo "::error::i18n codegen output: $*" >&2; errors=$((errors + 1)); }

locale_count=$(find "$LOCALES_DIR" -maxdepth 1 -name '*.json' | wc -l | tr -d ' ')
if [ "$locale_count" -eq 0 ]; then
  fail "no locale files found in $LOCALES_DIR"
  exit 1
fi

# --- iOS -------------------------------------------------------------------
ios_dirs=$(find "$IOS_DIR" -maxdepth 1 -type d -name '*.lproj' 2>/dev/null | sort || true)
ios_count=$(printf '%s' "$ios_dirs" | grep -c . || true)
if [ "$ios_count" -ne "$locale_count" ]; then
  fail "iOS has $ios_count .lproj director(ies) under apps/ios/Resources/Localizable, expected $locale_count (one per packages/i18n/locales/*.json). Was 'bun run i18n:codegen' skipped?"
fi

en_ios="$IOS_DIR/en.lproj/Localizable.strings"
en_ios_n=0
if [ -f "$en_ios" ]; then
  en_ios_n=$(grep -c '^".*" = ".*";$' "$en_ios" || true)
fi
if [ "$en_ios_n" -eq 0 ]; then
  fail "iOS en.lproj/Localizable.strings is missing or has no strings"
fi
for d in $ios_dirs; do
  f="$d/Localizable.strings"
  name=$(basename "$d")
  # iOS resolves a localization by its BCP-47 id: `pt-BR`, `zh-Hans`. An underscore
  # or other shape never matches a device language -- a silent total miss.
  if ! printf '%s' "$name" | grep -Eq '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*\.lproj$'; then
    fail "iOS directory name '$name' is not a BCP-47 .lproj name"
  fi
  if [ ! -f "$f" ]; then fail "iOS $name has no Localizable.strings"; continue; fi
  n=$(grep -c '^".*" = ".*";$' "$f" || true)
  if [ "$n" -ne "$en_ios_n" ]; then
    fail "iOS $name has $n strings, English has $en_ios_n"
  fi
done

# --- Android ---------------------------------------------------------------
android_files=$(find "$ANDROID_RES" -mindepth 2 -maxdepth 2 -path '*/values*/strings.xml' 2>/dev/null | sort || true)
android_count=$(printf '%s' "$android_files" | grep -c . || true)
if [ "$android_count" -ne "$locale_count" ]; then
  fail "Android has $android_count values*/strings.xml file(s) under app/src/main/res, expected $locale_count (one per packages/i18n/locales/*.json). Was 'bun run i18n:codegen' skipped?"
fi

en_xml="$ANDROID_RES/values/strings.xml"
en_xml_n=0
if [ -f "$en_xml" ]; then
  en_xml_n=$(grep -c '<string name=' "$en_xml" || true)
fi
if [ "$en_xml_n" -eq 0 ]; then
  fail "Android values/strings.xml (the default/English resources) is missing or has no strings"
fi
for f in $android_files; do
  name=$(basename "$(dirname "$f")")
  # Android qualifiers: `values`, `values-fr`, `values-pt-rBR`. `values-pt-BR` or
  # `values-pt_BR` is ignored by aapt2's matcher at runtime -- a silent total miss.
  if ! printf '%s' "$name" | grep -Eq '^values(-[a-z]{2,3}(-r[A-Z]{2})?)?$'; then
    fail "Android directory name '$name' is not a valid values qualifier"
  fi
  n=$(grep -c '<string name=' "$f" || true)
  if [ "$n" -ne "$en_xml_n" ]; then
    fail "Android $name has $n strings, English has $en_xml_n"
  fi
done

if [ "$errors" -gt 0 ]; then
  echo "$errors i18n codegen delivery violation(s). Run 'bun run i18n:codegen' and re-check." >&2
  exit 1
fi
echo "i18n codegen output OK: $locale_count locales -> $ios_count iOS .lproj + $android_count Android values dirs, $en_ios_n iOS / $en_xml_n Android strings each"
