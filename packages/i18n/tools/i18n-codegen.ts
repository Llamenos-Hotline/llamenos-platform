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

// Positional specifiers are numbered by placeholder NAME, from the en source.
//
// Call sites pass their arguments in the order the en string first uses each
// placeholder. A translation that reorders clauses -- Korean "{{total}} 중
// {{page}} 페이지" for "Page {{page}} of {{total}}" -- must therefore keep each
// name bound to its en position: {{page}} is %1$ in every locale, wherever it
// sits in the sentence. Numbering by occurrence in the translated string
// instead silently swapped the arguments ("Page 50 of 1"; issue #1899).
//
// A name used twice in one string resolves to the same index both times.
type PlaceholderIndex = ReadonlyMap<string, number>

const PLACEHOLDER = /\{\{(\w+)\}\}/g

/** Placeholder names in first-occurrence order, de-duplicated. */
function placeholderNames(value: string): string[] {
  return [...new Set(Array.from(value.matchAll(PLACEHOLDER), m => m[1]))]
}

/** name -> 1-based argument position, taken from the en source string of a key. */
function placeholderIndex(enSource: string): PlaceholderIndex {
  return new Map(placeholderNames(enSource).map((name, i) => [name, i + 1]))
}

/** Replace each {{name}} with the specifier for its en argument position. */
function substitutePlaceholders(
  value: string,
  index: PlaceholderIndex,
  specifier: (position: number) => string
): string {
  return value.replace(PLACEHOLDER, (_, name: string) => {
    const position = index.get(name)
    // checkPlaceholderNames rejects this before generation; reaching it is a bug.
    if (position === undefined) throw new Error(`placeholder {{${name}}} has no en argument position in ${JSON.stringify(value)}`)
    return specifier(position)
  })
}

// Every locale must use exactly the placeholder names its en source uses.
//
//   - A name en does not have has no argument to bind to: the call site never
//     passes it, so it would read past the end of the argument list.
//   - A name en has but the translation drops leaves a gap in the positional
//     sequence (%1$@ ... %3$@ with no %2$@). NSString cannot infer the type of
//     a skipped argument, so iOS behaviour is undefined, and the value the
//     user needed -- a lockout countdown, a page number -- silently vanishes.
//
// Order is free (that is what name-based numbering is for); repetition is fine.
function checkPlaceholderNames(
  locale: string,
  keys: Record<string, string>,
  enKeys: Record<string, string>
): string[] {
  const offenders: string[] = []
  for (const [key, value] of Object.entries(keys)) {
    const source = enKeys[key]
    if (source === undefined) continue
    const expected = placeholderNames(source)
    const actual = placeholderNames(value)
    const extra = actual.filter(n => !expected.includes(n))
    const missing = expected.filter(n => !actual.includes(n))
    if (extra.length > 0) {
      offenders.push(`${locale}: ${key} uses {{${extra.join('}}, {{')}}} which en does not have -- no argument is passed for it (${JSON.stringify(value)})`)
    }
    if (missing.length > 0) {
      offenders.push(`${locale}: ${key} drops {{${missing.join('}}, {{')}}} that en has -- every placeholder must appear in every locale (${JSON.stringify(value)})`)
    }
  }
  return offenders
}

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
//   - Numbered by name from the en source (see placeholderIndex above).
//
// No escaping here: generateIOS escapes the finished value exactly once with
// escapeIOSString. Escaping in both places rendered a literal backslash on
// iOS for every quote and newline in the catalogue ("What does \\"On Break\\" do?").
function toIOSString(value: string, index: PlaceholderIndex): string {
  return substitutePlaceholders(value, index, position => `%${position}$@`)
}

// Prove the name-based numbering on every run: a reordered translation must keep
// each name on its en position, a repeated name must reuse its index, and both
// guards in checkPlaceholderNames must fire. Returns failure descriptions.
function selfTestPlaceholders(): string[] {
  const failures: string[] = []
  const expect = (name: string, got: unknown, want: unknown) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) failures.push(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
  }
  const en = 'Page {{page}} of {{total}}'
  const index = placeholderIndex(en)
  expect('iOS reordered translation', toIOSString('{{total}} 중 {{page}} 페이지', index), '%2$@ 중 %1$@ 페이지')
  expect('Android reordered translation', toAndroidString('{{total}} 중 {{page}} 페이지', index), '%2$s 중 %1$s 페이지')
  expect('repeated name reuses its index', toIOSString('{{page}}/{{total}} ({{page}})', index), '%1$@/%2$@ (%1$@)')
  const enKeys = { page_info: en }
  expect('extra placeholder is rejected', checkPlaceholderNames('xx', { page_info: '{{page}} {{total}} {{count}}' }, enKeys).length, 1)
  expect('dropped placeholder is rejected', checkPlaceholderNames('xx', { page_info: 'Page {{page}}' }, enKeys).length, 1)
  expect('reordering is accepted', checkPlaceholderNames('xx', { page_info: '{{total}} 중 {{page}}' }, enKeys).length, 0)
  return failures
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
function toAndroidString(value: string, index: PlaceholderIndex): string {
  const interpolated = substitutePlaceholders(value, index, position => `%${position}$s`)
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
function generateIOS(keys: Record<string, string>, enKeys: Record<string, string>): string {
  const lines = Object.entries(keys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) =>
      `"${escapeIOSString(key)}" = "${escapeIOSString(toIOSString(value, placeholderIndex(enKeys[key] ?? value)))}";`
    )
  return lines.join('\n') + '\n'
}

// Generate Android strings.xml
function generateAndroid(keys: Record<string, string>, enKeys: Record<string, string>): string {
  const entries = Object.entries(keys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `    <string name="${key}">${toAndroidString(value, placeholderIndex(enKeys[key] ?? value))}</string>`)
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

  const selfTestFailures = selfTestPlaceholders()
  if (selfTestFailures.length > 0) {
    console.error('Placeholder numbering self-test FAILED:')
    selfTestFailures.forEach(f => console.error(`  - ${f}`))
    process.exit(1)
  }

  const localeFiles = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json'))
  let hasErrors = false
  let rawSpecifierErrors = 0
  let placeholderNameErrors = 0

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

    // Guard: every locale uses exactly en's placeholder names (issue #1899).
    // A locale that fails is not generated -- its specifiers would bind to the
    // wrong arguments or to none.
    const placeholderOffenders = checkPlaceholderNames(locale, keys, enKeys)
    if (placeholderOffenders.length > 0) {
      console.error(`  ${locale}: ${placeholderOffenders.length} placeholder mismatch(es) against en:`)
      placeholderOffenders.forEach(o => console.error(`    - ${o}`))
      placeholderNameErrors += placeholderOffenders.length
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

    if (validate || placeholderOffenders.length > 0) continue

    // Generate iOS
    const iosLocale = IOS_LOCALE_MAP[locale] || locale
    const iosContent = generateIOS(keys, enKeys)
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
    const androidContent = generateAndroid(keys, enKeys)
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

  if (placeholderNameErrors > 0) {
    console.error(
      `\n${placeholderNameErrors} placeholder mismatch(es) against en. Each translation must use ` +
      `exactly the {{placeholder}} names of its en source -- in any order -- because the ` +
      `positional specifiers are numbered from en (issue #1899).`
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
