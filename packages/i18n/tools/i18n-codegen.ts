#!/usr/bin/env bun
/**
 * i18n codegen tool.
 *
 * Generates iOS .strings and Android strings.xml from the JSON locale files.
 * Also validates translation coverage across all locales.
 *
 * Usage:
 *   bun run i18n:codegen              # Generate iOS + Android strings
 *   bun run i18n:validate             # Check coverage only (no file output)
 *   bun run i18n:validate --verbose   # Show missing keys
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const LOCALES_DIR = resolve(__dirname, '../locales')
const GENERATED_DIR = resolve(__dirname, '../generated')

// Direct output paths for mobile apps (no manual copy needed)
const IOS_RESOURCES_DIR = resolve(__dirname, '../../../apps/ios/Resources/Localizable')
const ANDROID_RESOURCES_DIR = resolve(__dirname, '../../../apps/android/app/src/main/res')
const ANDROID_I18N_DIR = resolve(__dirname, '../../../apps/android/app/src/main/java/org/llamenos/i18n')

// Locale code mapping for platform-specific formats
const IOS_LOCALE_MAP: Record<string, string> = {
  zh: 'zh-Hans',
  pt: 'pt-BR',
}

const ANDROID_LOCALE_MAP: Record<string, string> = {
  zh: 'zh-rCN',
  pt: 'pt-rBR',
}

// Convert camelCase to snake_case (e.g. callHistory → call_history)
function camelToSnake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

// Flatten nested JSON to snake_case underscore-separated keys (for mobile platforms)
function flattenKeysSnake(obj: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = camelToSnake(key).replace(/-/g, '_')
    const fullKey = prefix ? `${prefix}_${snakeKey}` : snakeKey
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      Object.assign(result, flattenKeysSnake(value as Record<string, unknown>, fullKey))
    } else if (typeof value === 'string') {
      result[fullKey] = value
    }
  }
  return result
}

// Matches a printf-style conversion specifier (%d, %@, %s, %1$@, %.2f, %%-excluded).
// Locale source strings must never contain one: every substitution goes through
// {{placeholder}} so that each platform's codegen picks a specifier that matches
// the argument type it will actually be handed. See issue #1413.
const RAW_FORMAT_SPECIFIER =
  /%(?:\d+\$)?[-+ #0]*[\d.*]*(?:hh|h|ll|l|L|z|j|t|q)?[diouxXeEfgGaAcsp@]/

// Convert i18next interpolation to iOS format and escape special characters.
//
// Every {{placeholder}} becomes a *positional object* specifier (`%1$@`, `%2$@`, ...).
//
//   - Object (`%@`), never numeric (`%ld`/`%f`): `String(format:)` reads a `%@`
//     argument as an object pointer, so the Swift side must always hand it a real
//     object. `L10n.format` (apps/ios/Sources/Utilities/LocalizedFormat.swift)
//     enforces that by stringifying every argument. The inverse — guessing `%ld`
//     from a placeholder *name* like {{count}} — is worse than the crash it
//     replaces: `String(format: "%ld", "lots")` prints a garbage integer silently.
//   - Positional, never bare: translators reorder clauses, and a bare `%@`
//     followed by `%2$@` mixes the two addressing modes in one string.
function toIOSString(value: string): string {
  let index = 0
  return value
    .replace(/\\/g, '\\\\')     // escape backslashes first
    .replace(/"/g, '\\"')       // escape double quotes
    .replace(/\n/g, '\\n')      // escape newlines
    .replace(/\{\{(\w+)\}\}/g, () => {
      index++
      return `%${index}$@`
    })
}

// Fail codegen if any locale string carries a hand-written printf specifier.
//
// A raw specifier is correct for at most one platform: `%@` crashes Android's
// String.format, `%s` crashes iOS's, `%d` renders literally on desktop's i18next,
// and none of them survive translation reordering.
function assertNoRawFormatSpecifiers(locale: string, keys: Record<string, string>): string[] {
  const offenders: string[] = []
  for (const [key, value] of Object.entries(keys)) {
    // %% is a literal percent and is not a substitution.
    const stripped = value.replace(/%%/g, '')
    const match = stripped.match(RAW_FORMAT_SPECIFIER)
    if (match) offenders.push(`${locale}: ${key} contains "${match[0]}" -- use {{placeholder}} instead (${JSON.stringify(value)})`)
  }
  return offenders
}

// Escape special characters for iOS .strings format
function escapeIOSString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

// Convert i18next interpolation to Android format
function toAndroidString(value: string): string {
  let index = 0
  const interpolated = value.replace(/\{\{(\w+)\}\}/g, () => {
    index++
    return `%${index}$s`
  })
  // Single-pass XML/Android escaping avoids incomplete sanitization
  // (chained .replace() with &→&amp; reintroduces the target character)
  return interpolated.replace(/[&<>"'\\]/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '\\"'
      case "'": return "\\'"
      case '\\': return '\\\\'
      default: return ch
    }
  })
}

// Generate iOS Localizable.strings
function generateIOS(keys: Record<string, string>): string {
  const lines = Object.entries(keys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `"${escapeIOSString(key)}" = "${escapeIOSString(toIOSString(value))}";`)
  return lines.join('\n') + '\n'
}

// Generate Android strings.xml
function generateAndroid(keys: Record<string, string>): string {
  const entries = Object.entries(keys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <string name="${key}">${toAndroidString(value)}</string>`)
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${entries.join('\n')}\n</resources>\n`
}

// Generate Kotlin constants object with all string resource names
function generateKotlinConstants(keys: Record<string, string>): string {
  const entries = Object.entries(keys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const constName = key.replace(/\./g, '_').toUpperCase()
      // Truncate long English values in comments
      // Single-pass escaping for Kotlin string/comment content (backslash must be escaped first)
      const sanitized = value.replace(/[\n\\"]/g, (ch) =>
        ch === '\n' ? '\\n' : ch === '\\' ? '\\\\' : '\\"'
      )
      const comment = sanitized.length > 60 ? sanitized.slice(0, 57) + '...' : sanitized
      return `    const val ${constName} = "${key}"  // "${comment}"`
    })
  return [
    '// Generated by i18n-codegen — DO NOT EDIT',
    'package org.llamenos.i18n',
    '',
    'object I18n {',
    ...entries,
    '}',
    '',
  ].join('\n')
}

// Main codegen
function main() {
  const validate = process.argv.includes('--validate')
  const verbose = process.argv.includes('--verbose')

  // Read English as reference
  const enKeys = flattenKeysSnake(JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf-8')))
  const enKeyCount = Object.keys(enKeys).length

  console.log(`Source: ${enKeyCount} keys in English`)

  const localeFiles = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'))
  let hasErrors = false
  let rawSpecifierErrors = 0

  for (const file of localeFiles) {
    const locale = file.replace('.json', '')
    const data = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf-8'))
    const keys = flattenKeysSnake(data)

    // Guard: no hand-written printf specifiers in locale source (issue #1413).
    // Runs for every locale in both codegen and --validate mode, so neither a
    // new source string nor a translation can reintroduce the shape.
    const rawSpecifiers = assertNoRawFormatSpecifiers(locale, keys)
    if (rawSpecifiers.length > 0) {
      console.error(`  ${locale}: ${rawSpecifiers.length} raw format specifier(s):`)
      rawSpecifiers.forEach(o => console.error(`    - ${o}`))
      rawSpecifierErrors += rawSpecifiers.length
      hasErrors = true
    }

    // Validate coverage
    if (locale !== 'en') {
      const missing = Object.keys(enKeys).filter(k => !(k in keys))
      if (missing.length > 0) {
        console.warn(`  ${locale}: ${missing.length} missing keys`)
        if (verbose) missing.slice(0, 10).forEach(k => console.warn(`    - ${k}`))
        hasErrors = true
      } else {
        console.log(`  ${locale}: ${Object.keys(keys).length} keys (complete)`)
      }
    }

    if (validate) continue

    // Generate iOS
    const iosLocale = IOS_LOCALE_MAP[locale] || locale
    const iosContent = generateIOS(keys)
    // Write to generated dir (for CI validation)
    const iosGenDir = join(GENERATED_DIR, 'ios', `${iosLocale}.lproj`)
    mkdirSync(iosGenDir, { recursive: true })
    writeFileSync(join(iosGenDir, 'Localizable.strings'), iosContent)
    // Write directly to iOS app resources (no manual copy needed)
    const iosAppDir = join(IOS_RESOURCES_DIR, `${iosLocale}.lproj`)
    mkdirSync(iosAppDir, { recursive: true })
    writeFileSync(join(iosAppDir, 'Localizable.strings'), iosContent)

    // Generate Android
    const androidLocale = ANDROID_LOCALE_MAP[locale] || locale
    const androidContent = generateAndroid(keys)
    // Write to generated dir (for CI validation)
    const androidGenDir = join(GENERATED_DIR, 'android', locale === 'en' ? 'values' : `values-${androidLocale}`)
    mkdirSync(androidGenDir, { recursive: true })
    writeFileSync(join(androidGenDir, 'strings.xml'), androidContent)
    // Write directly to Android app resources (no manual copy needed)
    const androidAppDir = join(ANDROID_RESOURCES_DIR, locale === 'en' ? 'values' : `values-${androidLocale}`)
    mkdirSync(androidAppDir, { recursive: true })
    writeFileSync(join(androidAppDir, 'strings.xml'), androidContent)
  }

  if (rawSpecifierErrors > 0) {
    console.error(
      `\n${rawSpecifierErrors} raw printf specifier(s) in packages/i18n/locales. ` +
      `Substitutions must be written as {{placeholder}} so each platform's codegen ` +
      `emits a specifier matching the argument type it is handed (issue #1413).`
    )
    process.exit(1)
  }

  if (validate && hasErrors) {
    process.exit(1)
  }

  if (!validate) {
    // Generate Kotlin constants object
    mkdirSync(ANDROID_I18N_DIR, { recursive: true })
    writeFileSync(join(ANDROID_I18N_DIR, 'I18n.kt'), generateKotlinConstants(enKeys))
    console.log(`Generated strings for ${localeFiles.length} locales (iOS + Android) + Kotlin I18n constants`)
  }
}

main()
